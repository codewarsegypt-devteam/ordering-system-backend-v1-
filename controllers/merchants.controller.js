import { supabaseAdmin } from "../db_connection.js";
import { uploadToR2, getKeyFromUrl, deleteFromR2 } from "../lib/r2Upload.js";
import { v4 as uuidv4 } from "uuid";

const ALLOWED_UPDATE = ["name", "logo", "hexa_color_1", "hexa_color_2", "status"];

function getExtension(mimetype) {
  const map = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  return map[mimetype] || "jpg";
}

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

/**
 * رفع لوجو الميرشنت.
 * POST /merchants/:merchantId/logo
 * Body: multipart/form-data, field name "logo" (image: JPEG, PNG, WebP, GIF — max 5 MB)
 */
export async function uploadLogo(req, res) {
  const { merchantId } = req.params;
  if (String(merchantId) !== String(req.user.merchant_id)) {
    return res.status(403).json({ error: "Can only upload logo for your own merchant" });
  }

  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: "No file uploaded. Send multipart/form-data with field name 'logo'." });
  }

  const { data: merchant, error: fetchErr } = await supabaseAdmin
    .from("merchant")
    .select("id, logo")
    .eq("id", merchantId)
    .single();
  if (fetchErr || !merchant) {
    return res.status(404).json({ error: "Merchant not found" });
  }

  let logoUrl;
  try {
    const ext = getExtension(file.mimetype);
    const key = `merchants/${merchantId}/${uuidv4()}.${ext}`;
    logoUrl = await uploadToR2(file.buffer, key, file.mimetype);
  } catch (err) {
    return res.status(500).json({ error: "Upload failed", details: err?.message });
  }

  const oldLogo = merchant.logo;
  if (oldLogo) {
    try {
      const oldKey = getKeyFromUrl(oldLogo);
      if (oldKey) await deleteFromR2(oldKey);
    } catch {
      // ignore delete failure
    }
  }

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("merchant")
    .update({ logo: logoUrl })
    .eq("id", merchantId)
    .select()
    .single();
  if (updateErr) return res.status(400).json({ error: updateErr.message });
  res.json(updated);
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

