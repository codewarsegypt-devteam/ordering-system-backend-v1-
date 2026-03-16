import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../db_connection.js";
import * as ordersController from "./orders.controller.js";
import bcrypt from "bcryptjs";
const JWT_TABLE_SECRET =
  process.env.JWT_TABLE_SECRET || process.env.JWT_SECRET || "dev-secret";

/** Get stored table QR code by table id (public, no auth). */
export async function getTableQrcodeByTableId(req, res) {
  const { tableId } = req.params;
  const { data, error } = await supabaseAdmin
    .from("tables_qrcode")
    .select("*")
    .eq("table_id", tableId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data)
    return res.status(404).json({ error: "QR code not found for this table" });
  res.json(data);
}

/**
 * أول حاجة تُستدعى بعد مسح الـ QR.
 * GET /public/scan?t=JWT_TOKEN
 * يرجع: merchant_id, branch_id, table_id, menus (قائمة المنيهات بدون تفاصيل categories/items).
 */

export async function   getScan(req, res) {
  const { t: token } = req.query;
  if (!token) {
    return res.status(400).json({
      error: "QR token (t) required. Use the URL from the scanned QR.",
    });
  }
  let payload;
  try {
    payload = jwt.verify(token, JWT_TABLE_SECRET);
  } catch {
    return res
      .status(400)
      .json({ error: "Invalid or expired QR code. Please scan again." });
  }
  const {
    tableId,
    merchantId: tokenMerchantId,
    tableCode: tokenTableCode,
  } = payload;
  if (!tableId || !tokenMerchantId) {
    return res.status(400).json({ error: "Invalid QR code payload." });
  }
  const { data: tbl, error: tblErr } = await supabaseAdmin
    .from("table")
    .select("id, branch_id, merchant_id, qr_code, is_active, number")
    .eq("id", tableId)
    .eq("merchant_id", tokenMerchantId)
    .eq("is_active", true)
    .maybeSingle();
  if (tblErr || !tbl) {
    return res.status(400).json({
      error: "Table not found or inactive. Please use a valid table QR.",
    });
  }
  if (tokenTableCode != null && tbl.qr_code !== tokenTableCode) {
    return res.status(400).json({
      error: "Table code mismatch. Please scan the correct table QR.",
    });
  }
  const merchantId = tokenMerchantId;
  const branch_id = tbl.branch_id;
  const table_id = tbl.id;

  const [merchantRes, branchRes, menusRes] = await Promise.all([
    supabaseAdmin
      .from("merchant")
      .select("name, logo, hexa_color_1, hexa_color_2")
      .eq("id", merchantId)
      .single(),
    supabaseAdmin.from("branch").select("name").eq("id", branch_id).single(),
    supabaseAdmin
      .from("menue")
      .select("*")
      .eq("merchant_id", merchantId)
      .eq("is_active", true)
      .order("created_at", { ascending: true }),
  ]);

  const { data: merchant } = merchantRes;
  const { data: branch } = branchRes;
  const { data: menus } = menusRes;

  res.json({
    merchant_id: merchantId,
    merchant_name: merchant?.name ?? null,
    merchant_logo: merchant?.logo ?? null,
    hexa_color_1: merchant?.hexa_color_1 ?? null,
    hexa_color_2: merchant?.hexa_color_2 ?? null,
    branch_id,
    branch_name: branch?.name ?? null,
    table_id,
    table_name: tbl.number != null ? String(tbl.number) : null,
    menus: menus || [],
  });
}

/**
 * Resolve merchant_id, branch_id, table_id from either:
 * - ?t=JWT_TOKEN (QR scan: token contains tableId, merchantId, tableCode — verified against DB)
 * - ?merchantId=xxx&tableCode=yyy (legacy)
 */
