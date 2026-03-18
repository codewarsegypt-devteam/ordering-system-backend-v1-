/**
 * Currency helpers for the single-base-currency + multi-currency-display architecture.
 *
 * Architecture rules enforced here:
 *  - Every merchant has ONE base currency (merchant.base_currency_id)
 *  - All catalog prices (item.base_price, item_variant.price, modifiers.price) are in base currency
 *  - merchant_currencies rows hold DISPLAY currencies with a rate_from_base
 *  - Display prices are calculated at response time — never stored in catalog tables
 *  - order + order_items DO store display snapshots (what the customer saw at checkout)
 */

import { supabaseAdmin } from "../db_connection.js";

// ─────────────────────────────────────────────────────────────────────────────
// Math helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Round to exactly 2 decimal places consistently across the whole system.
 * Uses the "+ EPSILON" trick to avoid IEEE 754 issues (e.g. 1.005 rounding wrong).
 * @param {number} amount
 * @returns {number}
 */
export function roundDisplay(amount) {
  return Math.round((Number(amount) + Number.EPSILON) * 100) / 100;
}

/**
 * Convert a base-currency amount to a display-currency amount.
 * If rate is missing or invalid, returns the base amount unchanged (rate treated as 1).
 * @param {number} baseAmount
 * @param {number} rate - rate_from_base (display per 1 base unit)
 * @returns {number}
 */
export function convertToDisplay(baseAmount, rate) {
  const safeRate = Number.isFinite(Number(rate)) && Number(rate) > 0 ? Number(rate) : 1;
  return roundDisplay(Number(baseAmount) * safeRate);
}

// ─────────────────────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the merchant's base currency row.
 * Returns null if merchant.base_currency_id is unset or the currency is inactive.
 * @param {number} merchantId
 * @returns {Promise<{id, code, name, symbol}|null>}
 */
export async function getMerchantBaseCurrency(merchantId) {
  const { data: merchant } = await supabaseAdmin
    .from("merchant")
    .select("base_currency_id")
    .eq("id", merchantId)
    .maybeSingle();

  if (!merchant?.base_currency_id) return null;

  const { data: currency } = await supabaseAdmin
    .from("currencies")
    .select("id, code, name, symbol")
    .eq("id", merchant.base_currency_id)
    .eq("is_active", true)
    .maybeSingle();

  return currency ?? null;
}

/**
 * Get all active display currencies for a merchant, enriched with currency details.
 * @param {number} merchantId
 * @returns {Promise<Array<{merchant_currency_id, currency_id, rate_from_base, is_default_display, currency}>>}
 */

export async function getMerchantDisplayCurrencies(merchantId) {
  const { data: rows } = await supabaseAdmin
    .from("merchant_currencies")
    .select("id, currency_id, rate_from_base, is_active, is_default_display")
    .eq("merchant_id", merchantId)
    .eq("is_active", true);

  if (!rows?.length) return [];

  const currencyIds = [...new Set(rows.map((r) => r.currency_id))];
  const { data: currencies } = await supabaseAdmin
    .from("currencies")
    .select("id, code, name, symbol")
    .in("id", currencyIds)
    .eq("is_active", true);

  const currencyMap = new Map((currencies || []).map((c) => [c.id, c]));

  return rows
    .map((r) => ({
      merchant_currency_id: r.id,
      currency_id: r.currency_id,
      rate_from_base: Number(r.rate_from_base),
      is_default_display: Boolean(r.is_default_display),
      currency: currencyMap.get(r.currency_id) ?? null,
    }))
    .filter((r) => r.currency !== null); // drop rows whose currency was inactive/deleted
}

/**
 * Get the default display currency for a merchant.
 *
 * Fallback chain:
 *   1. merchant_currencies row with is_default_display = true
 *   2. Merchant base currency (rate = 1)
 *   3. null currency with rate = 1 (if base currency is also unset)
 *
 * @param {number} merchantId
 * @returns {Promise<{currency: object|null, rate_from_base: number}>}
 */
export async function getMerchantDefaultDisplayCurrency(merchantId) {
  const [baseCurrency, displayCurrencies] = await Promise.all([
    getMerchantBaseCurrency(merchantId),
    getMerchantDisplayCurrencies(merchantId),
  ]);

  const defaultDisplay = displayCurrencies.find((c) => c.is_default_display);
  if (defaultDisplay) {
    return { currency: defaultDisplay.currency, rate_from_base: defaultDisplay.rate_from_base };
  }

  // No configured default display — fall back to base currency, rate = 1
  return { currency: baseCurrency ?? null, rate_from_base: 1 };
}

/**
 * Resolve the display currency and exchange rate for a request.
 *
 * Fallback chain (in order):
 *  1. selectedCurrencyId is active in merchant_currencies → use its rate
 *  2. selectedCurrencyId equals merchant base currency → rate = 1
 *  3. selectedCurrencyId missing / invalid / inactive → use merchant default display currency
 *  4. No default display currency → use base currency (rate = 1)
 *
 * Never throws — always returns a safe { currency, rate_from_base }.
 *
 * @param {number} merchantId
 * @param {number|string|null|undefined} selectedCurrencyId - currency_id chosen by the customer
 * @returns {Promise<{currency: object|null, rate_from_base: number}>}
 */
export async function resolveDisplayCurrency(merchantId, selectedCurrencyId) {
  if (!selectedCurrencyId) {
    return getMerchantDefaultDisplayCurrency(merchantId);
  }

  const selectedId = Number(selectedCurrencyId);
  if (!Number.isFinite(selectedId)) {
    return getMerchantDefaultDisplayCurrency(merchantId);
  }

  const [baseCurrency, displayCurrencies] = await Promise.all([
    getMerchantBaseCurrency(merchantId),
    getMerchantDisplayCurrencies(merchantId),
  ]);

  // Selected currency IS the base currency → rate = 1
  if (baseCurrency && selectedId === Number(baseCurrency.id)) {
    return { currency: baseCurrency, rate_from_base: 1 };
  }

  // Selected currency is in merchant's active display currencies
  const found = displayCurrencies.find((c) => Number(c.currency_id) === selectedId);
  if (found) {
    return { currency: found.currency, rate_from_base: found.rate_from_base };
  }

  // Selection was invalid / inactive — fall back to configured default
  const defaultDisplay = displayCurrencies.find((c) => c.is_default_display);
  if (defaultDisplay) {
    return { currency: defaultDisplay.currency, rate_from_base: defaultDisplay.rate_from_base };
  }

  return { currency: baseCurrency ?? null, rate_from_base: 1 };
}
