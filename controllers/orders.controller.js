import { supabaseAdmin } from "../db_connection.js";
import jwt from "jsonwebtoken";
import * as XLSX from "xlsx";
import dayjs from "dayjs";
import { resolveDisplayCurrency, convertToDisplay } from "../lib/currency.js";
import { getOrCreateActiveTableSession } from "../lib/tableSessions.js";
const JWT_TABLE_SECRET =
  process.env.JWT_TABLE_SECRET || process.env.JWT_SECRET || "dev-secret";
const ORDER_STATUSES = [
  "draft",
  "placed",
  "accepted",
  "preparing",
  "ready",
  "completed",
  "cancelled",
];
const ORDER_TYPES = ["dine_in", "pickup", "delivery"];
const MIN_QUANTITY = 1;
const MAX_QUANTITY = 100;

async function getNextOrderNumber(branchId) {
  const { data: last } = await supabaseAdmin
    .from("order")
    .select("order_number")
    .eq("branch_id", branchId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  const next = last?.order_number ? parseInt(last.order_number, 10) + 1 : 1000;
  return String(next);
}

async function resolveUnitPrice(merchantId, itemId, variantId) {
  if (variantId) {
    const { data: v } = await supabaseAdmin
      .from("item_variant")
      .select("price")
      .eq("id", variantId)
      .eq("merchant_id", merchantId)
      .single();
    if (v) return Number(v.price);
  }
  const { data: item } = await supabaseAdmin
    .from("item")
    .select("base_price")
    .eq("id", itemId)
    .eq("merchant_id", merchantId)
    .single();
  return item ? Number(item.base_price) : 0;
}

async function resolveItemName(merchantId, itemId) {
  const { data: item } = await supabaseAdmin
    .from("item")
    .select("name_en")
    .eq("id", itemId)
    .eq("merchant_id", merchantId)
    .single();
  return item?.name_en || "";
}

async function resolveModifierNamePrice(merchantId, modifierId) {
  const { data: m } = await supabaseAdmin
    .from("modifiers")
    .select("name_en, price")
    .eq("id", modifierId)
    .eq("merchant_id", merchantId)
    .single();
  return m
    ? { name: m.name_en, price: Number(m.price) }
    : { name: "", price: 0 };
}

/**
 * Validate that selected modifiers per group satisfy item_modifier_group min/max rules.
 * Returns { valid: true } or { valid: false, error: string }.
 */
async function validateModifierRules(
  merchantId,
  itemId,
  itemName,
  selectedModifierIds,
) {
  const { data: rules } = await supabaseAdmin
    .from("item_modifier_group")
    .select("modifier_group_id, min_select, max_select")
    .eq("item_id", itemId);
  if (!rules?.length) return { valid: true };
  // Normalize ids to strings to avoid frontend/backend type mismatches.
  const selected = new Set((selectedModifierIds || []).map((id) => String(id)));
  for (const rule of rules) {
    const { data: modsInGroup } = await supabaseAdmin
      .from("modifiers")
      .select("id")
      .eq("modifier_group_id", rule.modifier_group_id)
      .eq("merchant_id", merchantId);
    const inGroup = (modsInGroup || []).filter((m) =>
      selected.has(String(m.id)),
    );
    const count = inGroup.length;
    const min = Number(rule.min_select) ?? 0;
    const max = Number(rule.max_select) ?? 999;
    // min_select/max_select are inclusive.
    if (count < min) {
      return {
        valid: false,
        error: `Item "${itemName || itemId}": you must select at least ${min} modifier(s) for this option (selected ${count})`,
      };
    }
    if (count > max) {
      return {
        valid: false,
        error: `Item "${itemName || itemId}": you may select at most ${max} modifier(s) for this option (selected ${count})`,
      };
    }
  }
  return { valid: true };
}

/** Get branch IDs for a merchant (order table has branch_id, not merchant_id). */
async function getBranchIdsForMerchant(merchantId) {
  const { data: branches } = await supabaseAdmin
    .from("branch")
    .select("id")
    .eq("merchant_id", merchantId);
  return (branches || []).map((b) => b.id);
}

function normalizePage(value) {
  const page = Number(value);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function normalizeLimit(value) {
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return 20;
  return Math.min(Math.floor(limit), 100);
}

const ALLOWED_ORDER_SORT_FIELDS = new Set([
  "created_at",
  "total_price",
  "order_number",
  "status",
]);

function normalizeSortBy(value) {
  return ALLOWED_ORDER_SORT_FIELDS.has(value) ? value : "created_at";
}

function normalizeSortDir(value) {
  return String(value).toLowerCase() === "asc" ? "asc" : "desc";
}

export async function enrichOrdersWithContext(orders) {
  if (!orders?.length) return [];

  const branchIds = [
    ...new Set(orders.map((order) => order.branch_id).filter(Boolean)),
  ];
  const tableIds = [
    ...new Set(orders.map((order) => order.table_id).filter(Boolean)),
  ];

  const [branchesRes, tablesRes] = await Promise.all([
    branchIds.length
      ? supabaseAdmin.from("branch").select("id, name").in("id", branchIds)
      : Promise.resolve({ data: [] }),
    tableIds.length
      ? supabaseAdmin
          .from("table")
          .select("id, number, branch_id")
          .in("id", tableIds)
      : Promise.resolve({ data: [] }),
  ]);

  const branchMap = new Map(
    (branchesRes.data || []).map((branch) => [String(branch.id), branch]),
  );
  const tableMap = new Map(
    (tablesRes.data || []).map((table) => [String(table.id), table]),
  );

  return orders.map((order) => {
    const branch = branchMap.get(String(order.branch_id)) || null;
    const table = order.table_id
      ? tableMap.get(String(order.table_id)) || null
      : null;

    return {
      ...order,
      branch_name: branch?.name ?? null,
      table_number: table?.number != null ? String(table.number) : null,
      branch: branch
        ? { id: branch.id, name: branch.name }
        : { id: order.branch_id, name: null },
      table: order.table_id
        ? {
            id: order.table_id,
            number: table?.number != null ? String(table.number) : null,
          }
        : null,
    };
  });
}

/** Rollback: delete order and its order_items + order_item_modifier (all-or-nothing). */
async function rollbackOrder(orderId) {
  const { data: orderItems } = await supabaseAdmin
    .from("order_items")
    .select("id")
    .eq("order_id", orderId);
  const oiIds = (orderItems || []).map((oi) => oi.id);
  if (oiIds.length) {
    await supabaseAdmin
      .from("order_item_modifier")
      .delete()
      .in("order_item_id", oiIds);
    await supabaseAdmin.from("order_items").delete().eq("order_id", orderId);
  }
  await supabaseAdmin.from("order").delete().eq("id", orderId);
}

export async function create(req, res) {
  const { t: token } = req.query;
  // display_currency_id: the currency_id the customer had selected at checkout
  const { items: lineItems, display_currency_id } = req.body || {};
  // validate token
  if (!token) {
    return res.status(400).json({ error: "Token (t) required" });
  }
  // verify token (must be signed with JWT_TABLE_SECRET when generating QR)
  let payload;
  try {
    payload = jwt.verify(token, JWT_TABLE_SECRET);
  } catch (err) {
    const message =
      process.env.NODE_ENV === "development" && err?.message
        ? `Invalid token: ${err.message}`
        : "Invalid token";
    return res.status(400).json({ error: message });
  }
  // parse token
  const {
    merchantId: tokenMerchantId,
    branchId: tokenBranchId,
    tableId: tokenTableId,
  } = payload;

  // validate request body
  if (
    !tokenMerchantId ||
    !tokenBranchId ||
    !tokenTableId ||
    !Array.isArray(lineItems) ||
    lineItems.length === 0
  ) {
    return res.status(400).json({
      error: "tokenMerchantId, tokenBranchId, tokenTableId, and items required",
    });
  }
  // validate branch
  const { data: branch } = await supabaseAdmin
    .from("branch")
    .select("merchant_id")
    .eq("id", tokenBranchId)
    .single();
  if (!branch || branch.merchant_id !== tokenMerchantId) {
    return res.status(400).json({
      error: "tokenBranchId must belong to the given tokenMerchantId",
    });
  }
  // validate table
  if (tokenTableId) {
    const { data: tbl } = await supabaseAdmin
      .from("table")
      .select("branch_id")
      .eq("id", tokenTableId)
      .single();
    if (!tbl || tbl.branch_id !== tokenBranchId) {
      return res
        .status(400)
        .json({ error: "tokenTableId must belong to the given tokenBranchId" });
    }
  }
  // Ensure exactly one active session per table and auto-open when needed.
  const tableSession = await getOrCreateActiveTableSession({
    merchantId: tokenMerchantId,
    branchId: tokenBranchId,
    tableId: tokenTableId,
    openedByType: "customer",
  });

  // Resolve display currency once — used for all display snapshot calculations.
  // Falls back safely to base currency if selectedCurrencyId is missing/invalid.
  const { currency: displayCurrency, rate_from_base: displayRate } =
    await resolveDisplayCurrency(tokenMerchantId, display_currency_id);

  // get next order number
  const order_number = await getNextOrderNumber(tokenBranchId);
  let total_price = 0;

  const orderRows = [];
  const modifierRows = [];
  // validate items
  for (const line of lineItems) {
    const { item_id, variant_id, quantity, modifiers } = line;
    const rawQty = Number(quantity);
    if (!Number.isFinite(rawQty) || rawQty < MIN_QUANTITY) {
      return res.status(400).json({
        error: `Quantity must be between ${MIN_QUANTITY} and ${MAX_QUANTITY}`,
      });
    }
    const qty = Math.min(
      MAX_QUANTITY,
      Math.max(MIN_QUANTITY, Math.floor(rawQty)),
    );
    if (qty !== rawQty && rawQty > MAX_QUANTITY) {
      return res.status(400).json({
        error: `Quantity must be between ${MIN_QUANTITY} and ${MAX_QUANTITY}`,
      });
    }
    // validate item
    const { data: item } = await supabaseAdmin
      .from("item")
      .select("id, merchant_id, status, name_en")
      .eq("id", item_id)
      .eq("merchant_id", tokenMerchantId)
      .single();
    if (!item) {
      return res.status(400).json({ error: `Item ${item_id} not found` });
    }
    if (item.status !== "active") {
      return res.status(400).json({
        error: "Item is not available for ordering (hidden or out of stock)",
      });
    }
    // validate modifiers
    const selectedModIds = (modifiers || [])
      .map((m) => m?.modifier_id ?? m?.modifierId ?? m?.id)
      .filter(Boolean);
    // validate modifier rules
    const modRules = await validateModifierRules(
      tokenMerchantId,
      item_id,
      item.name_en,
      selectedModIds,
    );
    if (!modRules.valid) {
      return res.status(400).json({ error: modRules.error });
    }
    // validate variant
    if (variant_id) {
      const { data: variant } = await supabaseAdmin
        .from("item_variant")
        .select("id, item_id, merchant_id")
        .eq("id", variant_id)
        .eq("item_id", item_id)
        .eq("merchant_id", tokenMerchantId)
        .single();
      if (!variant) {
        return res
          .status(400)
          .json({ error: `Variant ${variant_id} not found for item` });
      }
    }
    // resolve unit price
    const unit_price = await resolveUnitPrice(
      tokenMerchantId,
      item_id,
      variant_id,
    );
    // validate unit price
    if (unit_price < 0) {
      return res
        .status(400)
        .json({ error: "Invalid price: negative prices are not allowed" });
    }
    // resolve item name
    const name_snapshot = await resolveItemName(tokenMerchantId, item_id);
    if (!name_snapshot || name_snapshot.trim() === "") {
      return res.status(400).json({
        error: `Item ${item_id} not found or does not belong to this merchant`,
      });
    }
    // resolve price snapshot
    const price_snapshot = unit_price;
    // resolve line total (base currency)
    const line_total = unit_price * qty;
    // add order row — includes display snapshots for what the customer saw
    orderRows.push({
      item_id,
      variant_id: variant_id || null,
      quantity: qty,
      name_snapshot,
      price_snapshot, // base unit price
      total_price: line_total, // base line total
      display_price_snapshot: convertToDisplay(unit_price, displayRate), // display unit price
      display_total_price: convertToDisplay(line_total, displayRate), // display line total
    });
    // add to total price
    total_price += line_total;
    // validate modifier quantity
    for (const mod of modifiers || []) {
      const modId = mod?.modifier_id ?? mod?.modifierId ?? mod?.id;
      if (!modId) {
        return res.status(400).json({
          error: "Modifier id is required for each selected modifier",
        });
      }
      const modLineQty = Number(mod.quantity) || 1;
      if (
        !Number.isFinite(modLineQty) ||
        modLineQty < MIN_QUANTITY ||
        modLineQty > MAX_QUANTITY
      ) {
        return res.status(400).json({
          error: `Modifier quantity must be between ${MIN_QUANTITY} and ${MAX_QUANTITY}`,
        });
      }
      // resolve modifier row
      const { data: modRow } = await supabaseAdmin
        .from("modifiers")
        .select("id, name_en, price")
        .eq("id", modId)
        .eq("merchant_id", tokenMerchantId)
        .single();
      if (!modRow) {
        return res.status(400).json({
          error: `Modifier ${modId} not found or does not belong to this merchant`,
        });
      }
      // validate modifier price
      const name = modRow.name_en ?? "";
      const price = Number(modRow.price);
      if (price < 0) {
        return res.status(400).json({
          error: "Invalid modifier price: negative prices are not allowed",
        });
      }
      // resolve modifier quantity
      const modQty = Math.floor(modLineQty) * qty;
      // add to total price
      total_price += price * modQty;
      // add modifier row
      modifierRows.push({
        modifier_id: modId,
        name_snapshot: name,
        price_snapshot: price,
        price: price * modQty,
        _order_item_index: orderRows.length - 1,
      });
    }
  }
  // create order — total_price is in base currency; display_* fields are snapshots of what the customer saw
  // updated_at is set explicitly so polling (GET /orders/updates?after=) works correctly from the first insert.
  const now = new Date().toISOString();
  const { data: order, error: orderError } = await supabaseAdmin
    .from("order")
    .insert({
      branch_id: tokenBranchId,
      table_id: tokenTableId || null,
      table_session_id: tableSession.id,
      order_number,
      status: "placed",
      total_price,
      display_total_price: convertToDisplay(total_price, displayRate),
      display_currency_id: displayCurrency?.id ?? null,
      display_exchange_rate: displayRate,
      updated_at: now,
    })
    .select()
    .single();
  if (orderError) return res.status(400).json({ error: orderError.message });
  // create order items
  for (let i = 0; i < orderRows.length; i++) {
    const row = orderRows[i];
    const { data: oi, error: oiErr } = await supabaseAdmin
      .from("order_items")
      .insert({
        order_id: order.id,
        item_id: row.item_id,
        variant_id: row.variant_id,
        quantity: row.quantity,
        name_snapshot: row.name_snapshot,
        price_snapshot: row.price_snapshot, // base unit price snapshot
        total_price: row.total_price, // base line total
        display_price_snapshot: row.display_price_snapshot, // display unit price snapshot
        display_total_price: row.display_total_price, // display line total
      })
      .select()
      .single();
    if (oiErr) {
      await rollbackOrder(order.id);
      return res.status(400).json({
        error: "Failed to save order; order cancelled",
        details: oiErr.message,
      });
    }
    // create order item modifiers
    const forThisItem = modifierRows.filter((m) => m._order_item_index === i);
    for (const m of forThisItem) {
      const { error: modErr } = await supabaseAdmin
        .from("order_item_modifier")
        .insert({
          order_item_id: oi.id,
          modifier_id: m.modifier_id,
          name_snapshot: m.name_snapshot,
          price_snapshot: m.price_snapshot,
          price: m.price,
        });
      if (modErr) {
        await rollbackOrder(order.id);
        return res.status(400).json({
          error: "Failed to save order; order cancelled",
          details: modErr.message,
        });
      }
    }
  }
  const orderEvent = {
    order_id: order.id,
    order_number: order.order_number,
    status: order.status,
    total_price: order.total_price,
    branch_id: tokenBranchId,
    table_id: tokenTableId || null,
  };
  const io = req.app?.get("io");
  if (io) {
    io.emit("order:created", orderEvent);
    io.to(`branch:${tokenBranchId}`).emit("order:created", orderEvent);
  }
  res.status(201).json({
    order_id: order.id,
    table_session_id: order.table_session_id,
    order_number: order.order_number,
    status: order.status,
    total_price: order.total_price,
    display_total_price: order.display_total_price,
    display_currency_id: order.display_currency_id,
    display_exchange_rate: order.display_exchange_rate,
  });
}

export async function list(req, res) {
  const {
    branch_id,
    status,
    from,
    to,
    q,
    cursor,
    page = 1,
    limit = 20,
    table_id,
    table_number,
    min_total,
    max_total,
    sort_by,
    sort_dir,
  } = req.query;
  const pageNum = normalizePage(page);
  const limitNum = normalizeLimit(limit);
  const sortBy = normalizeSortBy(sort_by);
  const sortDir = normalizeSortDir(sort_dir);
  if (req.user.role === "cashier" || req.user.role === "kitchen") {
    const scopeBranch = branch_id || req.user.branch_id;
    if (!scopeBranch || String(scopeBranch) !== String(req.user.branch_id)) {
      return res.status(403).json({ error: "Access limited to your branch" });
    }
  }
  const branchIds = await getBranchIdsForMerchant(req.user.merchant_id);
  if (!branchIds.length) {
    return res.json({
      data: [],
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: 0,
        total_pages: 0,
        has_next: false,
        has_prev: pageNum > 1,
      },
      next_cursor: null,
    });
  }

  let filteredTableIds = null;
  if (table_number) {
    let tablesQuery = supabaseAdmin
      .from("table")
      .select("id")
      .eq("number", String(table_number).trim());

    if (branch_id) {
      tablesQuery = tablesQuery.eq("branch_id", branch_id);
    } else if (
      req.user.branch_id &&
      (req.user.role === "cashier" || req.user.role === "kitchen")
    ) {
      tablesQuery = tablesQuery.eq("branch_id", req.user.branch_id);
    } else {
      tablesQuery = tablesQuery.in("branch_id", branchIds);
    }

    const { data: tables, error: tablesError } = await tablesQuery;
    if (tablesError)
      return res.status(500).json({ error: tablesError.message });

    filteredTableIds = (tables || []).map((table) => table.id);
    if (!filteredTableIds.length) {
      return res.json({
        data: [],
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: 0,
          total_pages: 0,
          has_next: false,
          has_prev: pageNum > 1,
        },
        next_cursor: null,
      });
    }
  }

  let query = supabaseAdmin
    .from("order")
    .select("*", { count: "exact" })
    .in("branch_id", branchIds);
  if (branch_id) query = query.eq("branch_id", branch_id);
  if (
    req.user.branch_id &&
    (req.user.role === "cashier" || req.user.role === "kitchen")
  ) {
    query = query.eq("branch_id", req.user.branch_id);
  }
  if (status) {
    const statuses = status.split(",").map((s) => s.trim());
    query = query.in("status", statuses);
  }
  if (table_id) query = query.eq("table_id", table_id);
  if (filteredTableIds) query = query.in("table_id", filteredTableIds);
  if (min_total !== undefined && min_total !== "") {
    query = query.gte("total_price", Number(min_total));
  }
  if (max_total !== undefined && max_total !== "") {
    query = query.lte("total_price", Number(max_total));
  }
  if (from) query = query.gte("created_at", from);
  if (to) query = query.lte("created_at", to);
  if (q) query = query.ilike("order_number", `%${q}%`);
  if (cursor) query = query.lt("created_at", cursor);

  const fromIndex = (pageNum - 1) * limitNum;
  const toIndex = fromIndex + limitNum - 1;

  query = query
    .order(sortBy, { ascending: sortDir === "asc" })
    .order("created_at", { ascending: false })
    .range(fromIndex, toIndex);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });
  const enrichedData = await enrichOrdersWithContext(data || []);
  const total = count || 0;
  const totalPages = total > 0 ? Math.ceil(total / limitNum) : 0;
  res.json({
    data: enrichedData,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      total_pages: totalPages,
      has_next: pageNum < totalPages,
      has_prev: pageNum > 1,
    },
    next_cursor:
      enrichedData.length === limitNum
        ? enrichedData[enrichedData.length - 1]?.created_at
        : null,
  });
}

