import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../db_connection.js";

const JWT_TABLE_SECRET =
  process.env.JWT_TABLE_SECRET || process.env.JWT_SECRET || "dev-secret";

export const SESSION_STATUS_ACTIVE = "active";
export const SESSION_STATUS_CLOSED = "closed";
export const TERMINAL_ORDER_STATUSES = new Set(["completed", "cancelled"]);

export function verifyTableTokenOrThrow(token) {
  try {
    return jwt.verify(token, JWT_TABLE_SECRET);
  } catch (err) {
    const message =
      process.env.NODE_ENV === "development" && err?.message
        ? `Invalid token: ${err.message}`
        : "Invalid token";
    const error = new Error(message);
    error.status = 400;
    throw error;
  }
}

export async function getActiveTableSession(tableId) {
  const { data, error } = await supabaseAdmin
    .from("table_session")
    .select("*")
    .eq("table_id", tableId)
    .eq("status", SESSION_STATUS_ACTIVE)
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

export async function getOrCreateActiveTableSession({
  merchantId,
  branchId,
  tableId,
  openedByType = "customer",
}) {
  const existing = await getActiveTableSession(tableId);
  if (existing) return existing;

  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("table_session")
    .insert({
      merchant_id: merchantId,
      branch_id: branchId,
      table_id: tableId,
      status: SESSION_STATUS_ACTIVE,
      opened_at: now,
      opened_by_type: openedByType,
    })
    .select("*")
    .single();

  if (!error && data) return data;

  const raceResolved = await getActiveTableSession(tableId);
  if (raceResolved) return raceResolved;
  throw new Error(error?.message || "Failed to open table session");
}

export function toSessionResponse(session, orders = []) {
  const total_price = (orders || []).reduce(
    (sum, o) => sum + (Number(o.total_price) || 0),
    0,
  );
  const display_total_price = (orders || []).reduce(
    (sum, o) => sum + (Number(o.display_total_price) || 0),
    0,
  );
  const open_orders_count = (orders || []).filter(
    (o) => !TERMINAL_ORDER_STATUSES.has(String(o.status || "").toLowerCase()),
  ).length;

  return {
    ...session,
    orders_count: (orders || []).length,
    open_orders_count,
    total_price,
    display_total_price,
  };
}

export async function assertSessionAccessOrThrow(session, user) {
  if (!session || String(session.merchant_id) !== String(user.merchant_id)) {
    const error = new Error("Table session not found");
    error.status = 404;
    throw error;
  }
  if (
    (user.role === "cashier" || user.role === "kitchen") &&
    String(session.branch_id) !== String(user.branch_id)
  ) {
    const error = new Error("Access limited to your branch");
    error.status = 403;
    throw error;
  }
}