export async function getMenu(req, res) {
  const { t: token, merchantId: queryMerchantId, tableCode } = req.query;
  let merchantId = queryMerchantId;
  let branch_id = null;
  let table_id = null;

  if (token) {
    let payload;
    try {
      payload = jwt.verify(token, JWT_TABLE_SECRET);
    } catch {
      return res
        .status(400)
        .json({ error: "Invalid or expired QR code. Please scan again." });
    }
    const {
      tableId,
      merchantId: tokenMerchantId,
      tableCode: tokenTableCode,
    } = payload;
    if (!tableId || !tokenMerchantId) {
      return res.status(400).json({ error: "Invalid QR code payload." });
    }
    const { data: tbl, error: tblErr } = await supabaseAdmin
      .from("table")
      .select("id, branch_id, merchant_id, qr_code, is_active")
      .eq("id", tableId)
      .eq("merchant_id", tokenMerchantId)
      .eq("is_active", true)
      .maybeSingle();
    if (tblErr || !tbl) {
      return res.status(400).json({
        error: "Table not found or inactive. Please use a valid table QR.",
      });
    }
    if (tokenTableCode != null && tbl.qr_code !== tokenTableCode) {
      return res.status(400).json({
        error: "Table code mismatch. Please scan the correct table QR.",
      });
    }
    merchantId = tokenMerchantId;
    branch_id = tbl.branch_id;
    table_id = tbl.id;
  } else {
    if (!queryMerchantId)
      return res
        .status(400)
        .json({ error: "merchantId or QR token (t) required" });
    if (tableCode) {
      const { data: tbl } = await supabaseAdmin
        .from("table")
        .select("id, branch_id")
        .eq("qr_code", tableCode)
        .eq("is_active", true)
        .single();
      if (tbl) {
        table_id = tbl.id;
        branch_id = tbl.branch_id;
      }
    }
  }

  const { data: menu } = await supabaseAdmin
    .from("menue")
    .select("*")
    .eq("merchant_id", merchantId)
    .eq("is_active", true)
    .limit(1)
    .single();
  if (!menu) return res.status(404).json({ error: "Menu not found" });
  const { data: categories } = await supabaseAdmin
    .from("category")
    .select("*")
    .eq("menue_id", menu.id)
    .eq("is_active", true)
    .order("sort_order");
  const result = {
    merchant_id: merchantId,
    branch_id,
    table_id,
    menu,
    categories: [],
  };
  if (!categories?.length) return res.json(result);
  for (const cat of categories) {
    const { data: items } = await supabaseAdmin
      .from("item")
      .select("*")
      .eq("category_id", cat.id)
      .eq("status", "active");
    const itemsWithDetails = [];
    const itemIds = (items || []).map((i) => i.id);
    const { data: imagesRows } =
      itemIds.length > 0
        ? await supabaseAdmin
            .from("item_images")
            .select("item_id, img_url_1, img_url_2")
            .in("item_id", itemIds)
        : { data: [] };
    const imagesByItemId = {};
    for (const row of imagesRows || []) {
      imagesByItemId[row.item_id] = {
        img_url_1: row.img_url_1 ?? null,
        img_url_2: row.img_url_2 ?? null,
      };
    }
    for (const it of items || []) {
      const { data: variants } = await supabaseAdmin
        .from("item_variant")
        .select("*")
        .eq("item_id", it.id);
      const { data: imgLinks } = await supabaseAdmin
        .from("item_modifier_group")
        .select("*")
        .eq("item_id", it.id);
      const modifier_groups = [];
      if (imgLinks?.length) {
        for (const rule of imgLinks) {
          const { data: group } = await supabaseAdmin
            .from("modifier_group")
            .select("*")
            .eq("id", rule.modifier_group_id)
            .single();
          const { data: mods } = await supabaseAdmin
            .from("modifiers")
            .select("*")
            .eq("modifier_group_id", rule.modifier_group_id);
          modifier_groups.push({
            group: group || {},
            rule: { min_select: rule.min_select, max_select: rule.max_select },
            modifiers: mods || [],
          });
        }
      }
      itemsWithDetails.push({
        ...it,
        images: imagesByItemId[it.id] ?? { img_url_1: null, img_url_2: null },
        variants: variants || [],
        modifier_groups,
      });
    }
    result.categories.push({ ...cat, items: itemsWithDetails });
  }
  res.json(result);
}

