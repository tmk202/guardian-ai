// Phase 1D tests: webhook intake (dedupe, verify gate), deterministic
// triage (§3.5), deadline radar milestones (§6), reconcile sweep (§6/1A.4),
// job-secret guard. All verifiers/handlers are stubs — PayPal is never
// called; the radar's dispute read is injected, never the executor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../tests-dist/lib/db.js";
import { handleWebhook, processEvent } from "../tests-dist/lib/webhooks.js";
import { triageEvent } from "../tests-dist/lib/triage.js";
import { runDeadlineRadar } from "../tests-dist/lib/jobs/deadline-radar.js";
import { runReconcileSweep } from "../tests-dist/lib/jobs/reconcile.js";
import { checkJobSecret } from "../tests-dist/lib/jobs/shared.js";

const MERCHANT = "sandbox-merchant";
const NOW = new Date("2026-10-22T12:00:00.000Z");

function setup() {
  const store = createStore(":memory:");
  store.merchants.upsert({
    id: MERCHANT,
    profile_json: "{}",
    policy_yaml: "",
    created_at: NOW.toISOString(),
  });
  return store;
}

function ledgerWhere(store, pred) {
  return store.ledger.list(MERCHANT, 500).filter(pred);
}

const DISPUTE_EVENT = {
  id: "WH-EVT-DISPUTE-1",
  event_type: "CUSTOMER.DISPUTE.CREATED",
  resource: {
    dispute_id: "PP-R-TEST-0001",
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    status: "OPEN",
    dispute_amount: { value: "120.00", currency_code: "USD" },
  },
};

const SCAM_INVOICE_EVENT = {
  id: "WH-EVT-INVOICE-1",
  event_type: "INVOICING.INVOICE.CREATED",
  resource: {
    id: "INV2-FAKE-0001",
    detail: {
      invoice_number: "INV-9999",
      note: "You have an unpaid invoice. To cancel this charge, call us at 1-888-555-0134 right away.",
    },
    amount: { value: "999.00", currency_code: "USD" },
  },
};

// --- (c) triage classification ---------------------------------------------

test("triage: new dispute is dispute_new + instant", () => {
  const r = triageEvent(DISPUTE_EVENT, { now: NOW });
  assert.equal(r.kind, "dispute_new");
  assert.equal(r.urgency, "instant");
  assert.ok(r.entity_ids.includes("PP-R-TEST-0001"));
  assert.ok(r.one_line.split(/\s+/).length <= 15);
});

test("triage: invoice whose note carries a phone number is scam_suspect + instant", () => {
  const r = triageEvent(SCAM_INVOICE_EVENT, { now: NOW });
  assert.equal(r.kind, "scam_suspect");
  assert.equal(r.urgency, "instant");
  assert.ok(r.entity_ids.includes("INV2-FAKE-0001"));
});

test("triage: dispute with a response deadline under 48h is deadline risk + instant", () => {
  const ev = {
    id: "WH-EVT-DISPUTE-2",
    event_type: "CUSTOMER.DISPUTE.UPDATED",
    resource: {
      dispute_id: "PP-R-TEST-0002",
      seller_response_due_date: new Date(NOW.getTime() + 30 * 3600_000).toISOString(),
    },
  };
  const r = triageEvent(ev, { now: NOW });
  assert.equal(r.kind, "dispute_deadline_risk");
  assert.equal(r.urgency, "instant");
});

test("triage: paid invoice goes to digest; unknown event is other/daily", () => {
  const paid = triageEvent(
    { id: "WH-EVT-PAID-1", event_type: "INVOICING.INVOICE.PAID", resource: { id: "INV2-OK-1" } },
    { now: NOW }
  );
  assert.equal(paid.kind, "invoice_paid");
  assert.equal(paid.urgency, "digest");
  const other = triageEvent({ id: "WH-X", event_type: "SOMETHING.NEW", resource: {} }, { now: NOW });
  assert.equal(other.kind, "other");
  assert.equal(other.urgency, "daily");
});

// --- (a) webhook dedupe ------------------------------------------------------

