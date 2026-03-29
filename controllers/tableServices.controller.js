import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../db_connection.js";

const JWT_TABLE_SECRET =
  process.env.JWT_TABLE_SECRET || process.env.JWT_SECRET || "dev-secret";

const SERVICE_TYPES = ["call_waiter", "request_bill", "other"];
const SERVICE_STATUSES = ["pending", "in_progress", "completed", "cancelled"];

function normalizeLimit(value) {
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return 50;
  return Math.min(Math.floor(limit), 100);
}

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

  const now = new Date().toISOString();
  const { data: row, error } = await supabaseAdmin
    .from("table_services")
    .insert({
      merchant_id,
      branch_id,
      table_id,
      type,
      status: "pending",
      updated_at: now,
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

/** يطبّق تاريخ من (بداية اليوم) أو إلى (نهاية اليوم). الصيغة: YYYY-MM-DD */
function normalizeDate(value, endOfDay = false) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed}${endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z"}`;
  }
  return trimmed;
}

/**
 * قائمة طلبات الخدمة (للستاف) مع فلترة.
 * GET /table-services?branch_id=&table_id=&status=&from=&to=&page=&limit=
 * from, to: YYYY-MM-DD (فلتر حسب created_at)
 */
export async function list(req, res) {
  const {
    branch_id,
    table_id,
    status,
    from: fromDate,
    to: toDate,
    page = 1,
    limit = 20,
  } = req.query;

  const merchant_id = req.user.merchant_id;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const fromIndex = (pageNum - 1) * limitNum;
  const toIndex = fromIndex + limitNum - 1;

  let scopedBranchId = branch_id || null;

  if (req.user.role === "cashier" || req.user.role === "kitchen") {
    if (!req.user.branch_id) {
      return res.status(403).json({ error: "Access limited to your branch" });
    }

    if (
      scopedBranchId &&
      String(scopedBranchId) !== String(req.user.branch_id)
    ) {
      return res.status(403).json({ error: "Access limited to your branch" });
    }

    scopedBranchId = req.user.branch_id;
  }

  let query = supabaseAdmin
    .from("table_services")
    .select(
      `
      id,
      merchant_id,
      branch_id,
      table_id,
      status,
      created_at,
      updated_at
    `,
      { count: "exact" },
    )
    .eq("merchant_id", merchant_id);

  if (scopedBranchId) query = query.eq("branch_id", scopedBranchId);
  if (table_id) query = query.eq("table_id", table_id);

  if (status) {
    const statuses = status
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (statuses.length) {
      query = query.in("status", statuses);
    }
  }

  const fromNormalized = normalizeDate(fromDate, false);
  const toNormalized = normalizeDate(toDate, true);

  if (fromNormalized) query = query.gte("created_at", fromNormalized);
  if (toNormalized) query = query.lte("created_at", toNormalized);

  query = query
    .order("created_at", { ascending: false })
    .range(fromIndex, toIndex);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const rows = data ?? [];
  const tableIds = [...new Set(rows.map((r) => r.table_id).filter(Boolean))];

  let tableById = new Map();

  if (tableIds.length > 0) {
    const { data: tables, error: tablesError } = await supabaseAdmin
      .from("table")
      .select("id, number")
      .in("id", tableIds);

    if (tablesError) {
      return res.status(500).json({ error: tablesError.message });
    }

    tableById = new Map((tables || []).map((t) => [String(t.id), t]));
  }

  const enriched = rows.map((r) => ({
    ...r,
    table_number:
      r.table_id != null
        ? (tableById.get(String(r.table_id))?.number ?? null)
        : null,
  }));

  const total = count ?? 0;

  return res.json({
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
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (updateErr) return res.status(400).json({ error: updateErr.message });
  const io = req.app?.get("io");
  if (io) {
    io.to(`branch:${existing.branch_id}`).emit("table_service:updated", {
      id: updated.id,
      branch_id: updated.branch_id,
      table_id: updated.table_id,
      type: updated.type,
      status: updated.status,
      updated_at: updated.updated_at ?? null,
    });
  }
  res.json(updated);
}

/**
 * GET /table-services/updates?after=<ISO>&branch_id=<optional>&limit=<optional>
 *
 * Delta polling endpoint. Returns only table service rows where updated_at > `after`.
 * Supports:
 *  - newly created service requests
 *  - status changes
 *  - any future updates
 */
export async function pollUpdates(req, res) {
  const { after, branch_id, limit } = req.query;

  if (!after) {
    return res.status(400).json({
      error:
        "'after' is required. Send an ISO 8601 timestamp (e.g. 2025-01-01T00:00:00.000Z).",
    });
  }
  const afterDate = new Date(after);
  if (isNaN(afterDate.getTime())) {
    return res.status(400).json({ error: "'after' must be a valid ISO 8601 timestamp." });
  }

  // Prevent accidental full table scans
  const MAX_LOOKBACK_HOURS = 24;
  const maxLookback = new Date(Date.now() - MAX_LOOKBACK_HOURS * 60 * 60 * 1000);
  if (afterDate < maxLookback) {
    return res.status(400).json({
      error: `'after' cannot be more than ${MAX_LOOKBACK_HOURS} hours in the past. Use GET /table-services for historical data.`,
    });
  }

  const limitNum = normalizeLimit(limit);

  const isBranchLocked = req.user.role === "cashier" || req.user.role === "kitchen";
  if (isBranchLocked) {
    if (branch_id && String(branch_id) !== String(req.user.branch_id)) {
      return res.status(403).json({ error: "Access limited to your branch" });
    }
  }

  let query = supabaseAdmin
    .from("table_services")
    .select("*")
    .eq("merchant_id", req.user.merchant_id)
    .gt("updated_at", afterDate.toISOString())
    .order("updated_at", { ascending: true })
    .limit(limitNum);

  if (isBranchLocked) {
    query = query.eq("branch_id", req.user.branch_id);
  } else if (branch_id) {
    query = query.eq("branch_id", branch_id);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const rows = data ?? [];
  const tableIds = [...new Set(rows.map((r) => r.table_id).filter(Boolean))];
  const { data: tables } =
    tableIds.length > 0
      ? await supabaseAdmin.from("table").select("id, number").in("id", tableIds)
      : { data: [] };
  const tableById = new Map((tables || []).map((t) => [String(t.id), t]));

  const enriched = rows.map((r) => ({
    ...r,
    table_number:
      r.table_id != null ? (tableById.get(String(r.table_id))?.number ?? null) : null,
  }));

  return res.json({
    items: enriched,
    server_time: new Date().toISOString(),
    count: enriched.length,
  });
}
