// Instant alerts (ARCHITECTURE-DETAIL.md §5.3 notification policy + §6) —
// Phase 1D.
//
// Design choice (schema fit): alerts are ledger rows with kind "alert".
// The ledger is already the audit source of truth (§8), its `kind` column
// is plain TEXT, and every watcher (triage, deadline radar, reconcile
// sweep) needs the same "raise once, auditable forever" behaviour — so no
// new table is needed. UI/digest layers filter ledger kind = 'alert'.
import type { GuardianStore } from "./db";

export interface AlertInput {
  merchantId: string;
  /** who raised it: "triage" | "deadline-radar" | "reconcile" | … */
  actor: string;
  /** machine-readable alert name, stored in the ledger `tool` column */
  name: string;
  /** facts only — ids, amounts, deadlines; never secrets, never prose advice */
  payload: Record<string, unknown>;
}

/** Append an instant alert to the ledger. Returns the ledger row id. */
export function recordAlert(store: GuardianStore, input: AlertInput): number {
  return store.ledger.append({
    merchant_id: input.merchantId,
    actor: input.actor,
    kind: "alert",
    tool: input.name,
    result_json: JSON.stringify({ alert: true, urgency: "instant", ...input.payload }),
  });
}
