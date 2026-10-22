// Approval lifecycle (ARCHITECTURE-DETAIL.md §5.5) — Phase 1B.
//
// State machine: PROPOSED → PENDING → APPROVED → EXECUTED, with DISMISSED
// and EXPIRED as terminal exits from PENDING. Every transition is written to
// the ledger (kind "approval"). An approval is bound to hash(tool + args):
// if the args change, the hash no longer matches and the executor refuses
// to run (see executor.checkApproval).
//
// This module is the only writer of approval rows; the executor validates
// and consumes them.
import { randomUUID } from "node:crypto";
import type { ApprovalRow, ApprovalStatus, GuardianStore } from "./db";
import { hashToolArgs } from "./hash";
import { getPolicy } from "./policy";

export interface CreateApprovalInput {
  merchantId: string;
  tool: string;
  args: unknown;
  reason?: string | null;
  amountUsd?: number | null;
  createdBy: string;
  /** overrides policy expire_after_hours (tests use this) */
  expireHours?: number;
  expiresAt?: string;
}

function ledgerTransition(
  store: GuardianStore,
  row: ApprovalRow,
  from: ApprovalStatus | "NONE",
  to: ApprovalStatus,
  actor: string
): void {
  store.ledger.append({
    merchant_id: row.merchant_id,
    actor,
    kind: "approval",
    tool: row.tool,
    result_json: JSON.stringify({ approval_id: row.id, from, to }),
  });
}

export function createApproval(
  store: GuardianStore,
  input: CreateApprovalInput
): ApprovalRow {
  const policy = getPolicy();
  const created = new Date();
  const expiresAt =
    input.expiresAt ??
    new Date(
      created.getTime() +
        (input.expireHours ?? policy.approvals.expire_after_hours) * 3600_000
    ).toISOString();
  const row: ApprovalRow = {
    id: randomUUID(),
    merchant_id: input.merchantId,
    tool: input.tool,
    args_json: JSON.stringify(input.args),
    args_hash: hashToolArgs(input.tool, input.args),
    reason: input.reason ?? null,
    amount_usd: input.amountUsd ?? null,
    status: "PROPOSED",
    created_by: input.createdBy,
    decided_by: null,
    created_at: created.toISOString(),
    decided_at: null,
    expires_at: expiresAt,
  };
  store.approvals.insert(row);
  ledgerTransition(store, row, "NONE", "PROPOSED", input.createdBy);
  return row;
}

function mustGet(store: GuardianStore, id: string): ApprovalRow {
  const row = store.approvals.get(id);
  if (!row) throw new Error(`Approval ${id} not found`);
  return row;
}

/** PROPOSED → PENDING: the card is now visible to the human. */
export function surfaceApproval(store: GuardianStore, id: string): ApprovalRow {
  const row = mustGet(store, id);
  if (row.status !== "PROPOSED") {
    throw new Error(`Cannot surface approval in status ${row.status}`);
  }
  store.approvals.update(id, { status: "PENDING" });
  const updated = mustGet(store, id);
  ledgerTransition(store, updated, "PROPOSED", "PENDING", row.created_by);
  return updated;
}

export function decideApproval(
  store: GuardianStore,
  id: string,
  decision: "approved" | "dismissed",
  decidedBy: string
): ApprovalRow {
  const row = mustGet(store, id);
  if (row.status === "PENDING" && new Date(row.expires_at).getTime() < Date.now()) {
    store.approvals.update(id, { status: "EXPIRED" });
    const expired = mustGet(store, id);
    ledgerTransition(store, expired, "PENDING", "EXPIRED", "system");
    throw new Error("Approval has expired");
  }
  if (row.status !== "PENDING") {
    throw new Error(`Cannot decide approval in status ${row.status}`);
  }
  const to: ApprovalStatus = decision === "approved" ? "APPROVED" : "DISMISSED";
  store.approvals.update(id, {
    status: to,
    decided_by: decidedBy,
    decided_at: new Date().toISOString(),
  });
  const updated = mustGet(store, id);
  ledgerTransition(store, updated, "PENDING", to, decidedBy);
  return updated;
}

/** APPROVED → EXECUTED, called by the executor after a successful run. */
export function markExecuted(
  store: GuardianStore,
  id: string,
  ledgerId: number
): ApprovalRow {
  const row = mustGet(store, id);
  if (row.status !== "APPROVED") {
    throw new Error(`Cannot mark executed approval in status ${row.status}`);
  }
  store.approvals.update(id, { status: "EXECUTED" });
  const updated = mustGet(store, id);
  store.ledger.append({
    merchant_id: row.merchant_id,
    actor: "executor",
    kind: "approval",
    tool: row.tool,
    result_json: JSON.stringify({
      approval_id: id,
      from: "APPROVED",
      to: "EXECUTED",
      execution_ledger_id: ledgerId,
    }),
  });
  return updated;
}

/** Flip every stale PENDING approval to EXPIRED. Returns how many flipped. */
export function expireStaleApprovals(
  store: GuardianStore,
  merchantId: string
): number {
  const pending = store.approvals.list(merchantId, "PENDING");
  let n = 0;
  for (const row of pending) {
    if (new Date(row.expires_at).getTime() < Date.now()) {
      store.approvals.update(row.id, { status: "EXPIRED" });
      ledgerTransition(store, row, "PENDING", "EXPIRED", "system");
      n++;
    }
  }
  return n;
}

/**
 * An identical PENDING approval for the same tool+args (used by the chat
 * route so re-asking the same dispute question doesn't stack duplicate cards).
 */
export function findPendingByHash(
  store: GuardianStore,
  merchantId: string,
  tool: string,
  args: unknown
): ApprovalRow | undefined {
  const hash = hashToolArgs(tool, args);
  return store
    .approvals.list(merchantId, "PENDING")
    .find((a) => a.tool === tool && a.args_hash === hash);
}
