import { supabaseAdmin } from "../db_connection.js";

export async function listOrders(req, res) {
  const { branch_id, status } = req.query;
  const branchId = branch_id || req.user.branch_id;
  if (
    req.user.role === "kitchen" &&
    String(branchId) !== String(req.user.branch_id)
  ) {
    return res.status(403).json({ error: "Access limited to your branch" });
  }
  let query = supabaseAdmin
    .from("order")
    .select("*")
    .eq("merchant_id", req.user.merchant_id)
    .in("status", ["placed", "accepted", "preparing", "ready"]);
  if (branchId) query = query.eq("branch_id", branchId);
  if (status)
    query = query.in(
      "status",
      status.split(",").map((s) => s.trim()),
    );
  query = query.order("created_at", { ascending: false }).limit(100);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [], next_cursor: null });
}
