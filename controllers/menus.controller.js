import { supabaseAdmin } from "../db_connection.js";
import { uploadToR2, getKeyFromUrl, deleteFromR2 } from "../lib/r2Upload.js";
import { v4 as uuidv4 } from "uuid";

// NOTE: `currancy` column is legacy and will be removed later.
// Do not rely on it for new features.
const ALLOWED_UPDATE = ["name_ar", "name_en", "is_active"];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

export async function create(req, res) {
  const { name_ar, name_en, currancy, is_active } = req.body || {};
  if (!name_ar || !name_en || !currancy) {
    return res.status(400).json({ error: "name_ar, name_en, and currancy required" });
  }
  const { data, error } = await supabaseAdmin
    .from("menue")
    .insert({
      merchant_id: req.user.merchant_id,
      name_ar,
      name_en,
      currancy: currancy || "EGP",
      is_active: is_active !== false,
    })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}

export async function list(req, res) {
  const { data, error } = await supabaseAdmin
    .from("menue")
    .select("*")
    .eq("merchant_id", req.user.merchant_id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}

export async function update(req, res) {
  const { menuId } = req.params;
  const updates = pick(req.body || {}, ALLOWED_UPDATE);
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No valid fields to update" });
  const { data, error } = await supabaseAdmin
    .from("menue")
    .update(updates)
    .eq("id", menuId)
    .eq("merchant_id", req.user.merchant_id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Menu not found" });
  res.json(data);
}

export async function remove(req, res) {
  const { menuId } = req.params;
  const { error } = await supabaseAdmin
    .from("menue")
    .delete()
    .eq("id", menuId)
    .eq("merchant_id", req.user.merchant_id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
}

export async function createCategory(req, res) {
  const { menuId } = req.params;
  const { name_ar, name_en, description_ar, description_en, sort_order, img_url_1, is_active } = req.body || {};
  if (!name_ar || !name_en) return res.status(400).json({ error: "name_ar and name_en required" });
  const { data: menu } = await supabaseAdmin.from("menue").select("merchant_id").eq("id", menuId).single();
  if (!menu || menu.merchant_id !== req.user.merchant_id) {
    return res.status(404).json({ error: "Menu not found" });
  }
  const { data, error } = await supabaseAdmin
    .from("category")
    .insert({
      merchant_id: menu.merchant_id,
      menue_id: menuId,
      name_ar,
      name_en,
      description_ar: description_ar ?? null,
      description_en: description_en ?? null,
      sort_order: sort_order ?? 0,
      img_url_1: img_url_1 ?? null,
      is_active: is_active !== false,
    })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}

export async function listCategories(req, res) {
  const { menuId } = req.params;
  const { data, error } = await supabaseAdmin
    .from("category")
    .select("*")
    .eq("menue_id", menuId)
    .order("sort_order");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}
// make arout for this function
export async function listShortCategories(req, res) {
  const { menuId } = req.params;
  const { data, error } = await supabaseAdmin
    .from("category")
    .select("id, name_ar, name_en")
    .eq("menue_id", menuId)
    .order("sort_order");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}

function getExtension(mimetype) {
  const map = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  return map[mimetype] || "jpg";
}

/**
 * POST /menus/:menuId/image
 * Body: multipart/form-data, field name "image"
 *
 * Upload or replace the menu cover image. Stores the public URL in menue.img_url_1.
 */
export async function uploadMenuImage(req, res) {
  const { menuId } = req.params;

  const file = req.file;
  if (!file) {
    return res.status(400).json({
      error: "No file uploaded. Send multipart/form-data with field name 'image'.",
    });
  }

  // Ensure menu belongs to this merchant
  const { data: menu, error: fetchErr } = await supabaseAdmin
    .from("menue")
    .select("id, merchant_id, img_url_1")
    .eq("id", menuId)
    .single();

  if (fetchErr || !menu || menu.merchant_id !== req.user.merchant_id) {
    return res.status(404).json({ error: "Menu not found" });
  }

  // Upload new image to R2
  let imageUrl;
  try {
    const ext = getExtension(file.mimetype);
    const key = `menus/${menuId}/${uuidv4()}.${ext}`;
    imageUrl = await uploadToR2(file.buffer, key, file.mimetype);
  } catch (err) {
    return res.status(500).json({
      error: "Upload failed",
      details: err?.message,
    });
  }

  // Best-effort delete of the old image, if any
  if (menu.img_url_1) {
    try {
      const oldKey = getKeyFromUrl(menu.img_url_1);
      if (oldKey) await deleteFromR2(oldKey);
    } catch {
      // ignore delete failure
    }
  }

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("menue")
    .update({ img_url_1: imageUrl })
    .eq("id", menuId)
    .eq("merchant_id", req.user.merchant_id)
    .select()
    .single();

  if (updateErr) {
    return res.status(400).json({ error: updateErr.message });
  }

  return res.json(updated);
}

/**
 * DELETE /menus/:menuId/image
 *
 * Remove the menu cover image and clear menue.img_url_1.
 */
export async function deleteMenuImage(req, res) {
  const { menuId } = req.params;

  const { data: menu, error: fetchErr } = await supabaseAdmin
    .from("menue")
    .select("id, merchant_id, img_url_1")
    .eq("id", menuId)
    .single();

  if (fetchErr || !menu || menu.merchant_id !== req.user.merchant_id) {
    return res.status(404).json({ error: "Menu not found" });
  }

  if (menu.img_url_1) {
    try {
      const oldKey = getKeyFromUrl(menu.img_url_1);
      if (oldKey) await deleteFromR2(oldKey);
    } catch {
      // ignore delete failure
    }
  }

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("menue")
    .update({ img_url_1: null })
    .eq("id", menuId)
    .eq("merchant_id", req.user.merchant_id)
    .select()
    .single();

  if (updateErr) {
    return res.status(400).json({ error: updateErr.message });
  }

  return res.json(updated);
}