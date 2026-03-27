import bcrypt from "bcryptjs";
import { supabaseAdmin } from "../db_connection.js";
import { normalizeEmail } from "../lib/email.js";
import { toUserResponse } from "../lib/userResponse.js";

const ROLES = ["owner", "manager", "cashier", "kitchen"];
const STATUSES = ["active", "disabled"];
const ALLOWED_UPDATE = ["name", "role", "branch_id"];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}



export async function create(req, res) {
  
  const merchant_id = req.user.merchant_id;

  const { name, email, password, role, branch_id, status } = req.body || {};
  if (!name || !email || !password || !role) {
    return res
      .status(400)
      .json({ error: "name, email, password, and role required" });
  }
  const emailNorm = normalizeEmail(email);
  if (!emailNorm.includes("@")) {
    return res.status(400).json({ error: "Invalid email" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "password must be at least 6 characters" });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }
  if (status !== undefined && !STATUSES.includes(status)) {
    return res.status(400).json({ error: "status must be active or disabled" });
  }
  const userStatus = status === undefined ? "active" : status;

  const { data: existingByEmail, error: emailLookupErr } = await supabaseAdmin
    .from("user")
    .select("id")
    .ilike("email", emailNorm)
    .limit(1);
  if (emailLookupErr) return res.status(500).json({ error: emailLookupErr.message });
  if (existingByEmail?.length) {
    return res.status(409).json({ error: "Email already registered" });
  }

  // Manager cannot do anything reserved for owner (e.g. create owner).
  if (req.user.role === "manager" && role === "owner") {
    return res.status(403).json({ error: "Manager cannot create owner" });
  }

  // منع تكرار الاسم داخل نفس التاجر (اختياري)
  const { data: existingByName, error: nameErr } = await supabaseAdmin
    .from("user")
    .select("id")
    .eq("merchant_id", merchant_id)
    .eq("name", name)
    .maybeSingle();

  if (nameErr) return res.status(500).json({ error: nameErr.message });
  if (existingByName) return res.status(400).json({ error: "User name already exists" });

  // لو عايز تمنع وجود owner أكتر من واحد
  if (role === "owner") {
    const { data: existingOwner, error: ownerErr } = await supabaseAdmin
      .from("user")
      .select("id")
      .eq("merchant_id", merchant_id)
      .eq("role", "owner")
      .maybeSingle();

    if (ownerErr) return res.status(500).json({ error: ownerErr.message });
    if (existingOwner) return res.status(400).json({ error: "Owner already exists" });
  }

  // branch validation
  if (branch_id != null) {
    const { data: br, error: brErr } = await supabaseAdmin
      .from("branch")
      .select("id")
      .eq("id", branch_id)
      .eq("merchant_id", merchant_id)
      .maybeSingle();

    if (brErr) return res.status(500).json({ error: brErr.message });
    if (!br) return res.status(400).json({ error: "Invalid branch_id" });
  }

  const password_hash = await bcrypt.hash(password, 10);
  const now = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from("user")
    .insert({
      name,
      email: emailNorm,
      password_hash,
      merchant_id,
      branch_id: branch_id ?? null,
      role,
      status: userStatus,
      email_verified_at: now,
      password_changed_at: now,
    })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  return res.status(201).json(toUserResponse(data));
}

export async function list(req, res) {
  const { data, error } = await supabaseAdmin
    .from("user")
    .select("*")
    .eq("merchant_id", req.user.merchant_id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(toUserResponse));
}

export async function getOne(req, res) {
  const { userId } = req.params;
  const { data, error } = await supabaseAdmin
    .from("user")
    .select("*")
    .eq("id", userId)
    .eq("merchant_id", req.user.merchant_id)
    .single();
  if (error || !data) return res.status(404).json({ error: "User not found" });
  res.json(toUserResponse(data));
}

