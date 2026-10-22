// Executor tests (Phase 1A exit criteria, ARCHITECTURE-DETAIL.md §9.2-9.3).
// All PayPal handlers are mocks — the sandbox is never touched by tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../tests-dist/lib/db.js";
import { GuardianExecutor } from "../tests-dist/lib/executor.js";
import { decideApproval } from "../tests-dist/lib/approvals.js";

const MERCHANT = "sandbox-merchant";

function setup() {
  const store = createStore(":memory:");
  store.merchants.upsert({
    id: MERCHANT,
    profile_json: "{}",
    policy_yaml: "",
    created_at: new Date().toISOString(),
  });
  return { store, executor: new GuardianExecutor({ store }) };
}

function ledgerResults(store, tool) {
  return store
    .ledger.list(MERCHANT, 200)
    .filter((l) => l.tool === tool)
    .map((l) => JSON.parse(l.result_json ?? "{}"));
}

test("idempotency: the same write twice reaches the handler once", async () => {
  const { store, executor } = setup();
  let calls = 0;
  executor.register({
    name: "send_invoice",
    class: "WRITE",
    entityOf: (a) => a.invoice_id,
    handler: async (a) => {
      calls++;
      return { id: a.invoice_id, status: "SENT" };
    },
  });
  const args = { invoice_id: "INV2-TEST-001" };
  const r1 = await executor.execute("send_invoice", args, { actor: "coordinator" });
  const r2 = await executor.execute("send_invoice", args, { actor: "coordinator" });
  assert.equal(calls, 1, "PayPal handler must be called exactly once");
  assert.equal(r1.duplicate, false);
  assert.equal(r2.duplicate, true);
  assert.deepEqual(r2.data, r1.data);
  const successes = ledgerResults(store, "send_invoice").filter((r) => r.ok === true && !r.duplicate_suppressed);
  assert.equal(successes.length, 1);
});

test("sensitive gate: no approval -> blocked + ledgered; wrong args -> mismatch; approved -> executes once", async () => {
  const { store, executor } = setup();
  let calls = 0;
  executor.register({
    name: "create_refund",
    class: "SENSITIVE",
    entityOf: (a) => a.capture_id,
    handler: async () => {
      calls++;
      return { id: "RF-1", status: "COMPLETED" };
    },
  });
  const args = { capture_id: "CAP-1", amount: 10 };

  // 1) No approval: blocked, handler untouched, block written to the ledger,
  //    and a PENDING approval is created for the human.
  await assert.rejects(
    executor.execute("create_refund", args, { actor: "coordinator" }),
    (e) => e.code === "APPROVAL_REQUIRED"
  );
  assert.equal(calls, 0);
  const blocks = ledgerResults(store, "create_refund").filter((r) => r.blocked === "APPROVAL_REQUIRED");
  assert.equal(blocks.length, 1);
  const pending = store.approvals.list(MERCHANT, "PENDING");
  assert.equal(pending.length, 1);
  const approvalId = pending[0].id;

  // 2) Approval exists but args were tampered with: hash mismatch, blocked.
  await assert.rejects(
    executor.execute("create_refund", { capture_id: "CAP-1", amount: 999 }, { actor: "coordinator", approvalId }),
    (e) => e.code === "APPROVAL_MISMATCH"
  );
  assert.equal(calls, 0);
  const mismatches = ledgerResults(store, "create_refund").filter((r) => r.blocked === "APPROVAL_MISMATCH");
  assert.equal(mismatches.length, 1);

  // 3) Human approves the exact args: executes, approval flips to EXECUTED.
  decideApproval(store, approvalId, "approved", "merchant-ui");
  const r = await executor.execute("create_refund", args, { actor: "merchant-ui", approvalId });
  assert.equal(calls, 1);
  assert.equal(r.data.id, "RF-1");
  assert.equal(store.approvals.get(approvalId).status, "EXECUTED");

  // 4) The same approval cannot be spent twice.
  await assert.rejects(
    executor.execute("create_refund", args, { actor: "merchant-ui", approvalId }),
    (e) => e.code === "APPROVAL_ALREADY_EXECUTED"
  );
  assert.equal(calls, 1);
});

test("dismissed approval never executes", async () => {
  const { store, executor } = setup();
  let calls = 0;
  executor.register({
    name: "accept_dispute_claim",
    class: "SENSITIVE",
    entityOf: (a) => a.dispute_id,
    handler: async () => {
      calls++;
      return {};
    },
  });
  const args = { dispute_id: "PP-R-TEST" };
  await assert.rejects(
    executor.execute("accept_dispute_claim", args, { actor: "coordinator" }),
    (e) => e.code === "APPROVAL_REQUIRED"
  );
  const approvalId = store.approvals.list(MERCHANT, "PENDING")[0].id;
  decideApproval(store, approvalId, "dismissed", "merchant-ui");
  await assert.rejects(
    executor.execute("accept_dispute_claim", args, { actor: "merchant-ui", approvalId }),
    (e) => e.code === "APPROVAL_NOT_APPROVED"
  );
  assert.equal(calls, 0);
});

test("read-back mismatch flags RECONCILE_NEEDED and never re-runs the write", async () => {
  const { store, executor } = setup();
  let calls = 0;
  executor.register({
    name: "send_invoice",
    class: "WRITE",
    entityOf: (a) => a.invoice_id,
    handler: async () => {
      calls++;
      return { status: "SENT" };
    },
    readBack: async () => ({ status: "DRAFT" }), // PayPal still shows DRAFT
    expect: (rb) => rb.status === "SENT",
  });
  const r = await executor.execute("send_invoice", { invoice_id: "INV2-RB" }, { actor: "coordinator" });
  assert.equal(calls, 1);
  assert.equal(r.reconcileNeeded, true);
  assert.equal(store.ledger.byId(r.ledgerId).reconcile_flag, 1);
});

test("failed write is ledgered and not retried", async () => {
  const { store, executor } = setup();
  let calls = 0;
  executor.register({
    name: "create_invoice",
    class: "WRITE",
    entityOf: () => "new",
    handler: async () => {
      calls++;
      throw new Error("PayPal 500");
    },
  });
  await assert.rejects(
    executor.execute("create_invoice", { amount: 5 }, { actor: "coordinator" }),
    (e) => e.code === "TOOL_FAILED"
  );
  assert.equal(calls, 1);
  const failures = ledgerResults(store, "create_invoice").filter((r) => r.ok === false && r.error);
  assert.equal(failures.length, 1);
});
