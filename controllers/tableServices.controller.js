import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../db_connection.js";

const JWT_TABLE_SECRET =
  process.env.JWT_TABLE_SECRET || process.env.JWT_SECRET || "dev-secret";

const SERVICE_TYPES = ["call_waiter", "request_bill", "other"];
const SERVICE_STATUSES = ["pending", "in_progress", "completed", "cancelled"];

/**
 * استخراج وتحقين التوكين من الـ QR وتأكيد وجود الترابيزة والميرشنت.
 * يرجع { table_id, merchant_id, branch_id } أو يرمي/يرجع خطأ.
 */
async function resolveTableFromToken(token) {
  if (!token) {
    return { error: "Token (t) required. Scan the table QR first." };
  }
  let payload;
  try {
    payload = jwt.verify(token, JWT_TABLE_SECRET);
  } catch {
    return { error: "Invalid or expired QR code. Please scan again." };
  }
  const {
    tableId,
    merchantId: tokenMerchantId,
    branchId: tokenBranchId,
  } = payload;
  if (!tableId || !tokenMerchantId) {
    return { error: "Invalid QR code payload." };
  }

  const { data: tbl, error: tblErr } = await supabaseAdmin
    .from("table")
    .select("id, merchant_id, branch_id, is_active")
    .eq("id", tableId)
    .eq("merchant_id", tokenMerchantId)
    .eq("is_active", true)
    .maybeSingle();

  if (tblErr || !tbl) {
    return { error: "Table not found or inactive. Use a valid table QR." };
  }

  const { data: merchant } = await supabaseAdmin
    .from("merchant")
    .select("id")
    .eq("id", tokenMerchantId)
    .maybeSingle();
  if (!merchant) {
    return { error: "Merchant not found." };
  }

  const branch_id = tokenBranchId ?? tbl.branch_id;
  return {
    table_id: tbl.id,
    merchant_id: tbl.merchant_id,
    branch_id,
  };
}

/**
 * طلب مساعدة من الويتر (من واجهة العميل بعد سكان الـ QR).
 * POST /public/table-services
 * Body: { t?: token, type?: "call_waiter" | "request_bill" | "other" }
 * أو Query: ?t=TOKEN مع Body: { type: "..." }
 */

export async function createFromToken(req, res) {
  const token = req.body?.t ?? req.body?.token ?? req.query?.t;
  const type = (req.body?.type ?? "call_waiter").trim().toLowerCase();

  if (!SERVICE_TYPES.includes(type)) {
    return res.status(400).json({
      error: `type must be one of: ${SERVICE_TYPES.join(", ")}`,
    });
  }

  const resolved = await resolveTableFromToken(token);
  if (resolved.error) {
    const status = resolved.error.includes("Invalid") ? 401 : 400;
    return res.status(status).json({ error: resolved.error });
  }

  const { table_id, merchant_id, branch_id } = resolved;

  const { data: row, error } = await supabaseAdmin
    .from("table_services")
    .insert({
      merchant_id,
      branch_id,
      table_id,
      type,
      status: "pending",
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  const { data: tbl } = await supabaseAdmin
    .from("table")
    .select("number")
    .eq("id", table_id)
    .maybeSingle();

  const io = req.app?.get("io");
  if (io) {
    io.to(`branch:${branch_id}`).emit("table_service:created", {
      id: row.id,
      table_id,
      table_number: tbl?.number ?? null,
      branch_id,
      type,
      status: row.status,
      created_at: row.created_at,
    });
  }

  res.status(201).json({
    ...row,
    table_number: tbl?.number ?? null,
  });
}

/**
 * قائمة طلبات الخدمة (للستاف) مع فلترة.
 * GET /table-services?branch_id=&table_id=&status=&page=&limit=
 */
export async function list(req, res) {
  const { branch_id, table_id, status, page = 1, limit = 20 } = req.query;
  const merchant_id = req.user.merchant_id;

  if (req.user.role === "cashier" || req.user.role === "kitchen") {
    const scopeBranch = branch_id || req.user.branch_id;
    if (!scopeBranch || String(scopeBranch) !== String(req.user.branch_id)) {
      return res.status(403).json({ error: "Access limited to your branch" });
    }
  }

  let query = supabaseAdmin
    .from("table_services")
    .select("*", { count: "exact" })
    .eq("merchant_id", merchant_id);

  if (branch_id) query = query.eq("branch_id", branch_id);
  if (req.user.branch_id && (req.user.role === "cashier" || req.user.role === "kitchen")) {
    query = query.eq("branch_id", req.user.branch_id);
  }
  if (table_id) query = query.eq("table_id", table_id);
  if (status) {
    const statuses = status.split(",").map((s) => s.trim());
    query = query.in("status", statuses);
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const from = (pageNum - 1) * limitNum;
  const to = from + limitNum - 1;

  query = query
    .order("created_at", { ascending: false })
    .range(from, to);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const rows = data ?? [];
  const tableIds = [...new Set(rows.map((r) => r.table_id).filter(Boolean))];
  const { data: tables } =
    tableIds.length > 0
      ? await supabaseAdmin
          .from("table")
          .select("id, number")
          .in("id", tableIds)
      : { data: [] };
  const tableById = new Map((tables || []).map((t) => [String(t.id), t]));

  const enriched = rows.map((r) => ({
    ...r,
    table_number:
      r.table_id != null
        ? (tableById.get(String(r.table_id))?.number ?? null)
        : null,
  }));

  const total = count ?? 0;
  res.json({
    data: enriched,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      total_pages: total ? Math.ceil(total / limitNum) : 0,
    },
  });
}

/**
 * تغيير حالة الطلب (توجل ستاتس) — للستاف فقط.
 * PATCH /table-services/:id/status
 * Body: { status: "pending" | "in_progress" | "completed" | "cancelled" }
 */
export async function updateStatus(req, res) {
  const { id } = req.params;
  const { status } = req.body ?? {};

  if (!status || !SERVICE_STATUSES.includes(status)) {
    return res.status(400).json({
      error: `status must be one of: ${SERVICE_STATUSES.join(", ")}`,
    });
  }

  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from("table_services")
    .select("id, merchant_id, branch_id")
    .eq("id", id)
    .single();

  if (fetchErr || !existing) {
    return res.status(404).json({ error: "Service request not found" });
  }
  if (existing.merchant_id !== req.user.merchant_id) {
    return res.status(403).json({ error: "Not allowed for this merchant" });
  }

  if (req.user.role === "cashier" || req.user.role === "kitchen") {
    if (String(existing.branch_id) !== String(req.user.branch_id)) {
      return res.status(403).json({ error: "Access limited to your branch" });
    }
  }

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("table_services")
    .update({ status })
    .eq("id", id)
    .select()
    .single();

  if (updateErr) return res.status(400).json({ error: updateErr.message });
  res.json(updated);
}
