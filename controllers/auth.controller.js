import bcrypt from "bcryptjs";
import { supabaseAdmin } from "../db_connection.js";
import { sign } from "../lib/jwt.js";
import { toUserResponse } from "../lib/userResponse.js";
import { generateUrlToken, hashToken } from "../lib/tokens.js";
import { sendMail } from "../lib/mail.js";
import { publicApiBase } from "../lib/publicUrl.js";
import {
  buildPasswordResetEmail,
  buildVerificationEmail,
} from "../lib/emailTemplates.js";
import { normalizeEmail } from "../lib/email.js";

const VERIFY_MS = 48 * 60 * 60 * 1000;
const RESET_MS = 60 * 60 * 1000;

async function loadMerchantAndBranchNames(user) {
  const [merchantRes, branchRes] = await Promise.all([
    user.merchant_id
      ? supabaseAdmin
          .from("merchant")
          .select("name")
          .eq("id", user.merchant_id)
          .single()
      : Promise.resolve({ data: null }),
    user.branch_id
      ? supabaseAdmin
          .from("branch")
          .select("name")
          .eq("id", user.branch_id)
          .single()
      : Promise.resolve({ data: null }),
  ]);
  return {
    merchant_name: merchantRes.data?.name ?? null,
    branch_name: branchRes.data?.name ?? null,
  };
}

/**
 * POST /auth/signup — merchant + owner user, pending email verification.
 */
export async function signup(req, res) {
  const { name, password, merchant_name, email } = req.body || {};

  if (!name || !password || !merchant_name || !email) {
    return res
      .status(400)
      .json({ error: "name, password, merchant_name, and email required" });
  }

  const emailNorm = normalizeEmail(email);
  if (!emailNorm.includes("@")) {
    return res.status(400).json({ error: "Invalid email" });
  }

  // Block signup if this email exists on any user (case-insensitive; any status).
  const { data: existingRows, error: lookupErr } = await supabaseAdmin
    .from("user")
    .select("id")
    .ilike("email", emailNorm)
    .limit(1);

  if (lookupErr) return res.status(500).json({ error: lookupErr.message });
  if (existingRows?.length) {
    return res.status(409).json({ error: "Email already registered" });
  }

  const password_hash = await bcrypt.hash(password, 10);
  const { data: merchant, error: merchantErr } = await supabaseAdmin
    .from("merchant")
    .insert({ name: merchant_name })
    .select()
    .single();
  if (merchantErr) return res.status(400).json({ error: merchantErr.message });

  const { data: user, error: userErr } = await supabaseAdmin
    .from("user")
    .insert({
      name,
      email: emailNorm,
      password_hash,
      role: "owner",
      status: "pending_verification",
      merchant_id: merchant.id,
      branch_id: null,
    })
    .select()
    .single();

  if (userErr) {
    await supabaseAdmin.from("merchant").delete().eq("id", merchant.id);
    const dup =
      userErr.code === "23505" ||
      /duplicate|unique/i.test(userErr.message || "") ||
      /already exists/i.test(userErr.message || "");
    if (dup) {
      return res.status(409).json({ error: "Email already registered" });
    }
    return res.status(400).json({ error: userErr.message });
  }

  const plain = generateUrlToken();
  const token_hash = hashToken(plain);
  const expires_at = new Date(Date.now() + VERIFY_MS).toISOString();

  const { error: tokErr } = await supabaseAdmin
    .from("email_verification_tokens")
    .insert({
      user_id: user.id,
      token_hash,
      expires_at,
    });

  if (tokErr) {
    await supabaseAdmin.from("user").delete().eq("id", user.id);
    await supabaseAdmin.from("merchant").delete().eq("id", merchant.id);
    return res.status(500).json({ error: tokErr.message });
  }

  const verifyUrl = `${publicApiBase()}/auth/verify-email?token=${encodeURIComponent(plain)}`;
  await sendMail({
    to: emailNorm,
    ...buildVerificationEmail({ verifyUrl, recipientName: name }),
  });

  return res.status(201).json({
    message: "Check your email to verify your account.",
    merchant,
    user: toUserResponse(user),
  });
}

/**
 * GET /auth/verify-email?token=
 */
