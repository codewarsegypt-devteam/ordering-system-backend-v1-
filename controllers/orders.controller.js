import { supabaseAdmin } from "../db_connection.js";
import jwt from "jsonwebtoken";
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
  const selected = new Set(selectedModifierIds || []);
  for (const rule of rules) {
    const { data: modsInGroup } = await supabaseAdmin
      .from("modifiers")
      .select("id")
      .eq("modifier_group_id", rule.modifier_group_id)
      .eq("merchant_id", merchantId);
    const inGroup = (modsInGroup || []).filter((m) => selected.has(m.id));
    const count = inGroup.length;
    const min = Number(rule.min_select) ?? 0;
    const max = Number(rule.max_select) ?? 999;
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
  const { items: lineItems } = req.body || {};
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
    return res
      .status(400)
      .json({
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
      .map((m) => m.modifier_id)
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
    // resolve line total
    const line_total = unit_price * qty;
    // add order row
    orderRows.push({
      item_id,
      variant_id: variant_id || null,
      quantity: qty,
      name_snapshot,
      price_snapshot,
      total_price: line_total,
    });
    // add to total price
    total_price += line_total;
    // validate modifier quantity
    for (const mod of modifiers || []) {
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
        .eq("id", mod.modifier_id)
        .eq("merchant_id", tokenMerchantId)
        .single();
      if (!modRow) {
        return res.status(400).json({
          error: `Modifier ${mod.modifier_id} not found or does not belong to this merchant`,
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
        modifier_id: mod.modifier_id,
        name_snapshot: name,
        price_snapshot: price,
        price: price * modQty,
        _order_item_index: orderRows.length - 1,
      });
    }
  }
  // create order
  const { data: order, error: orderError } = await supabaseAdmin
    .from("order")
    .insert({
      branch_id: tokenBranchId,
      table_id: tokenTableId || null,
      order_number,
      status: "placed",
      total_price,
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
        price_snapshot: row.price_snapshot,
        total_price: row.total_price,
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
  const io = req.app?.get("io");
  if (io) {
    io.emit("order:created", {
      order_id: order.id,
      order_number: order.order_number,
      status: order.status,
      total_price: order.total_price,
      branch_id: tokenBranchId,
      table_id: tokenTableId || null,
    });
  }
  io.to(`branch:${tokenBranchId}`).emit("order:created", payload);
  res.status(201).json({
    order_id: order.id,
    order_number: order.order_number,
    status: order.status,
    total_price: order.total_price,
  });
}

export async function list(req, res) {
  const { branch_id, status, from, to, q, limit = 50, cursor } = req.query;
  if (req.user.role === "cashier" || req.user.role === "kitchen") {
    const scopeBranch = branch_id || req.user.branch_id;
    if (!scopeBranch || scopeBranch !== req.user.branch_id) {
      return res.status(403).json({ error: "Access limited to your branch" });
    }
  }
  const branchIds = await getBranchIdsForMerchant(req.user.merchant_id);
  if (!branchIds.length) {
    return res.json({ data: [], next_cursor: null });
  }
  let query = supabaseAdmin
    .from("order")
    .select("*")
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
  if (from) query = query.gte("created_at", from);
  if (to) query = query.lte("created_at", to);
  if (q) query = query.ilike("order_number", `%${q}%`);
  query = query
    .order("created_at", { ascending: false })
    .limit(Math.min(Number(limit) || 50, 100));
  if (cursor) query = query.lt("created_at", cursor);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({
    data: data || [],
    next_cursor:
      data?.length === (Number(limit) || 50)
        ? data[data.length - 1]?.created_at
        : null,
  });
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
    .select("merchant_id")
    .eq("id", order.branch_id)
    .single();
  if (!branch || branch.merchant_id !== req.user.merchant_id) {
    return res.status(404).json({ error: "Order not found" });
  }
  if (
    (req.user.role === "cashier" || req.user.role === "kitchen") &&
    order.branch_id !== req.user.branch_id
  ) {
    return res.status(403).json({ error: "Access limited to your branch" });
  }
  const { data: orderItems } = await supabaseAdmin
    .from("order_items")
    .select("*")
    .eq("order_id", orderId);
  const itemsWithMods = [];
  for (const oi of orderItems || []) {
    const { data: mods } = await supabaseAdmin
      .from("order_item_modifier")
      .select("*")
      .eq("order_item_id", oi.id);
    itemsWithMods.push({ ...oi, modifiers: mods || [] });
  }
  res.json({ ...order, items: itemsWithMods });
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
    order.branch_id !== req.user.branch_id
  ) {
    return res.status(403).json({ error: "Access limited to your branch" });
  }
  const { data, error } = await supabaseAdmin
    .from("order")
    .update({ status })
    .eq("id", orderId)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}