export async function update(req, res) {
  const { userId } = req.params;
  const updates = pick(req.body || {}, ALLOWED_UPDATE);

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  if (updates.role && !ROLES.includes(updates.role)) {
    return res.status(400).json({ error: "Invalid role" });
  }

  // load target once
  const { data: target, error: tErr } = await supabaseAdmin
    .from("user")
    .select("id, role")
    .eq("id", userId)
    .eq("merchant_id", req.user.merchant_id)
    .maybeSingle();

  if (tErr) return res.status(500).json({ error: tErr.message });
  if (!target) return res.status(404).json({ error: "User not found" });

  // Manager cannot promote anyone to owner or update an owner user.
  if (req.user.role === "manager") {
    if (updates.role === "owner") {
      return res.status(403).json({ error: "Manager cannot set role to owner" });
    }
    if (target.role === "owner") {
      return res.status(403).json({ error: "Manager cannot update owner" });
    }
  }
if(req.user.role === "owner" ){
 if(updates.role === "owner"){
  return res.status(403).json({ error: "Owner cannot change role to owner" });
 }
}
  // Validate branch_id (if provided)
  if (updates.branch_id != null) {
    const { data: br, error: brErr } = await supabaseAdmin
      .from("branch")
      .select("id")
      .eq("id", updates.branch_id)
      .eq("merchant_id", req.user.merchant_id)
      .maybeSingle();

    if (brErr) return res.status(500).json({ error: brErr.message });
    if (!br) return res.status(400).json({ error: "Invalid branch_id" });
  }

  // Enforce name uniqueness per merchant (if name provided)
  if (updates.name) {
    const { data: conflict, error: cErr } = await supabaseAdmin
      .from("user")
      .select("id")
      .eq("merchant_id", req.user.merchant_id)
      .eq("name", updates.name)
      .neq("id", userId)
      .maybeSingle();

    if (cErr) return res.status(500).json({ error: cErr.message });
    if (conflict) {
      return res
        .status(400)
        .json({ error: "User name already exists in this merchant" });
    }
  }

  const { data, error } = await supabaseAdmin
    .from("user")
    .update(updates)
    .eq("id", userId)
    .eq("merchant_id", req.user.merchant_id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  return res.json(toUserResponse(data));
}

export async function updateStatus(req, res) {
  const { userId } = req.params;
  const { status } = req.body || {};
  if (!status || !STATUSES.includes(status)) {
    return res.status(400).json({ error: "status must be active or disabled" });
  }
  if (req.user.role === "manager" || req.user.role === "owner") {
    const { data: target } = await supabaseAdmin
      .from("user")
      .select("role")
      .eq("id", userId)
      .eq("merchant_id", req.user.merchant_id)
      .single();
    if (target?.role === "owner")
      return res.status(403).json({ error: "Manager cannot change owner status" });
  }
  const { data, error } = await supabaseAdmin
    .from("user")
    .update({ status })
    .eq("id", userId)
    .eq("merchant_id", req.user.merchant_id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "User not found" });
  res.json(toUserResponse(data));
}

export async function updatePassword(req, res) {
  const { userId } = req.params;
  const { password } = req.body || {};
  if (!password || password.length < 6) {
    return res
      .status(400)
      .json({ error: "password required, min 6 characters" });
  }
  if (req.user.role === "manager") {
    const { data: target } = await supabaseAdmin
      .from("user")
      .select("role")
      .eq("id", userId)
      .eq("merchant_id", req.user.merchant_id)
      .single();
    if (target?.role === "owner")
      return res.status(403).json({ error: "Manager cannot change owner password" });
  }
  const password_hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabaseAdmin
    .from("user")
    .update({ password_hash })
    .eq("id", userId)
    .eq("merchant_id", req.user.merchant_id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "User not found" });
  res.json(toUserResponse(data));
}

export async function updateBranch(req, res) {
  const { userId } = req.params;
  const { branch_id } = req.body || {};
  if (req.user.role === "manager") {
    const { data: target } = await supabaseAdmin
      .from("user")
      .select("role")
      .eq("id", userId)
      .eq("merchant_id", req.user.merchant_id)
      .single();
    if (target?.role === "owner")
      return res.status(403).json({ error: "Manager cannot change owner branch" });
  }
  const { data, error } = await supabaseAdmin
    .from("user")
    .update({ branch_id: branch_id ?? null })
    .eq("id", userId)
    .eq("merchant_id", req.user.merchant_id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "User not found" });
  res.json(toUserResponse(data));
}

export async function remove(req, res) {
  const { userId } = req.params;
  if (userId === req.user.id)
    return res.status(400).json({ error: "Cannot delete yourself" });
  if (req.user.role === "manager") {
    const { data: target } = await supabaseAdmin
      .from("user")
      .select("role")
      .eq("id", userId)
      .eq("merchant_id", req.user.merchant_id)
      .single();
    if (target?.role === "owner")
      return res.status(403).json({ error: "Manager cannot delete owner" });
  }
  const { error } = await supabaseAdmin
    .from("user")
    .delete()
    .eq("id", userId)
    .eq("merchant_id", req.user.merchant_id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
}