export async function verifyEmail(req, res) {
  const token = req.query?.token;
  if (!token || typeof token !== "string") {
    return res.status(400).json({ error: "token required" });
  }
  const token_hash = hashToken(token);
  const { data: row, error } = await supabaseAdmin
    .from("email_verification_tokens")
    .select("id, user_id, expires_at, used_at")
    .eq("token_hash", token_hash)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!row) return res.status(400).json({ error: "Invalid or expired token" });
  if (row.used_at) return res.status(400).json({ error: "Token already used" });
  if (new Date(row.expires_at) < new Date()) {
    return res.status(400).json({ error: "Token expired" });
  }

  const now = new Date().toISOString();
  const { error: uErr } = await supabaseAdmin
    .from("user")
    .update({
      status: "active",
      email_verified_at: now,
      updated_at: now,
    })
    .eq("id", row.user_id);

  if (uErr) return res.status(500).json({ error: uErr.message });

  await supabaseAdmin
    .from("email_verification_tokens")
    .update({ used_at: now })
    .eq("id", row.id);

  return res.json({ message: "Email verified. You can log in." });
}

/**
 * POST /auth/login — email + password only.
 * Requires active status and verified email.
 */
export async function login(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "email and password required" });
  }

  const { data: user, error } = await supabaseAdmin
    .from("user")
    .select("*")
    .eq("email", normalizeEmail(email))
    .single();
  if (error || !user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  if (user.status !== "active") {
    return res.status(403).json({ error: "Account not active" });
  }

  if (!user.email_verified_at) {
    return res.status(403).json({ error: "Email not verified" });
  }

  const now = new Date().toISOString();
  await supabaseAdmin
    .from("user")
    .update({ last_login_at: now })
    .eq("id", user.id);

  const names = await loadMerchantAndBranchNames(user);
  const access_token = sign({ sub: user.id, role: user.role });
  return res.json({
    access_token,
    user: toUserResponse(user),
    merchant_name: names.merchant_name,
    branch_name: names.branch_name,
  });
}

/**
 * POST /auth/resend-verification
 */
export async function resendVerification(req, res) {
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: "email required" });
  }
  const emailNorm = normalizeEmail(email);

  const { data: user, error } = await supabaseAdmin
    .from("user")
    .select("id, status, email_verified_at, name")
    .eq("email", emailNorm)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });

  if (!user) {
    return res.json({
      message: "If the account exists, a verification email was sent.",
    });
  }

  if (user.email_verified_at || user.status === "active") {
    return res.json({
      message: "Account is already verified. You can sign in.",
    });
  }

  if (user.status !== "pending_verification") {
    return res.json({
      message: "If the account exists, a verification email was sent.",
    });
  }

  const plain = generateUrlToken();
  const token_hash = hashToken(plain);
  const expires_at = new Date(Date.now() + VERIFY_MS).toISOString();

  await supabaseAdmin.from("email_verification_tokens").insert({
    user_id: user.id,
    token_hash,
    expires_at,
  });

  const verifyUrl = `${publicApiBase()}/auth/verify-email?token=${encodeURIComponent(plain)}`;
  await sendMail({
    to: emailNorm,
    ...buildVerificationEmail({ verifyUrl, recipientName: user.name }),
  });

  return res.json({
    message: "If the account exists, a verification email was sent.",
  });
}

/**
 * POST /auth/forgot-password
 */
export async function forgotPassword(req, res) {
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: "email required" });
  }
  const emailNorm = normalizeEmail(email);

  const { data: user } = await supabaseAdmin
    .from("user")
    .select("id, status")
    .eq("email", emailNorm)
    .maybeSingle();

  const generic = { message: "If the account exists, a reset link was sent." };
  if (!user || user.status !== "active") {
    return res.json(generic);
  }

  const plain = generateUrlToken();
  const token_hash = hashToken(plain);
  const expires_at = new Date(Date.now() + RESET_MS).toISOString();

  const { error: insErr } = await supabaseAdmin
    .from("password_reset_tokens")
    .insert({
      user_id: user.id,
      token_hash,
      expires_at,
    });
  if (insErr) return res.status(500).json({ error: insErr.message });

  const resetUrl = `${publicApiBase()}/auth/reset-password?token=${encodeURIComponent(plain)}`;
  await sendMail({
    to: emailNorm,
    ...buildPasswordResetEmail({ resetUrl }),
  });

  return res.json(generic);
}

/**
 * GET /auth/reset-password?token= — minimal HTML to POST new password (email links).
 */
