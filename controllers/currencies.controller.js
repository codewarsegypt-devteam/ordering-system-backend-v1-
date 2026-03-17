/**
 * Admin currency management.
 *
 * Endpoints:
 *   GET    /currencies                          — list all global currencies
 *   GET    /currencies/merchant                 — get merchant currency config
 *   PATCH  /currencies/merchant/base            — set merchant base currency
 *   POST   /currencies/merchant/display         — add a display currency
 *   PATCH  /currencies/merchant/display/:mcId   — update a display currency entry
 *   DELETE /currencies/merchant/display/:mcId   — remove a display currency entry
 */

import { supabaseAdmin } from "../db_connection.js";

// ─────────────────────────────────────────────────────────────────────────────
// Global currencies
// ─────────────────────────────────────────────────────────────────────────────

/** List all currencies in the system (active + inactive). Admin use. */
export async function listGlobalCurrencies(req, res) {
  const { data, error } = await supabaseAdmin
    .from("currencies")
    .select("id, code, name, symbol, is_active")
    .order("code");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
}

// ─────────────────────────────────────────────────────────────────────────────
// Merchant currency configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /currencies/merchant
 * Returns the merchant's full currency setup:
 *  - base_currency
 *  - display_currencies (with rates, default flag)
 */
export async function getMerchantCurrencySetup(req, res) {
  const merchantId = req.user.merchant_id;

  const [merchantRes, displayRes] = await Promise.all([
    supabaseAdmin
      .from("merchant")
      .select("id, base_currency_id")
      .eq("id", merchantId)
      .single(),
    supabaseAdmin
      .from("merchant_currencies")
      .select("id, currency_id, rate_from_base, is_active, is_default_display, created_at")
      .eq("merchant_id", merchantId)
      .order("created_at"),
  ]);

  if (merchantRes.error) return res.status(500).json({ error: merchantRes.error.message });

  const baseCurrencyId = merchantRes.data?.base_currency_id ?? null;
  const displayRows = displayRes.data || [];

  // Bulk-fetch all referenced currency details in one query
  const allCurrencyIds = [
    ...(baseCurrencyId ? [baseCurrencyId] : []),
    ...displayRows.map((r) => r.currency_id),
  ];

  let currencyMap = {};
  if (allCurrencyIds.length) {
    const { data: currencies } = await supabaseAdmin
      .from("currencies")
      .select("id, code, name, symbol, is_active")
      .in("id", [...new Set(allCurrencyIds)]);
    currencyMap = Object.fromEntries((currencies || []).map((c) => [c.id, c]));
  }

  res.json({
    base_currency_id: baseCurrencyId,
    base_currency: baseCurrencyId ? (currencyMap[baseCurrencyId] ?? null) : null,
    display_currencies: displayRows.map((r) => ({
      ...r,
      rate_from_base: Number(r.rate_from_base),
      currency: currencyMap[r.currency_id] ?? null,
    })),
  });
}

/**
 * PATCH /currencies/merchant/base
 * Body: { currency_id }
 * Set the merchant's base currency (source-of-truth for all prices).
 */
export async function setMerchantBaseCurrency(req, res) {
  const merchantId = req.user.merchant_id;
  const { currency_id } = req.body || {};

  if (!currency_id) {
    return res.status(400).json({ error: "currency_id is required" });
  }

  // Verify the currency exists and is active
  const { data: currency, error: currErr } = await supabaseAdmin
    .from("currencies")
    .select("id, code, name, symbol")
    .eq("id", currency_id)
    .eq("is_active", true)
    .maybeSingle();

  if (currErr || !currency) {
    return res.status(400).json({ error: "Currency not found or inactive" });
  }

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("merchant")
    .update({ base_currency_id: currency_id })
    .eq("id", merchantId)
    .select("id, base_currency_id")
    .single();

  if (updateErr) return res.status(400).json({ error: updateErr.message });

  res.json({
    merchant_id: updated.id,
    base_currency_id: updated.base_currency_id,
    base_currency: currency,
  });
}

/**
 * POST /currencies/merchant/display
 * Body: { currency_id, rate_from_base, is_default_display? }
 * Add a display currency for the merchant.
 *
 * Rules:
 *  - currency must exist in currencies table and be active
 *  - rate_from_base must be > 0
 *  - duplicate (merchant_id + currency_id) is rejected
 *  - only one row can have is_default_display = true per merchant
 */
