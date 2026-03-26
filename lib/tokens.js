import crypto from "crypto";

export function generateUrlToken() {
  return crypto.randomBytes(32).toString("hex");
}

export function hashToken(plain) {
  return crypto.createHash("sha256").update(plain, "utf8").digest("hex");
}
