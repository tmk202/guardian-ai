// Canonical JSON + hashing for approvals (ARCHITECTURE-DETAIL.md §5.5).
//
// An approval is bound to the exact (tool, args) it was granted for: the hash
// is computed over a canonical serialization (object keys sorted recursively)
// so the same logical args always produce the same hash, and any tampering
// with args after approval changes the hash and invalidates the approval.
import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(",")}}`;
}

export function hashToolArgs(tool: string, args: unknown): string {
  return createHash("sha256")
    .update(canonicalJson({ tool, args }))
    .digest("hex");
}
