import { supabaseAdmin } from "../db_connection.js";

const ALLOWED_UPDATE = ["name", "logo", "hexa_color_1", "hexa_color_2", "status"];

export async function create(req, res) {
  const { name, logo, hexa_color_1, hexa_color_2 } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const { data, error } = await supabaseAdmin
    .from("merchant")
    .insert({ name, logo: logo ?? null, hexa_color_1: hexa_color_1 ?? null, hexa_color_2: hexa_color_2 ?? null })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}

export async function list(req, res) {
  const { data, error } = await supabaseAdmin
    .from("merchant")
    .select("*")
    .eq("id", req.user.merchant_id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ? [data] : []);
}

export async function update(req, res) {
  const { merchantId } = req.params;
  if (String(merchantId) !== String(req.user.merchant_id)) {
    return res.status(403).json({ error: "Can only update your own merchant" });
  }
  const updates = pick(req.body || {}, ALLOWED_UPDATE);
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No valid fields to update" });
  const { data, error } = await supabaseAdmin
    .from("merchant")
    .update(updates)
    .eq("id", merchantId)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Merchant not found" });
  res.json(data);
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