test("webhook: the same event_id fired twice is processed exactly once", async () => {
  const store = setup();
  const first = await handleWebhook(store, { headers: {}, event: DISPUTE_EVENT }, { mode: "unverified-dev", now: NOW });
  const second = await handleWebhook(store, { headers: {}, event: DISPUTE_EVENT }, { mode: "unverified-dev", now: NOW });
  assert.equal(first.status, 200);
  assert.equal(first.duplicate, false);
  assert.equal(second.status, 200);
  assert.equal(second.duplicate, true);
  // triage ran once, exactly one instant alert was raised
  assert.equal(ledgerWhere(store, (l) => l.tool === "webhook_triage").length, 1);
  assert.equal(ledgerWhere(store, (l) => l.kind === "alert").length, 1);
  // and the dev mode is disclosed in the ledger, not hidden
  const intake = ledgerWhere(store, (l) => l.tool === "webhook_intake");
  assert.ok(intake.length >= 1 && intake[0].result_json.includes("unverified-dev"));
  // inbox row is marked processed
  assert.ok(store.events.get(DISPUTE_EVENT.id)?.processed_at);
});

// --- (b) verify gate ----------------------------------------------------------

test("webhook: failed signature verification rejects the event and ledgers the rejection", async () => {
  const store = setup();
  const res = await handleWebhook(
    store,
    { headers: { transmissionId: "t-1" }, event: DISPUTE_EVENT },
    { mode: "paypal", verifier: async () => false }
  );
  assert.equal(res.status, 401);
  assert.equal(res.verification, "failed");
  assert.equal(store.events.get(DISPUTE_EVENT.id), undefined); // never inboxed
  const rejections = ledgerWhere(
    store,
    (l) => l.tool === "webhook_verify" && (l.result_json ?? "").includes("SIGNATURE_INVALID")
  );
  assert.equal(rejections.length, 1);
});

test("webhook: successful verification processes the event", async () => {
  const store = setup();
  const res = await handleWebhook(
    store,
    { headers: { transmissionId: "t-2" }, event: DISPUTE_EVENT },
    { mode: "paypal", verifier: async () => true, now: NOW }
  );
  assert.equal(res.status, 200);
  assert.equal(res.verification, "paypal");
  assert.equal(res.triage?.kind, "dispute_new");
});

test("processEvent: callable directly (queue-worker path) and dedupes too", async () => {
  const store = setup();
  const a = processEvent(store, DISPUTE_EVENT, { now: NOW });
  const b = processEvent(store, DISPUTE_EVENT, { now: NOW });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(a.triage?.urgency, "instant");
});

// --- (d) deadline radar ---------------------------------------------------------

function seedCase(store, { id, deadlineAt, body = {}, status = "OPEN" }) {
  store.cases.upsert({
    id,
    merchant_id: MERCHANT,
    body_json: JSON.stringify({ case_id: id, evidence_submitted: [], ...body }),
    deadline_at: deadlineAt,
    status,
  });
}

test("radar: case 30h from deadline alerts instant exactly once across two runs", async () => {
  const store = setup();
  seedCase(store, {
    id: "PP-R-RADAR-30H",
    deadlineAt: new Date(NOW.getTime() + 30 * 3600_000).toISOString(),
  });
  const run1 = await runDeadlineRadar(store, { now: NOW });
  const run2 = await runDeadlineRadar(store, { now: NOW });
  assert.equal(run1.alerts.length, 1);
  assert.equal(run1.alerts[0].milestone, "48h");
  assert.equal(run1.alerts[0].caseId, "PP-R-RADAR-30H");
  assert.equal(run2.alerts.length, 0); // deduped by job_state
  const alerts = ledgerWhere(
    store,
    (l) => l.kind === "alert" && (l.result_json ?? "").includes("PP-R-RADAR-30H")
  );
  assert.equal(alerts.length, 1);
});

test("radar: under 24h with no evidence fires the single final reminder; with evidence it does not", async () => {
  const store = setup();
  const dl = new Date(NOW.getTime() + 20 * 3600_000).toISOString();
  seedCase(store, { id: "PP-R-RADAR-BARE", deadlineAt: dl });
  seedCase(store, {
    id: "PP-R-RADAR-COVERED",
    deadlineAt: dl,
    body: { evidence_submitted: [{ type: "PROOF_OF_FULFILLMENT" }] },
  });
  const report = await runDeadlineRadar(store, { now: NOW });
  const bare = report.alerts.filter((a) => a.caseId === "PP-R-RADAR-BARE");
  const covered = report.alerts.filter((a) => a.caseId === "PP-R-RADAR-COVERED");
  assert.deepEqual(bare.map((a) => a.milestone).sort(), ["24h", "48h"]);
  assert.deepEqual(covered.map((a) => a.milestone), ["48h"]); // no 24h reminder: evidence exists
});

