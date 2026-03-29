import { supabaseAdmin } from "../db_connection.js";
import { enrichOrdersWithContext } from "./orders.controller.js";

/** GET — orders with status `ready` only (waiter's branch). Includes table_number, branch_name. */
export async function listReadyOrders(req, res) {
  if (!req.user.branch_id) {
    return res
      .status(403)
      .json({ error: "Waiter must be assigned to a branch" });
  }
  const query = supabaseAdmin
    .from("order")
    .select("*")
    .eq("branch_id", req.user.branch_id)
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(100);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  const enriched = await enrichOrdersWithContext(data || []);
  res.json({ data: enriched, next_cursor: null });
}

/** GET — order line items + modifiers for one order (waiter's branch only). */
export async function getOrderItems(req, res) {
  const { orderId } = req.params;
  if (!req.user.branch_id) {
    return res
      .status(403)
      .json({ error: "Waiter must be assigned to a branch" });
  }
  const { data: order, error: fetchErr } = await supabaseAdmin
    .from("order")
    .select("id, branch_id")
    .eq("id", orderId)
    .single();
  if (fetchErr || !order)
    return res.status(404).json({ error: "Order not found" });
  const { data: branch } = await supabaseAdmin
    .from("branch")
    .select("merchant_id")
    .eq("id", order.branch_id)
    .single();
  if (!branch || branch.merchant_id !== req.user.merchant_id) {
    return res.status(404).json({ error: "Order not found" });
  }
  if (String(order.branch_id) !== String(req.user.branch_id)) {
    return res.status(403).json({ error: "Access limited to your branch" });
  }
  const { data: orderItems, error: itemsErr } = await supabaseAdmin
    .from("order_items")
    .select("*")
    .eq("order_id", orderId);
  if (itemsErr) return res.status(500).json({ error: itemsErr.message });
  const itemsWithMods = [];
  for (const oi of orderItems || []) {
    const { data: mods } = await supabaseAdmin
      .from("order_item_modifier")
      .select("*")
      .eq("order_item_id", oi.id);
    itemsWithMods.push({ ...oi, modifiers: mods || [] });
  }
  res.json({ order_id: orderId, items: itemsWithMods });
}

/** PATCH — transition `ready` → `completed` for the waiter's branch. */
export async function completeReadyOrder(req, res) {
  const { orderId } = req.params;
  if (!req.user.branch_id) {
    return res
      .status(403)
      .json({ error: "Waiter must be assigned to a branch" });
  }
  const { data: order, error: fetchErr } = await supabaseAdmin
    .from("order")
    .select("id, status, branch_id")
    .eq("id", orderId)
    .single();
  if (fetchErr || !order)
    return res.status(404).json({ error: "Order not found" });
  const { data: branch } = await supabaseAdmin
    .from("branch")
    .select("merchant_id")
    .eq("id", order.branch_id)
    .single();
  if (!branch || branch.merchant_id !== req.user.merchant_id) {
    return res.status(404).json({ error: "Order not found" });
  }
  if (String(order.branch_id) !== String(req.user.branch_id)) {
    return res.status(403).json({ error: "Access limited to your branch" });
  }
  if (order.status !== "ready") {
    return res
      .status(400)
      .json({ error: "Order must be ready to mark as completed" });
  }
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("order")
    .update({ status: "completed", updated_at: now })
    .eq("id", orderId)
    .eq("status", "ready")
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  if (!data) {
    return res
      .status(409)
      .json({ error: "Order status changed; refresh and try again" });
  }
  res.json(data);
}
