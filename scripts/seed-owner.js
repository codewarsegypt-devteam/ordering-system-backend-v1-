/**
 * Seed one merchant and one owner user.
 * Run after applying supabase/schema.sql.
 * Uses OWNER_EMAIL for login, optional OWNER_NAME for display, OWNER_PASSWORD from .env.
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { supabaseAdmin } from "../db_connection.js";
import { normalizeEmail } from "../lib/email.js";

const email = normalizeEmail(process.env.OWNER_EMAIL || "owner@admin.com");
const name = process.env.OWNER_NAME || "Owner";
const password = process.env.OWNER_PASSWORD || "12345678";

async function seed() {
  if (!supabaseAdmin) {
    console.error("Supabase client not configured");
    process.exit(1);
  }
  const { data: existing } = await supabaseAdmin
    .from("user")
    .select("id")
    .ilike("email", email)
    .maybeSingle();
  if (existing) {
    console.log("Owner user already exists:", email);
    process.exit(0);
  }
  const { data: merchant, error: merr } = await supabaseAdmin
    .from("merchant")
    .insert({ name: "Default Merchant" })
    .select()
    .single();
  if (merr || !merchant) {
    console.error("Failed to create merchant:", merr?.message);
    process.exit(1);
  }
  const password_hash = await bcrypt.hash(password, 10);
  const now = new Date().toISOString();
  const { error: uerr } = await supabaseAdmin.from("user").insert({
    name,
    email,
    password_hash,
    merchant_id: merchant.id,
    branch_id: null,
    role: "owner",
    status: "active",
    email_verified_at: now,
    password_changed_at: now,
  });
  if (uerr) {
    console.error("Failed to create owner:", uerr.message);
    process.exit(1);
  }
  console.log("Seeded merchant and owner. Login with email:", email);
}

seed();