test("radar: missing deadline is fetched via the injected reader and persisted, never invented", async () => {
  const store = setup();
  seedCase(store, { id: "PP-R-RADAR-NODL", deadlineAt: null });
  const realDeadline = new Date(NOW.getTime() + 10 * 24 * 3600_000).toISOString();
  const report = await runDeadlineRadar(store, {
    now: NOW,
    readDispute: async () => ({ dispute_id: "PP-R-RADAR-NODL", seller_response_due_date: realDeadline }),
  });
  assert.deepEqual(report.deadlinesFetched, ["PP-R-RADAR-NODL"]);
  assert.equal(store.cases.get("PP-R-RADAR-NODL")?.deadline_at, realDeadline);
  // 10 days out: no milestone yet (digest starts at < 7 days)
  assert.equal(report.alerts.length, 0);
  assert.equal(report.digest.length, 0);

  const store2 = setup();
  seedCase(store2, { id: "PP-R-RADAR-NONE", deadlineAt: null });
  const report2 = await runDeadlineRadar(store2, {
    now: NOW,
    readDispute: async () => ({ dispute_id: "PP-R-RADAR-NONE" }), // PayPal payload has no deadline
  });
  assert.deepEqual(report2.unknownDeadline, ["PP-R-RADAR-NONE"]);
  assert.equal(store2.cases.get("PP-R-RADAR-NONE")?.deadline_at, null); // still unknown, not fabricated
});

// --- (e) reconcile sweep ---------------------------------------------------------

function flaggedRow(store, tool) {
  return store.ledger.append({
    merchant_id: MERCHANT,
    actor: "test",
    kind: "tool_call",
    tool,
    args_redacted_json: "{}",
    result_json: JSON.stringify({ ok: true }),
    reconcile_flag: true,
  });
}

test("reconcile: a matching read-back closes the flag", async () => {
  const store = setup();
  const id = flaggedRow(store, "send_invoice");
  const report = await runReconcileSweep(store, {
    now: NOW,
    readBacks: { send_invoice: async () => true },
  });
  assert.deepEqual(report.reconciled, [id]);
  assert.equal(store.ledger.byId(id)?.reconcile_flag, 0);
});

test("reconcile: still mismatched after 24h raises one instant alert and keeps the flag", async () => {
  const store = setup();
  const id = flaggedRow(store, "send_invoice");
  const later = new Date(NOW.getTime() + 25 * 3600_000);
  const run1 = await runReconcileSweep(store, {
    now: later,
    readBacks: { send_invoice: async () => false },
  });
  assert.deepEqual(run1.alerted, [id]);
  assert.deepEqual(run1.stillOff, [id]);
  assert.equal(store.ledger.byId(id)?.reconcile_flag, 1); // never cleared on a mismatch
  const run2 = await runReconcileSweep(store, {
    now: later,
    readBacks: { send_invoice: async () => false },
  });
  assert.deepEqual(run2.alerted, []); // alert deduped via job_state
  assert.equal(ledgerWhere(store, (l) => l.kind === "alert").length, 1);
});

// --- job-secret guard -------------------------------------------------------------

test("jobs: secret guard refuses when env is missing, rejects wrong, accepts right", () => {
  const saved = process.env.GUARDIAN_JOB_SECRET;
  try {
    delete process.env.GUARDIAN_JOB_SECRET;
    const missing = checkJobSecret("anything");
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 503);

    process.env.GUARDIAN_JOB_SECRET = "test-secret";
    assert.equal(checkJobSecret(null).ok, false);
    assert.equal(checkJobSecret("wrong").status, 401);
    assert.deepEqual(checkJobSecret("test-secret"), { ok: true });
  } finally {
    if (saved === undefined) delete process.env.GUARDIAN_JOB_SECRET;
    else process.env.GUARDIAN_JOB_SECRET = saved;
  }
});