export function resetPasswordPage(req, res) {
  const token = req.query?.token;
  if (!token || typeof token !== "string") {
    return res.status(400).type("html").send("<p>Missing token</p>");
  }
  const base = publicApiBase();
  const endpoint = `${base}/auth/reset-password`;
  res.type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reset password</title></head>
<body>
<p><strong>Reset password</strong></p>
<label>New password (min 8)</label><br/>
<input id="p" type="password" minlength="8" autocomplete="new-password" style="width:min(360px,100%)" />
<p><button type="button" id="b">Submit</button></p>
<script>
(function(){
  var endpoint = ${JSON.stringify(endpoint)};
  var token = ${JSON.stringify(token)};
  document.getElementById('b').onclick = async function() {
    var password = document.getElementById('p').value;
    if (!password || password.length < 8) { alert('Enter at least 8 characters'); return; }
    var r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token, password: password })
    });
    var j = await r.json().catch(function(){ return {}; });
    alert(j.message || j.error || ('HTTP ' + r.status));
  };
})();
</script>
</body></html>`);
}

/**
 * POST /auth/reset-password — body: token, password (or query token for SPA)
 */
export async function resetPassword(req, res) {
  const token = req.body?.token ?? req.query?.token;
  const password = req.body?.password;
  if (!token || typeof token !== "string" || !password) {
    return res.status(400).json({ error: "token and password required" });
  }

  const token_hash = hashToken(token);
  const { data: row, error } = await supabaseAdmin
    .from("password_reset_tokens")
    .select("id, user_id, expires_at, used_at")
    .eq("token_hash", token_hash)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!row) return res.status(400).json({ error: "Invalid or expired token" });
  if (row.used_at) return res.status(400).json({ error: "Token already used" });
  if (new Date(row.expires_at) < new Date()) {
    return res.status(400).json({ error: "Token expired" });
  }

  const password_hash = await bcrypt.hash(password, 10);
  const now = new Date().toISOString();

  const { error: uErr } = await supabaseAdmin
    .from("user")
    .update({
      password_hash,
      password_changed_at: now,
      updated_at: now,
    })
    .eq("id", row.user_id);

  if (uErr) return res.status(500).json({ error: uErr.message });

  await supabaseAdmin
    .from("password_reset_tokens")
    .update({ used_at: now })
    .eq("id", row.id);

  return res.json({ message: "Password updated. Sign in again." });
}

export function logout(req, res) {
  res.status(200).json({ message: "Logged out" });
}

export async function me(req, res) {
  const user = req.user;
  const names = await loadMerchantAndBranchNames(user);
  res.json({
    ...toUserResponse(user),
    merchant_name: names.merchant_name,
    branch_name: names.branch_name,
  });
}

/** Legacy: instant active owner (no email verification). Prefer POST /auth/signup. */
export async function register(req, res) {
  const { name, password, merchant_name, email } = req.body || {};
  if (!name || !password || !merchant_name || !email) {
    return res.status(400).json({
      error: "name, email, password, and merchant_name required",
    });
  }
  const emailNorm = normalizeEmail(email);
  if (!emailNorm.includes("@")) {
    return res.status(400).json({ error: "Invalid email" });
  }
  const { data: existingRows, error: lookupErr } = await supabaseAdmin
    .from("user")
    .select("id")
    .ilike("email", emailNorm)
    .limit(1);
  if (lookupErr) return res.status(500).json({ error: lookupErr.message });
  if (existingRows?.length) {
    return res.status(409).json({ error: "Email already registered" });
  }
  const password_hash = await bcrypt.hash(password, 10);
  const now = new Date().toISOString();
  const { data: merchant, error: merchantErr } = await supabaseAdmin
    .from("merchant")
    .insert({
      name: merchant_name,
    })
    .select()
    .single();
  if (merchantErr) return res.status(400).json({ error: merchantErr.message });
  const { data: user, error: userErr } = await supabaseAdmin
    .from("user")
    .insert({
      name,
      email: emailNorm,
      password_hash,
      role: "owner",
      status: "active",
      merchant_id: merchant.id,
      branch_id: null,
      email_verified_at: now,
      password_changed_at: now,
    })
    .select()
    .single();
  if (userErr) {
    await supabaseAdmin.from("merchant").delete().eq("id", merchant.id);
    const dup =
      userErr.code === "23505" ||
      /duplicate|unique/i.test(userErr.message || "");
    if (dup) {
      return res.status(409).json({ error: "Email already registered" });
    }
    return res.status(400).json({ error: userErr.message });
  }
  return res.status(201).json({
    merchant,
    user: toUserResponse(user),
  });
}