const MAX_EXPORT_ROWS = 5000;

export async function exportOrdersExcel(req, res) {
  const {
    branch_id,
    status,
    from,
    to,
    q,
    table_id,
    table_number,
    min_total,
    max_total,
    sort_by,
    sort_dir,
  } = req.query;

  if (req.user.role === "cashier" || req.user.role === "kitchen") {
    const scopeBranch = branch_id || req.user.branch_id;
    if (!scopeBranch || String(scopeBranch) !== String(req.user.branch_id)) {
      return res.status(403).json({ error: "Access limited to your branch" });
    }
  }

  const branchIds = await getBranchIdsForMerchant(req.user.merchant_id);
  if (!branchIds.length) {
    return res.status(400).json({ error: "No branches found for merchant" });
  }

  let filteredTableIds = null;
  if (table_number) {
    let tablesQuery = supabaseAdmin
      .from("table")
      .select("id")
      .eq("number", String(table_number).trim());
    if (branch_id) {
      tablesQuery = tablesQuery.eq("branch_id", branch_id);
    } else if (
      req.user.branch_id &&
      (req.user.role === "cashier" || req.user.role === "kitchen")
    ) {
      tablesQuery = tablesQuery.eq("branch_id", req.user.branch_id);
    } else {
      tablesQuery = tablesQuery.in("branch_id", branchIds);
    }
    const { data: tables, error: tablesError } = await tablesQuery;
    if (tablesError)
      return res.status(500).json({ error: tablesError.message });
    filteredTableIds = (tables || []).map((t) => t.id);
    if (!filteredTableIds?.length) {
      return res.status(400).json({ error: "No tables match table_number" });
    }
  }

  let query = supabaseAdmin
    .from("order")
    .select("*")
    .in("branch_id", branchIds)
    .limit(MAX_EXPORT_ROWS);
  if (branch_id) query = query.eq("branch_id", branch_id);
  if (
    req.user.branch_id &&
    (req.user.role === "cashier" || req.user.role === "kitchen")
  ) {
    query = query.eq("branch_id", req.user.branch_id);
  }
  if (status) {
    const statuses = status.split(",").map((s) => s.trim());
    query = query.in("status", statuses);
  }
  if (table_id) query = query.eq("table_id", table_id);
  if (filteredTableIds) query = query.in("table_id", filteredTableIds);
  if (min_total !== undefined && min_total !== "")
    query = query.gte("total_price", Number(min_total));
  if (max_total !== undefined && max_total !== "")
    query = query.lte("total_price", Number(max_total));
  if (from) query = query.gte("created_at", from);
  if (to) query = query.lte("created_at", to);
  if (q) query = query.ilike("order_number", `%${q}%`);

  const sortBy = normalizeSortBy(sort_by);
  const sortDir = normalizeSortDir(sort_dir);
  query = query
    .order(sortBy, { ascending: sortDir === "asc" })
    .order("created_at", { ascending: false });

  const { data: orders, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  const enriched = await enrichOrdersWithContext(orders || []);

  const headers = ["Order #", "Date", "Branch", "Table", "Status", "Total"];
  const rows = enriched.map((o) => [
    o.order_number ?? "",
    o.created_at ? dayjs(o.created_at).format("YYYY-MM-DD HH:mm") : "",
    o.branch_name ?? "",
    o.table_number ?? "",
    o.status ?? "",
    Number(o.total_price) ?? 0,
  ]);
  const sheetData = [headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Orders");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  const filename = `orders_${dayjs().format("YYYY-MM-DD_HH-mm")}.xlsx`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.send(buf);
}

export async function getOne(req, res) {
  const { orderId } = req.params;
  const { data: order, error } = await supabaseAdmin
    .from("order")
    .select("*")
    .eq("id", orderId)
    .single();
  if (error || !order)
    return res.status(404).json({ error: "Order not found" });
  const { data: branch } = await supabaseAdmin
    .from("branch")
    .select("id, merchant_id, name")
    .eq("id", order.branch_id)
    .single();
  if (!branch || branch.merchant_id !== req.user.merchant_id) {
    return res.status(404).json({ error: "Order not found" });
  }
  if (
    (req.user.role === "cashier" || req.user.role === "kitchen") &&
    String(order.branch_id) !== String(req.user.branch_id)
  ) {
    return res.status(403).json({ error: "Access limited to your branch" });
  }
  const { data: orderItems } = await supabaseAdmin
    .from("order_items")
    .select("*")
    .eq("order_id", orderId);
  const { data: table } = order.table_id
    ? await supabaseAdmin
        .from("table")
        .select("id, number")
        .eq("id", order.table_id)
        .maybeSingle()
    : { data: null };
  const itemsWithMods = [];
  for (const oi of orderItems || []) {
    const { data: mods } = await supabaseAdmin
      .from("order_item_modifier")
      .select("*")
      .eq("order_item_id", oi.id);
    itemsWithMods.push({ ...oi, modifiers: mods || [] });
  }
  res.json({
    ...order,
    branch_name: branch.name ?? null,
    table_number: table?.number != null ? String(table.number) : null,
    branch: { id: branch.id, name: branch.name ?? null },
    table: order.table_id
      ? {
          id: order.table_id,
          number: table?.number != null ? String(table.number) : null,
        }
      : null,
    items: itemsWithMods,
  });
}

/**
 * GET /orders/updates?after=<ISO>&branch_id=<optional>&limit=<optional>
 *
 * Delta polling endpoint. Returns only orders where updated_at > `after`.
 * Used by kitchen/cashier/admin screens to detect new orders and status changes
 * without re-fetching the full list on every poll tick.
 *
 * Poll loop pattern (frontend):
 *   1. On mount: call with after = (now - small buffer, e.g. 30s ago)
 *   2. On each response: set after = response.server_time
 *   3. Repeat every N seconds (recommended: 5–15s)
 *
 * @param {string} after  - Required. ISO 8601 timestamp. Only orders updated AFTER this are returned.
 * @param {string} branch_id - Optional. Filter to a specific branch (must belong to merchant).
 * @param {number} limit  - Optional. Default 50, max 100.
 */
export async function pollUpdates(req, res) {
  const { after, branch_id, limit } = req.query;

  // --- Validate `after` ---
  if (!after) {
    return res.status(400).json({
      error:
        "'after' is required. Send an ISO 8601 timestamp (e.g. 2025-01-01T00:00:00.000Z).",
    });
  }
  const afterDate = new Date(after);
  if (isNaN(afterDate.getTime())) {
    return res.status(400).json({
      error: "'after' must be a valid ISO 8601 timestamp.",
    });
  }

  // --- Reject unreasonably old timestamps (prevent full-table scans) ---
  const MAX_LOOKBACK_HOURS = 24;
  const maxLookback = new Date(
    Date.now() - MAX_LOOKBACK_HOURS * 60 * 60 * 1000,
  );
  if (afterDate < maxLookback) {
    return res.status(400).json({
      error: `'after' cannot be more than ${MAX_LOOKBACK_HOURS} hours in the past. Use GET /orders for historical data.`,
    });
  }

  const limitNum = normalizeLimit(limit);

  // --- Role-based branch scoping (mirrors list() logic) ---
  const isBranchLocked =
    req.user.role === "cashier" || req.user.role === "kitchen";
  if (isBranchLocked) {
    if (branch_id && String(branch_id) !== String(req.user.branch_id)) {
      return res.status(403).json({ error: "Access limited to your branch" });
    }
  }

  const branchIds = await getBranchIdsForMerchant(req.user.merchant_id);
  if (!branchIds.length) {
    return res.json({
      items: [],
      server_time: new Date().toISOString(),
      count: 0,
    });
  }

  // --- Build query ---
  let query = supabaseAdmin
    .from("order")
    .select("*")
    .in("branch_id", branchIds)
    .gt("updated_at", afterDate.toISOString()) // delta: only changed rows
    .order("updated_at", { ascending: true }) // ascending so frontend uses last item as next cursor
    .limit(limitNum);

  // Apply branch filter
  if (isBranchLocked) {
    // cashier/kitchen: always locked to their own branch
    query = query.eq("branch_id", req.user.branch_id);
  } else if (branch_id) {
    // owner/manager with explicit branch_id filter: verify it belongs to their merchant
    if (!branchIds.map(String).includes(String(branch_id))) {
      return res
        .status(403)
        .json({ error: "branch_id does not belong to your merchant" });
    }
    query = query.eq("branch_id", branch_id);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const enriched = await enrichOrdersWithContext(data || []);

  return res.json({
    items: enriched,
    server_time: new Date().toISOString(), // frontend uses this as the next `after` value
    count: enriched.length,
  });
}

export async function updateStatus(req, res) {
  const { orderId } = req.params;
  const { status } = req.body || {};
  if (!status || !ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ error: "Valid status required" });
  }
  const { data: order } = await supabaseAdmin
    .from("order")
    .select("branch_id")
    .eq("id", orderId)
    .single();
  if (!order) return res.status(404).json({ error: "Order not found" });
  const { data: branch } = await supabaseAdmin
    .from("branch")
    .select("merchant_id")
    .eq("id", order.branch_id)
    .single();
  if (!branch || branch.merchant_id !== req.user.merchant_id) {
    return res.status(404).json({ error: "Order not found" });
  }
  if (
    (req.user.role === "cashier" || req.user.role === "kitchen") &&
    String(order.branch_id) !== String(req.user.branch_id)
  ) {
    return res.status(403).json({ error: "Access limited to your branch" });
  }
  // updated_at is set explicitly so polling detects this status change immediately.
  const { data, error } = await supabaseAdmin
    .from("order")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", orderId)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}

// /////////////////////////////////////////////////////////////////////
function normalizeRpcItems(items) {
  return items.map((line) => ({
    item_id: line.item_id,
    variant_id: line.variant_id ?? null,
    quantity: line.quantity,
    modifiers: Array.isArray(line.modifiers)
      ? line.modifiers.map((mod) => ({
          modifier_id: mod?.modifier_id ?? mod?.modifierId ?? mod?.id ?? null,
          quantity: mod?.quantity ?? 1,
        }))
      : [],
  }));
}

function mapRpcError(error) {
  if (!error) {
    return {
      status: 500,
      payload: { error: "Unknown error" },
    };
  }

  const message = error.message || "Failed to create order";

  // PostgreSQL unique violation
  if (error.code === "23505") {
    return {
      status: 409,
      payload: { error: "Duplicate request or conflicting order creation" },
    };
  }

  // PostgreSQL raise exception from function
  if (error.code === "P0001") {
    return {
      status: 400,
      payload: { error: message },
    };
  }

  return {
    status: 500,
    payload: {
      error:
        process.env.NODE_ENV === "development"
          ? message
          : "Failed to create order",
    },
  };
}

// create order_atomically
export async function createAtomicOrder(req, res) {
  const { t: token } = req.query;
  const { items: lineItems, display_currency_id } = req.body || {};

  if (!token) {
    return res.status(400).json({ error: "Token (t) required" });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_TABLE_SECRET);
  } catch (err) {
    const message =
      process.env.NODE_ENV === "development" && err?.message
        ? `Invalid token: ${err.message}`
        : "Invalid token";

    return res.status(400).json({ error: message });
  }

  const {
    merchantId: tokenMerchantId,
    branchId: tokenBranchId,
    tableId: tokenTableId,
  } = payload || {};

  if (
    !tokenMerchantId ||
    !tokenBranchId ||
    !tokenTableId ||
    !Array.isArray(lineItems) ||
    lineItems.length === 0
  ) {
    return res.status(400).json({
      error: "tokenMerchantId, tokenBranchId, tokenTableId, and items required",
    });
  }

  let rpcItems;
  try {
    rpcItems = normalizeRpcItems(lineItems);
  } catch {
    return res.status(400).json({
      error: "Invalid items payload",
    });
  }

  const { data, error } = await supabaseAdmin.rpc("create_order_atomic", {
    p_merchant_id: Number(tokenMerchantId),
    p_branch_id: Number(tokenBranchId),
    p_table_id: Number(tokenTableId),
    p_items: rpcItems,
    p_display_currency_id: display_currency_id
      ? Number(display_currency_id)
      : null,
    p_opened_by_type: "customer",
  });
  if (error) {
    const mapped = mapRpcError(error);
    return res.status(mapped.status).json(mapped.payload);
  }

  const orderEvent = {
    order_id: data.order_id,
    table_session_id: data.table_session_id,
    order_number: data.order_number,
    status: data.status,
    total_price: data.total_price,
    display_total_price: data.display_total_price,
    branch_id: tokenBranchId,
    table_id: tokenTableId,
  };

  const io = req.app?.get("io");
  if (io) {
    io.emit("order:created", orderEvent);
    io.to(`branch:${tokenBranchId}`).emit("order:created", orderEvent);
    io.to(`table:${tokenTableId}`).emit("order:created", orderEvent);
  }

  return res.status(201).json({
    order_id: data.order_id,
    table_session_id: data.table_session_id,
    order_number: data.order_number,
    status: data.status,
    total_price: data.total_price,
    display_total_price: data.display_total_price,
    display_currency_id: data.display_currency_id,
    display_exchange_rate: data.display_exchange_rate,
  });
}
