/**
 * Checksum utilities for detecting changed records.
 * SHA-256 of a stable JSON representation (sorted keys).
 */

import { createHash } from "crypto";

/** Sort object keys recursively for stable serialization. */
function sortKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj !== null && typeof obj === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj as object).sort()) {
      sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

export function computeChecksum(data: unknown): string {
  const stable = JSON.stringify(sortKeys(data));
  return createHash("sha256").update(stable, "utf8").digest("hex").slice(0, 32);
}

/** Compute a URL hash (first 16 hex chars of SHA-256). */
export function hashUrl(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("hex").slice(0, 16);
}

/**
 * Returns true when the new checksum differs from the stored one.
 * If storedChecksum is null/undefined, always returns true (treat as changed).
 */
export function hasChanged(
  newChecksum: string,
  storedChecksum: string | null | undefined,
): boolean {
  return storedChecksum == null || storedChecksum !== newChecksum;
}
