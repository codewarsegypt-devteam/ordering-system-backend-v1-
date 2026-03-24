import { supabaseAdmin } from "../db_connection.js";
import {
  verifyTableTokenOrThrow,
  getActiveTableSession,
  toSessionResponse,
  assertSessionAccessOrThrow,
  SESSION_STATUS_CLOSED,
  SESSION_STATUS_ACTIVE,
  TERMINAL_ORDER_STATUSES,
} from "../lib/tableSessions.js";

function parseDateFilter(value, fieldName) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    const error = new Error(`${fieldName} must be a valid ISO timestamp`);
    error.status = 400;
    throw error;
  }
  return d.toISOString();
}

export async function getActiveByToken(req, res) {
  const { t: token } = req.query;
  if (!token) {
    return res.status(400).json({ error: "Token (t) required" });
  }

  let payload;
  try {
    payload = verifyTableTokenOrThrow(token);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  const {
    merchantId: tokenMerchantId,
    branchId: tokenBranchId,
    tableId: tokenTableId,
  } = payload;
  if (!tokenMerchantId || !tokenBranchId || !tokenTableId) {
    return res
      .status(400)
      .json({ error: "tokenMerchantId, tokenBranchId and tokenTableId required" });
  }

  const session = await getActiveTableSession(tokenTableId);
  if (!session) {
    return res.json({ active_session: null });
  }

  const { data: orders, error } = await supabaseAdmin
    .from("order")
    .select("id, order_number, status, total_price, display_total_price, created_at")
    .eq("table_session_id", session.id)
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  return res.json({
    active_session: toSessionResponse(session, orders || []),
    orders: orders || [],
  });
}

export async function getSessionOrders(req, res) {
  const { sessionId } = req.params;
  const { data: session, error: sessionErr } = await supabaseAdmin
    .from("table_session")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionErr) return res.status(500).json({ error: sessionErr.message });

  try {
    await assertSessionAccessOrThrow(session, req.user);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  const { data: orders, error } = await supabaseAdmin
    .from("order")
    .select("*")
    .eq("table_session_id", sessionId)
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  return res.json({
    session: toSessionResponse(session, orders || []),
    orders: orders || [],
  });
}

export async function listOpenSessions(req, res) {
  const {
    branch_id,
    table_id,
    opened_by_type,
    include_orders,
    limit = 50,
    from,
    to,
  } = req.query;
  const isBranchLocked = req.user.role === "cashier" || req.user.role === "kitchen";
  const includeOrders = String(include_orders).toLowerCase() === "true";
  const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 200);
  let fromIso;
  let toIso;
  try {
    fromIso = parseDateFilter(from, "from");
    toIso = parseDateFilter(to, "to");
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  if (fromIso && toIso && fromIso > toIso) {
    return res.status(400).json({ error: "'from' must be <= 'to'" });
  }

  let query = supabaseAdmin
    .from("table_session")
    .select("*")
    .eq("merchant_id", req.user.merchant_id)
    .eq("status", SESSION_STATUS_ACTIVE)
    .order("opened_at", { ascending: false })
    .limit(limitNum);

  if (isBranchLocked) {
    if (branch_id && String(branch_id) !== String(req.user.branch_id)) {
      return res.status(403).json({ error: "Access limited to your branch" });
    }
    query = query.eq("branch_id", req.user.branch_id);
  } else if (branch_id) {
    query = query.eq("branch_id", branch_id);
  }

  if (table_id) query = query.eq("table_id", table_id);
  if (opened_by_type) query = query.eq("opened_by_type", opened_by_type);
  if (fromIso) query = query.gte("opened_at", fromIso);
  if (toIso) query = query.lte("opened_at", toIso);

  const { data: sessions, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const sessionIds = (sessions || []).map((s) => s.id);
  if (!sessionIds.length) {
    return res.json({ data: [], count: 0 });
  }

  const { data: orders, error: ordersErr } = await supabaseAdmin
    .from("order")
    .select(
      "id, table_session_id, order_number, status, total_price, display_total_price, created_at",
    )
    .in("table_session_id", sessionIds)
    .order("created_at", { ascending: true });
  if (ordersErr) return res.status(500).json({ error: ordersErr.message });

  const ordersBySession = new Map();
  for (const order of orders || []) {
    const key = String(order.table_session_id);
    if (!ordersBySession.has(key)) ordersBySession.set(key, []);
    ordersBySession.get(key).push(order);
  }

  const data = (sessions || []).map((session) => {
    const sessionOrders = ordersBySession.get(String(session.id)) || [];
    const sessionSummary = toSessionResponse(session, sessionOrders);
    return includeOrders
      ? { ...sessionSummary, orders: sessionOrders }
      : sessionSummary;
  });

  return res.json({
    data,
    count: data.length,
  });
}

export async function listAllSessions(req, res) {
  const {
    branch_id,
    table_id,
    status,
    opened_by_type,
    include_orders,
    limit = 50,
    page = 1,
    from,
    to,
    sort_by = "opened_at",
    sort_dir = "desc",
  } = req.query;
  const isBranchLocked = req.user.role === "cashier" || req.user.role === "kitchen";
  const includeOrders = String(include_orders).toLowerCase() === "true";
  const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const pageNum = Math.max(Number(page) || 1, 1);
  const fromIndex = (pageNum - 1) * limitNum;
  const toIndex = fromIndex + limitNum - 1;
  const allowedSortFields = new Set(["opened_at", "closed_at", "created_at"]);
  const safeSortBy = allowedSortFields.has(String(sort_by))
    ? String(sort_by)
    : "opened_at";
  const safeSortDir = String(sort_dir).toLowerCase() === "asc" ? true : false;
  let fromIso;
  let toIso;
  try {
    fromIso = parseDateFilter(from, "from");
    toIso = parseDateFilter(to, "to");
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  if (fromIso && toIso && fromIso > toIso) {
    return res.status(400).json({ error: "'from' must be <= 'to'" });
  }

  let query = supabaseAdmin
    .from("table_session")
    .select("*", { count: "exact" })
    .eq("merchant_id", req.user.merchant_id)
    .order(safeSortBy, { ascending: safeSortDir })
    .range(fromIndex, toIndex);

  if (isBranchLocked) {
    if (branch_id && String(branch_id) !== String(req.user.branch_id)) {
      return res.status(403).json({ error: "Access limited to your branch" });
    }
    query = query.eq("branch_id", req.user.branch_id);
  } else if (branch_id) {
    query = query.eq("branch_id", branch_id);
  }

  if (table_id) query = query.eq("table_id", table_id);
  if (opened_by_type) query = query.eq("opened_by_type", opened_by_type);
  if (fromIso) query = query.gte("opened_at", fromIso);
  if (toIso) query = query.lte("opened_at", toIso);
  if (status) {
    const statuses = String(status)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (statuses.length === 1) query = query.eq("status", statuses[0]);
    if (statuses.length > 1) query = query.in("status", statuses);
  }

  const { data: sessions, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const sessionIds = (sessions || []).map((s) => s.id);
  const ordersBySession = new Map();
  if (sessionIds.length) {
    const { data: orders, error: ordersErr } = await supabaseAdmin
      .from("order")
      .select(
        "id, table_session_id, order_number, status, total_price, display_total_price, created_at",
      )
      .in("table_session_id", sessionIds)
      .order("created_at", { ascending: true });
    if (ordersErr) return res.status(500).json({ error: ordersErr.message });

    for (const order of orders || []) {
      const key = String(order.table_session_id);
      if (!ordersBySession.has(key)) ordersBySession.set(key, []);
      ordersBySession.get(key).push(order);
    }
  }

  const data = (sessions || []).map((session) => {
    const sessionOrders = ordersBySession.get(String(session.id)) || [];
    const sessionSummary = toSessionResponse(session, sessionOrders);
    return includeOrders
      ? { ...sessionSummary, orders: sessionOrders }
      : sessionSummary;
  });

  return res.json({
    data,
    count: count || 0,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total: count || 0,
      total_pages: count ? Math.ceil(count / limitNum) : 0,
      has_next: (count || 0) > pageNum * limitNum,
      has_prev: pageNum > 1,
    },
  });
}

export async function closeSession(req, res) {
  const { sessionId } = req.params;
  const { data: session, error: sessionErr } = await supabaseAdmin
    .from("table_session")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionErr) return res.status(500).json({ error: sessionErr.message });

  try {
    await assertSessionAccessOrThrow(session, req.user);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  if (session.status === SESSION_STATUS_CLOSED) {
    return res.status(400).json({ error: "Session is already closed" });
  }

  const { data: orders, error: ordersErr } = await supabaseAdmin
    .from("order")
    .select("id, status, total_price, display_total_price")
    .eq("table_session_id", sessionId);
  if (ordersErr) return res.status(500).json({ error: ordersErr.message });

  const openOrders = (orders || []).filter(
    (o) => !TERMINAL_ORDER_STATUSES.has(String(o.status || "").toLowerCase()),
  );
  if (openOrders.length > 0) {
    return res.status(409).json({
      error: "Cannot close session with non-terminal orders",
      open_orders_count: openOrders.length,
      open_order_ids: openOrders.map((o) => o.id),
    });
  }

  const { data: closed, error: closeErr } = await supabaseAdmin
    .from("table_session")
    .update({
      status: SESSION_STATUS_CLOSED,
      closed_at: new Date().toISOString(),
    })
    .eq("id", sessionId)
    .select("*")
    .single();
  if (closeErr) return res.status(400).json({ error: closeErr.message });

  return res.json({
    session: toSessionResponse(closed, orders || []),
    orders_count: (orders || []).length,
  });
}