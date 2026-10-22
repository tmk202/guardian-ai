// Guardrail layer 2 — approval gate for sensitive actions.
//
// Rule (agreed with the user): anything that moves serious money, refunds a
// customer, or answers/accepts a dispute must be approved by the human first.
// The agent prepares the action; execution only happens after approval.
//
// V1 implementation is intentionally simple: an in-memory registry of
// pending actions. The chat route checks this registry before a wrapped tool
// executes; the UI renders pending actions as approval cards.

export type PendingAction = {
  id: string;
  toolName: string;
  summary: string;
  args: unknown;
  createdAt: number;
  status: "pending" | "approved" | "rejected";
};

const pending = new Map<string, PendingAction>();

// Tools that always need a human nod before they run.
export const SENSITIVE_TOOLS = new Set([
  "create_refund",
  "accept_dispute_claim",
  "provide_evidence", // custom tool in disputes.ts
  "pay_order",
]);

export function isSensitive(toolName: string): boolean {
  return SENSITIVE_TOOLS.has(toolName);
}

export function registerPending(action: Omit<PendingAction, "status" | "createdAt">): PendingAction {
  const full: PendingAction = { ...action, status: "pending", createdAt: Date.now() };
  pending.set(full.id, full);
  return full;
}

export function decide(id: string, approved: boolean): PendingAction | undefined {
  const action = pending.get(id);
  if (!action) return undefined;
  action.status = approved ? "approved" : "rejected";
  return action;
}

export function listPending(): PendingAction[] {
  return [...pending.values()].filter((a) => a.status === "pending");
}
