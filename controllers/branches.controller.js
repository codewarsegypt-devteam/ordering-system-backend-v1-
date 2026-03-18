import { randomBytes } from "crypto";
import { supabaseAdmin } from "../db_connection.js";

const ALLOWED_UPDATE = ["name", "address", "phone", "is_active"];

function generateTableCode() {
  return randomBytes(4).toString("hex").toUpperCase();
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

export async function create(req, res) {
  const { name, address, phone, is_active } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const { data, error } = await supabaseAdmin
    .from("branch")
    .insert({
      merchant_id: req.user.merchant_id,
      name,
      address: address ?? null,
      phone: phone ?? null,
      is_active: is_active !== false,
    })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}

export async function list(req, res) {
  const { data, error } = await supabaseAdmin
    .from("branch")
    .select("*")
    .eq("merchant_id", req.user.merchant_id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}

export async function update(req, res) {
  const { branchId } = req.params;
  const updates = pick(req.body || {}, ALLOWED_UPDATE);
  if (Object.keys(updates).length === 0)
    return res.status(400).json({ error: "No valid fields to update" });
  const { data, error } = await supabaseAdmin
    .from("branch")
    .update(updates)
    .eq("id", branchId)
    .eq("merchant_id", req.user.merchant_id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Branch not found" });
  res.json(data);
}

export async function remove(req, res) {
  const { branchId } = req.params;
  const { data: branch } = await supabaseAdmin
    .from("branch")
    .select("id")
    .eq("id", branchId)
    .eq("merchant_id", req.user.merchant_id)
    .single();
  if (!branch) {
    return res.status(404).json({ error: "Branch not found" });
  }
  const { data: tables } = await supabaseAdmin
    .from("table")
    .select("id")
    .eq("branch_id", branchId)
    .limit(1);
  if (tables?.length) {
    return res.status(409).json({
      error: "Cannot delete, has related data (tables)",
    });
  }
  const { data: orders } = await supabaseAdmin
    .from("order")
    .select("id")
    .eq("branch_id", branchId)
    .limit(1);
  if (orders?.length) {
    return res.status(409).json({
      error: "Cannot delete, has related data (orders)",
    });
  }
  const { error } = await supabaseAdmin
    .from("branch")
    .delete()
    .eq("id", branchId)
    .eq("merchant_id", req.user.merchant_id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
}

export async function createTable(req, res) {
  const { branchId } = req.params;
  const { number, seats, is_active, qr_code } = req.body || {};
  if (number === undefined || number === null) {
    return res.status(400).json({ error: "number required" });
  }
  const tableNumber = String(number).trim();
  if (!tableNumber) {
    return res.status(400).json({ error: "number required" });
  }
  const { data: branch } = await supabaseAdmin
    .from("branch")
    .select("merchant_id")
    .eq("id", branchId)
    .single();
  if (!branch || branch.merchant_id !== req.user.merchant_id) {
    return res.status(404).json({ error: "Branch not found" });
  }
  const code = qr_code ?? generateTableCode();
  const { data, error: tblErr } = await supabaseAdmin
    .from("table")
    .insert({
      merchant_id: branch.merchant_id,
      branch_id: branchId,
      // table.number is stored as string to support values like "A1", "VIP-3", etc.
      number: tableNumber,
      seats: seats ?? null,
      is_active: is_active !== false,
      qr_code: code,
    })
    .select()
    .single();
  if (tblErr) return res.status(400).json({ error: tblErr.message });
  res.status(201).json(data);
}

export async function listTables(req, res) {
  const { branchId } = req.params;
  const { data: branch, error: brErr } = await supabaseAdmin
    .from("branch")
    .select("merchant_id")
    .eq("id", branchId)
    .single();

  if (brErr || !branch || branch.merchant_id !== req.user.merchant_id) {
    return res.status(404).json({ error: "Branch not found" });
  }

  const { data, error: tblErr } = await supabaseAdmin
    .from("table")
    .select("*")
    .eq("branch_id", branchId)
    .order("number");
  if (tblErr) return res.status(500).json({ error: tblErr.message });
  res.json(data);
}
