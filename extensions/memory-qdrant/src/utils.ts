import { createHash } from "node:crypto";

/**
 * Generate a numeric point ID safe for Qdrant from a hash input string.
 * Uses 53-bit masking (Number.MAX_SAFE_INTEGER) to avoid precision loss
 * when converting BigInt to Number.
 */
export function generatePointId(input: string): string {
  const hash = createHash("sha256").update(input).digest();
  const raw = hash.readBigUInt64BE(0);
  // Mask to 53 bits — Number.MAX_SAFE_INTEGER is 2^53 - 1
  const safe = Number(raw & BigInt("0x1FFFFFFFFFFFFF"));
  return safe.toString();
}

export function truncateSnippet(text: string, maxChars = 700): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars) + "...";
}
