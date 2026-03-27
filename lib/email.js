/** Normalize email for storage and lookup (lowercase, trimmed). */
export function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}
