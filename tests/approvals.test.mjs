// Approval lifecycle + policy tests (Phase 1B, ARCHITECTURE-DETAIL.md §5.3/§5.5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../tests-dist/lib/db.js";
import {
  createApproval,
  surfaceApproval,
  decideApproval,
  expireStaleApprovals,
  findPendingByHash,
} from "../tests-dist/lib/approvals.js";
import { hashToolArgs } from "../tests-dist/lib/hash.js";
import { loadPolicy, DEFAULT_POLICY } from "../tests-dist/lib/policy.js";

const MERCHANT = "sandbox-merchant";

function setup() {
  const store = createStore(":memory:");
  store.merchants.upsert({
    id: MERCHANT,
    profile_json: "{}",
    policy_yaml: "",
    created_at: new Date().toISOString(),
  });
  return store;
}

test("lifecycle: PROPOSED -> PENDING -> APPROVED, every step ledgered", () => {
  const store = setup();
  const a = createApproval(store, {
    merchantId: MERCHANT,
    tool: "provide_evidence",
    args: { dispute_id: "PP-R-1", evidences: [] },
    createdBy: "coordinator",
  });
  assert.equal(a.status, "PROPOSED");
  assert.equal(a.args_hash, hashToolArgs("provide_evidence", { dispute_id: "PP-R-1", evidences: [] }));
  surfaceApproval(store, a.id);
  assert.equal(store.approvals.get(a.id).status, "PENDING");
  const decided = decideApproval(store, a.id, "approved", "merchant-ui");
  assert.equal(decided.status, "APPROVED");
  assert.equal(decided.decided_by, "merchant-ui");
  assert.ok(decided.decided_at);
  // terminal for the decision step: deciding again is an error
  assert.throws(() => decideApproval(store, a.id, "approved", "merchant-ui"));
  const transitions = store
    .ledger.list(MERCHANT, 50)
    .filter((l) => l.kind === "approval")
    .map((l) => JSON.parse(l.result_json).to);
  assert.deepEqual(transitions.sort(), ["APPROVED", "PENDING", "PROPOSED"]);
});

test("expiry: stale PENDING flips to EXPIRED and can no longer be decided", () => {
  const store = setup();
  const past = new Date(Date.now() - 60_000).toISOString();
  const a = createApproval(store, {
    merchantId: MERCHANT,
    tool: "create_refund",
    args: { capture_id: "C1" },
    createdBy: "coordinator",
    expiresAt: past,
  });
  surfaceApproval(store, a.id);
  assert.equal(expireStaleApprovals(store, MERCHANT), 1);
  assert.equal(store.approvals.get(a.id).status, "EXPIRED");

  const b = createApproval(store, {
    merchantId: MERCHANT,
    tool: "create_refund",
    args: { capture_id: "C2" },
    createdBy: "coordinator",
    expiresAt: past,
  });
  surfaceApproval(store, b.id);
  assert.throws(() => decideApproval(store, b.id, "approved", "merchant-ui"), /expired/);
  assert.equal(store.approvals.get(b.id).status, "EXPIRED");
});

test("findPendingByHash dedupes identical pending approvals", () => {
  const store = setup();
  const args = { dispute_id: "PP-R-DUP", evidences: [{ evidence_type: "OTHER" }] };
  const a = createApproval(store, { merchantId: MERCHANT, tool: "provide_evidence", args, createdBy: "coordinator" });
  surfaceApproval(store, a.id);
  const found = findPendingByHash(store, MERCHANT, "provide_evidence", args);
  assert.equal(found?.id, a.id);
  const other = findPendingByHash(store, MERCHANT, "provide_evidence", { ...args, dispute_id: "PP-R-OTHER" });
  assert.equal(other, undefined);
});

test("policy: config/policy.yaml loads the agreed safe values", () => {
  const p = loadPolicy(); // reads <cwd>/config/policy.yaml (runner runs from repo root)
  assert.equal(p.approvals.default, "require_human");
  assert.equal(p.approvals.auto_below_usd, 0);
  assert.equal(p.approvals.expire_after_hours, 24);
  assert.equal(p.collections.max_rung, 3);
  assert.ok(p.notifications.instant.includes("dispute_new"));
});

test("policy: missing file falls back to built-in defaults", () => {
  const p = loadPolicy("/definitely/not/here/policy.yaml");
  assert.deepEqual(p, DEFAULT_POLICY);
});

test("store: all seven tables work, events dedupe by id", () => {
  const store = setup();
  assert.equal(store.merchants.count(), 1);
  const memId = store.memory.add({
    merchant_id: MERCHANT, kind: "D", entity_key: "note-1",
    body_json: "{}", source: "test", confidence: 1, superseded_by: null,
  });
  assert.ok(memId > 0);
  assert.equal(store.memory.list(MERCHANT, "D").length, 1);
  store.cases.upsert({ id: "PP-R-1", merchant_id: MERCHANT, body_json: "{}", deadline_at: null, status: "OPEN" });
  assert.equal(store.cases.get("PP-R-1").status, "OPEN");
  store.jobState.set({ job_name: "deadline_radar", merchant_id: MERCHANT, cursor_json: "{}", last_run_at: new Date().toISOString(), last_status: "ok" });
  assert.equal(store.jobState.get("deadline_radar", MERCHANT).last_status, "ok");
  assert.equal(store.events.add({ event_id: "EV-1", type: "CUSTOMER.DISPUTE.CREATED", payload_json: "{}", processed_at: null }), true);
  assert.equal(store.events.add({ event_id: "EV-1", type: "CUSTOMER.DISPUTE.CREATED", payload_json: "{}", processed_at: null }), false);
});
