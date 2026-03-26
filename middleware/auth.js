import { verify } from "../lib/jwt.js";
import { supabaseAdmin } from "../db_connection.js";

/**
 * Require valid JWT and attach req.user (full user row).
 * For optional auth, use optionalAuth then check req.user.
 */
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Missing or invalid authorization" });
  }
  const decoded = verify(token);
  if (!decoded?.sub) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  const { data: user, error } = await supabaseAdmin
    .from("user")
    .select("*")
    .eq("id", decoded.sub)
    .single();
  if (error || !user) {
    return res.status(401).json({ error: "User not found" });
  }
  if (user.status !== "active") {
    return res.status(403).json({ error: "Account disabled" });
  }
  if (decoded.iat && user.password_changed_at) {
    const issuedMs = decoded.iat * 1000;
    const changedMs = new Date(user.password_changed_at).getTime();
    if (changedMs > issuedMs) {
      return res.status(401).json({ error: "Session expired" });
    }
  }
  req.user = user;
  next();
}

/**
 * Optional auth: set req.user if valid token present.
 */
export async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    req.user = null;
    return next();
  }
  const decoded = verify(token);
  if (!decoded?.sub) {
    req.user = null;
    return next();
  }
  const { data: user } = await supabaseAdmin
    .from("user")
    .select("*")
    .eq("id", decoded.sub)
    .single();
  let u = user && user.status === "active" ? user : null;
  if (u && decoded.iat && u.password_changed_at) {
    if (new Date(u.password_changed_at).getTime() > decoded.iat * 1000) {
      u = null;
    }
  }
  req.user = u;
  next();
}
// Role constants (from Roles spec: Owner, Manager, Cashier, Kitchen)
const MANAGER_ROLES = ["owner", "manager"];
const STAFF_ROLES = ["owner", "manager", "cashier", "kitchen"];

/** Require owner or manager (edit menu, view orders, change status, reports). */
export function requireManager(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (!MANAGER_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: "Manager or owner role required" });
  }
  next();
}

/** Require Owner only (manage users, edit branches, merchant). */
export function requireOwner(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (req.user.role !== "owner") {
    return res.status(403).json({ error: "Owner role required" });
  }
  next();
}

/** Require Owner or Manager — can edit menu (menues, categories, items, variants, modifiers). */
export function requireCanEditMenu(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (!MANAGER_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: "Cannot edit menu: owner or manager role required" });
  }
  next();
}

/** Require Owner only — can edit branches and tables. Manager cannot. */
export function requireCanEditBranches(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (req.user.role !== "owner") {
    return res.status(403).json({ error: "Cannot edit branches: owner role required" });
  }
  next();
}

/** Require Owner only — can manage users (create, update, delete). Manager cannot. */
export function requireCanManageUsers(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (req.user.role !== "owner") {
    return res.status(403).json({ error: "Cannot manage users: owner role required" });
  }
  next();
}

/** Require user to be assigned to a merchant (has merchant_id). Use after requireAuth. */
export function requireMerchant(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (req.user.merchant_id == null || req.user.merchant_id === "") {
    return res.status(403).json({ error: "User is not assigned to a merchant" });
  }
  next();
}

/** Require staff: Owner, Manager, Cashier, or Kitchen — see orders, change order status. */
export function requireStaff(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (!STAFF_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: "Staff role required" });
  }
  next();
}

export function requireCashier(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (req.user.role !== "cashier") {
    return res.status(403).json({ error: "Cashier role required" });
  }
  next();
}

export function requireKitchen(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (req.user.role !== "kitchen") {
    return res.status(403).json({ error: "Kitchen role required" });
  }
  next();
}

/** Require user's branch_id to match param branch_id (for cashier/kitchen). */
export function requireBranchAccess(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (MANAGER_ROLES.includes(req.user.role)) return next();
  const branchId = req.params.branchId || req.query.branch_id;
  if (!branchId || String(req.user.branch_id) !== String(branchId)) {
    return res.status(403).json({ error: "Access limited to your branch" });
  }
  next();
}
