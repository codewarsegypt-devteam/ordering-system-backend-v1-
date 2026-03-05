import QRCode from "qrcode";
import { supabaseAdmin } from "../db_connection.js";
import jwt from "jsonwebtoken";
const ALLOWED_UPDATE = ["number", "seats", "is_active", "qr_code"];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

export async function update(req, res) {
  const { tableId } = req.params;
  const updates = pick(req.body || {}, ALLOWED_UPDATE);
  if (Object.keys(updates).length === 0)
    return res.status(400).json({ error: "No valid fields to update" });
  const { data, error } = await supabaseAdmin
    .from("table")
    .update(updates)
    .eq("id", tableId)
    .eq("merchant_id", req.user.merchant_id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Table not found" });
  res.json(data);
}

export async function remove(req, res) {
  const { tableId } = req.params;
  // حذف البيانات المرتبطة (tables_qrcode) قبل حذف الطاولة
  await supabaseAdmin.from("tables_qrcode").delete().eq("table_id", tableId);
  const { error } = await supabaseAdmin
    .from("table")
    .delete()
    .eq("id", tableId)
    .eq("merchant_id", req.user.merchant_id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
}

export async function getQr(req, res) {
  const { tableId } = req.params;

  // 1) تأكد إن الترابيزة بتاعة نفس الميرشنت وفعالة
  const { data: row, error } = await supabaseAdmin
    .from("table")
    .select("qr_code, branch_id, merchant_id, is_active")
    .eq("id", tableId)
    .eq("merchant_id", req.user.merchant_id)
    .eq("is_active", true)
    .single();

  if (error || !row) return res.status(404).json({ error: "Table not found" });

  // 2) لو QR موجود في DB رجعه زي ما هو (ثابت)
  const { data: existing, error: qrErr } = await supabaseAdmin
    .from("tables_qrcode")
    .select("id, qr_svg, qr_url") // مهم
    .eq("table_id", tableId)
    .maybeSingle();

  if (qrErr) return res.status(500).json({ error: qrErr.message });

  if (existing?.qr_svg && existing?.qr_url) {
    return res.json({
      qr_url: existing.qr_url,
      qr_svg: existing.qr_svg,
      table_code: row.qr_code,
      branch_id: row.branch_id,
    });
  }

  // 3) لو مش موجود، اعمل واحد جديد مرة واحدة
  const baseUrl =
    process.env.MENU_FRONTEND_URL ||
    "https://online-merchant-ordering-system-fro.vercel.app";
    // "http://localhost:3000";
  // يفضل تحط tableCode + exp طويل
  const token = jwt.sign(
    { tableId, merchantId: row.merchant_id, tableCode: row.qr_code , branchId: row.branch_id},
    process.env.JWT_TABLE_SECRET
  );

  const qr_url = `${baseUrl}/menu?t=${token}`;

  let qr_svg;
  try {
    qr_svg = await QRCode.toString(qr_url, { type: "svg", margin: 2, width: 256 });
  } catch (err) {
    return res.status(500).json({
      error: "Failed to generate QR code",
      details: err?.message,
    });
  }

  await supabaseAdmin
    .from("tables_qrcode")
    .insert({ table_id: tableId, qr_svg, qr_url });

  return res.json({
    qr_url,
    qr_svg,
    table_code: row.qr_code,
    branch_id: row.branch_id,
  });
}
export async function getStoredQr(req, res) {
  const { tableId } = req.params;
  const { data, error } = await supabaseAdmin
    .from("tables_qrcode")
    .select("*")
    .eq("table_id", tableId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data)
    return res
      .status(404)
      .json({
        error:
          "QR code not found for this table. Generate it first via GET /tables/:tableId/qr",
      });
  res.json(data);
}