export async function addMerchantDisplayCurrency(req, res) {
  const merchantId = req.user.merchant_id;
  const { currency_id, rate_from_base, is_default_display = false } = req.body || {};

  if (!currency_id || rate_from_base === undefined || rate_from_base === null) {
    return res.status(400).json({ error: "currency_id and rate_from_base are required" });
  }

  const rate = Number(rate_from_base);
  if (!Number.isFinite(rate) || rate <= 0) {
    return res.status(400).json({ error: "rate_from_base must be a positive number" });
  }

  // Verify currency exists and is active
  const { data: currency, error: currErr } = await supabaseAdmin
    .from("currencies")
    .select("id, code, name, symbol")
    .eq("id", currency_id)
    .eq("is_active", true)
    .maybeSingle();

  if (currErr || !currency) {
    return res.status(400).json({ error: "Currency not found or inactive" });
  }

  // Prevent duplicate (merchant_id + currency_id)
  const { data: existing } = await supabaseAdmin
    .from("merchant_currencies")
    .select("id")
    .eq("merchant_id", merchantId)
    .eq("currency_id", currency_id)
    .maybeSingle();

  if (existing) {
    return res.status(400).json({
      error: "This currency is already configured for this merchant. Use PATCH to update it.",
    });
  }

  // Enforce single default display currency: clear existing default before setting a new one
  if (is_default_display) {
    await supabaseAdmin
      .from("merchant_currencies")
      .update({ is_default_display: false })
      .eq("merchant_id", merchantId)
      .eq("is_default_display", true);
  }

  const { data, error } = await supabaseAdmin
    .from("merchant_currencies")
    .insert({
      merchant_id: merchantId,
      currency_id,
      rate_from_base: rate,
      is_active: true,
      is_default_display: Boolean(is_default_display),
    })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  res.status(201).json({ ...data, rate_from_base: Number(data.rate_from_base), currency });
}

/**
 * PATCH /currencies/merchant/display/:mcId
 * Body: { rate_from_base?, is_active?, is_default_display? }
 * Update a merchant display currency entry.
 */
export async function updateMerchantDisplayCurrency(req, res) {
  const merchantId = req.user.merchant_id;
  const { mcId } = req.params;
  const { rate_from_base, is_active, is_default_display } = req.body || {};

  // Verify ownership
  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from("merchant_currencies")
    .select("id, currency_id, rate_from_base, is_active, is_default_display")
    .eq("id", mcId)
    .eq("merchant_id", merchantId)
    .maybeSingle();

  if (fetchErr || !existing) {
    return res.status(404).json({ error: "Merchant currency entry not found" });
  }

  const updates = {};

  if (rate_from_base !== undefined) {
    const rate = Number(rate_from_base);
    if (!Number.isFinite(rate) || rate <= 0) {
      return res.status(400).json({ error: "rate_from_base must be a positive number" });
    }
    updates.rate_from_base = rate;
  }

  if (is_active !== undefined) {
    updates.is_active = Boolean(is_active);
  }

  if (is_default_display !== undefined) {
    updates.is_default_display = Boolean(is_default_display);
    // Enforce single default: clear existing default first
    if (updates.is_default_display) {
      await supabaseAdmin
        .from("merchant_currencies")
        .update({ is_default_display: false })
        .eq("merchant_id", merchantId)
        .eq("is_default_display", true)
        .neq("id", mcId);
    }
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  const { data, error } = await supabaseAdmin
    .from("merchant_currencies")
    .update(updates)
    .eq("id", mcId)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  res.json({ ...data, rate_from_base: Number(data.rate_from_base) });
}

/**
 * DELETE /currencies/merchant/display/:mcId
 * Remove a display currency from the merchant's configuration.
 */
export async function removeMerchantDisplayCurrency(req, res) {
  const merchantId = req.user.merchant_id;
  const { mcId } = req.params;

  const { data: existing } = await supabaseAdmin
    .from("merchant_currencies")
    .select("id")
    .eq("id", mcId)
    .eq("merchant_id", merchantId)
    .maybeSingle();

  if (!existing) {
    return res.status(404).json({ error: "Merchant currency entry not found" });
  }

  const { error } = await supabaseAdmin
    .from("merchant_currencies")
    .delete()
    .eq("id", mcId);

  if (error) return res.status(400).json({ error: error.message });

  res.json({ success: true, deleted_id: Number(mcId) });
}