/**
 * Get a single menu by id with full details (categories, items, variants, modifier_groups).
 * GET /public/menu/:menuId?t=TOKEN — التوكين مطلوب للأمان (من مسح الـ QR).
 */
export async function getMenuById(req, res) {
  const { menuId } = req.params;
  const { t: token } = req.query;

  if (!token) {
    return res
      .status(401)
      .json({ error: "Token (t) required. Scan the table QR first." });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_TABLE_SECRET);
  } catch {
    return res
      .status(401)
      .json({ error: "Invalid or expired QR code. Please scan again." });
  }

  const { tableId, merchantId: tokenMerchantId } = payload;

  if (!tableId || !tokenMerchantId) {
    return res.status(401).json({ error: "Invalid QR code payload." });
  }

  try {
    // نجيب table و menu مع بعض بدل sequential
    const [
      { data: tbl, error: tableErr },
      { data: menu, error: menuErr },
    ] = await Promise.all([
      supabaseAdmin
        .from("table")
        .select("id, merchant_id")
        .eq("id", tableId)
        .eq("merchant_id", tokenMerchantId)
        .eq("is_active", true)
        .maybeSingle(),

      supabaseAdmin
        .from("menue")
        .select("*")
        .eq("id", menuId)
        .eq("is_active", true)
        .maybeSingle(),
    ]);

    if (tableErr) {
      return res.status(500).json({ error: tableErr.message });
    }

    if (!tbl) {
      return res.status(401).json({
        error: "Table not found or inactive. Please use a valid table QR.",
      });
    }

    if (menuErr || !menu) {
      return res.status(404).json({ error: "Menu not found" });
    }

    if (menu.merchant_id !== tokenMerchantId) {
      return res
        .status(403)
        .json({ error: "You do not have access to this menu." });
    }

    // categories
    const { data: categories, error: categoriesErr } = await supabaseAdmin
      .from("category")
      .select("*")
      .eq("menue_id", menu.id)
      .eq("is_active", true)
      .order("sort_order");

    if (categoriesErr) {
      return res.status(500).json({ error: categoriesErr.message });
    }

    const result = {
      menu,
      categories: [],
    };

    if (!categories?.length) {
      return res.json(result);
    }

    const categoryIds = categories.map((c) => c.id);

    // هات كل items مرة واحدة
    const { data: items, error: itemsErr } = await supabaseAdmin
      .from("item")
      .select("*")
      .in("category_id", categoryIds)
      .eq("status", "active");

    if (itemsErr) {
      return res.status(500).json({ error: itemsErr.message });
    }

    const safeItems = items || [];
    const itemIds = safeItems.map((i) => i.id);

    // لو مفيش items رجّع categories فاضية
    if (!itemIds.length) {
      result.categories = categories.map((cat) => ({
        ...cat,
        items: [],
      }));
      return res.json(result);
    }

    // fetch bulk data in parallel
    const [
      { data: imagesRows, error: imagesErr },
      { data: variantsRows, error: variantsErr },
      { data: itemModifierLinks, error: linksErr },
    ] = await Promise.all([
      supabaseAdmin
        .from("item_images")
        .select("item_id, img_url_1, img_url_2")
        .in("item_id", itemIds),

      supabaseAdmin
        .from("item_variant")
        .select("*")
        .in("item_id", itemIds),

      supabaseAdmin
        .from("item_modifier_group")
        .select("*")
        .in("item_id", itemIds),
    ]);

    if (imagesErr) {
      return res.status(500).json({ error: imagesErr.message });
    }

    if (variantsErr) {
      return res.status(500).json({ error: variantsErr.message });
    }

    if (linksErr) {
      return res.status(500).json({ error: linksErr.message });
    }

    const safeLinks = itemModifierLinks || [];
    const groupIds = [...new Set(safeLinks.map((r) => r.modifier_group_id).filter(Boolean))];

    let modifierGroupsRows = [];
    let modifiersRows = [];

    if (groupIds.length) {
      const [
        { data: groupsData, error: groupsErr },
        { data: modifiersData, error: modifiersErr },
      ] = await Promise.all([
        supabaseAdmin
          .from("modifier_group")
          .select("*")
          .in("id", groupIds),

        supabaseAdmin
          .from("modifiers")
          .select("*")
          .in("modifier_group_id", groupIds),
      ]);

      if (groupsErr) {
        return res.status(500).json({ error: groupsErr.message });
      }

      if (modifiersErr) {
        return res.status(500).json({ error: modifiersErr.message });
      }

      modifierGroupsRows = groupsData || [];
      modifiersRows = modifiersData || [];
    }

    // -----------------------------
    // Build maps
    // -----------------------------

    const imagesByItemId = {};
    for (const row of imagesRows || []) {
      imagesByItemId[row.item_id] = {
        img_url_1: row.img_url_1 ?? null,
        img_url_2: row.img_url_2 ?? null,
      };
    }

    const variantsByItemId = {};
    for (const row of variantsRows || []) {
      if (!variantsByItemId[row.item_id]) variantsByItemId[row.item_id] = [];
      variantsByItemId[row.item_id].push(row);
    }

    const linksByItemId = {};
    for (const row of safeLinks) {
      if (!linksByItemId[row.item_id]) linksByItemId[row.item_id] = [];
      linksByItemId[row.item_id].push(row);
    }

    const groupById = {};
    for (const row of modifierGroupsRows) {
      groupById[row.id] = row;
    }

    const modifiersByGroupId = {};
    for (const row of modifiersRows) {
      if (!modifiersByGroupId[row.modifier_group_id]) {
        modifiersByGroupId[row.modifier_group_id] = [];
      }
      modifiersByGroupId[row.modifier_group_id].push(row);
    }

    const itemsByCategoryId = {};
    for (const item of safeItems) {
      const itemLinks = linksByItemId[item.id] || [];

      const modifier_groups = itemLinks.map((rule) => ({
        group: groupById[rule.modifier_group_id] || {},
        rule: {
          min_select: rule.min_select,
          max_select: rule.max_select,
        },
        modifiers: modifiersByGroupId[rule.modifier_group_id] || [],
      }));

      const itemWithDetails = {
        ...item,
        images: imagesByItemId[item.id] ?? {
          img_url_1: null,
          img_url_2: null,
        },
        variants: variantsByItemId[item.id] || [],
        modifier_groups,
      };

      if (!itemsByCategoryId[item.category_id]) {
        itemsByCategoryId[item.category_id] = [];
      }

      itemsByCategoryId[item.category_id].push(itemWithDetails);
    }

    result.categories = categories.map((cat) => ({
      ...cat,
      items: itemsByCategoryId[cat.id] || [],
    }));

    return res.json(result);
  } catch (err) {
    console.error("getMenuById error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export async function validateCart(req, res) {
  const { merchant_id, branch_id, table_id, items } = req.body || {};
  if (
    !merchant_id ||
    !branch_id ||
    !Array.isArray(items) ||
    items.length === 0
  ) {
    return res
      .status(400)
      .json({ error: "merchant_id, branch_id, and items required" });
  }
  const { data: branch } = await supabaseAdmin
    .from("branch")
    .select("merchant_id")
    .eq("id", branch_id)
    .single();
  if (!branch || branch.merchant_id !== merchant_id) {
    return res
      .status(400)
      .json({ error: "branch_id must belong to the given merchant_id" });
  }
  const errors = [];
  const line_items = [];
  let subtotal = 0;
  for (const line of items) {
    const { item_id, variant_id, quantity, modifiers } = line;
    const q = Number(quantity);
    if (!item_id || !Number.isFinite(q) || q < 1 || q > 100) {
      errors.push("Each item must have item_id and quantity between 1 and 100");
      continue;
    }
    const quantityValid = Math.min(100, Math.max(1, Math.floor(q)));
    const { data: item } = await supabaseAdmin
      .from("item")
      .select("*")
      .eq("id", item_id)
      .single();
    if (!item || item.merchant_id !== merchant_id) {
      errors.push(`Item ${item_id} not found`);
      continue;
    }
    if (item.status !== "active") {
      errors.push(`Item ${item.name_en} is not available`);
      continue;
    }
    if (Number(item.base_price) < 0) {
      errors.push(`Item ${item.name_en} has invalid price`);
      continue;
    }
    let unit_price = Number(item.base_price);
    if (variant_id) {
      const { data: variant } = await supabaseAdmin
        .from("item_variant")
        .select("*")
        .eq("id", variant_id)
        .eq("item_id", item_id)
        .single();
      if (!variant) {
        errors.push(`Variant ${variant_id} not found for item`);
        continue;
      }
      if (Number(variant.price) < 0) {
        errors.push(`Variant has invalid price for item ${item.name_en}`);
        continue;
      }
      unit_price = Number(variant.price);
    }
    const { data: imgLinks } = await supabaseAdmin
      .from("item_modifier_group")
      .select("*")
      .eq("item_id", item_id);
    const selectedModIds = (modifiers || []).map((m) => m.modifier_id);
    for (const rule of imgLinks || []) {
      const { data: mods } = await supabaseAdmin
        .from("modifiers")
        .select("id")
        .eq("modifier_group_id", rule.modifier_group_id);
      const inGroup = (mods || []).filter((m) => selectedModIds.includes(m.id));
      if (inGroup.length < rule.min_select) {
        errors.push(
          `Item ${item.name_en}: select at least ${rule.min_select} from modifier group`,
        );
      }
      if (inGroup.length > rule.max_select) {
        errors.push(
          `Item ${item.name_en}: select at most ${rule.max_select} from modifier group`,
        );
      }
    }
    let line_total = unit_price * quantityValid;
    let hasModError = false;
    const modSelections = modifiers || [];
    for (const sel of modSelections) {
      const { data: mod } = await supabaseAdmin
        .from("modifiers")
        .select("id, price")
        .eq("id", sel.modifier_id)
        .single();
      if (mod) {
        const modPrice = Number(mod.price);
        if (modPrice < 0) {
          errors.push(`Modifier has invalid price`);
          hasModError = true;
          break;
        }
        const selQty = Math.min(
          100,
          Math.max(1, Math.floor(Number(sel.quantity) || 1)),
        );
        line_total += modPrice * selQty * quantityValid;
      }
    }
    if (hasModError) continue;
    subtotal += line_total;
    line_items.push({
      item_id,
      variant_id: variant_id || null,
      unit_price,
      qty: quantityValid,
      line_total,
    });
  }
  const is_valid = errors.length === 0;
  res.json({
    is_valid,
    errors,
    totals: { subtotal, total: subtotal },
    line_items,
  });
}

/**
 * Create order (public). Accepts token (query ?t= or body t/token), notes, items.
 * Delegates to orders.controller.create which inserts order, order_items, order_item_modifier per schema.
 */
export async function createOrder(req, res) {
  const token = req.query.t || req.body?.t || req.body?.token;
  if (!token) {
    return res
      .status(401)
      .json({ error: "Token (t or token) required. Scan the table QR first." });
  }
  req.query = { ...req.query, t: token };
  return ordersController.create(req, res);
}

export async function createOwnerUser(req, res) {
  const { name, password, merchant_id } = req.body || {};
  if (!name || !password || !merchant_id) {
    return res.status(400).json({ error: "name, password and merchant_id required" });
  }
  const password_hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabaseAdmin.from("user").insert({
    name,
    password_hash,
    role:"owner",
    status:"active",
    merchant_id,
    branch_id:null,
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}