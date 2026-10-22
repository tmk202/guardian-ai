// Store contract suite (Phase 2A) — the SAME behavioural contract run
// against BOTH GuardianStore implementations: SQLite (:memory:) and
// Postgres (local guardian_test DB). Any behaviour that differs between
// the two backends fails here, which is the whole point of the shared
// interface: callers must never be able to tell which store is behind it.
// The Postgres half skips (loudly) only if no test DB is reachable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../tests-dist/lib/db.js";
import { PgGuardianStore } from "../tests-dist/lib/db-pg.js";

const PG_URL =
  process.env.GUARDIAN_TEST_PG_URL ||
  "postgres://postgres:postgres@127.0.0.1:5432/guardian_test";

let seq = 0;
function freshMerchant() {
  return `contract-${Date.now()}-${++seq}`;
}

function runContract(label, makeStore) {
  test(`${label}: merchants upsert/get/update`, () => {
    const store = makeStore();
    const id = freshMerchant();
    assert.equal(store.merchants.get(id), undefined);
    store.merchants.upsert({
      id,
      profile_json: JSON.stringify({ v: 1 }),
      policy_yaml: "a: 1",
      created_at: new Date().toISOString(),
    });
    assert.equal(JSON.parse(store.merchants.get(id).profile_json).v, 1);
    store.merchants.upsert({
      id,
      profile_json: JSON.stringify({ v: 2 }),
      policy_yaml: "a: 2",
      created_at: new Date().toISOString(),
    });
    assert.equal(JSON.parse(store.merchants.get(id).profile_json).v, 2);
    assert.ok(store.merchants.count() >= 1);
    store.close();
  });

  test(`${label}: memory add/list/update (supersede fields)`, () => {
    const store = makeStore();
    const m = freshMerchant();
    const id1 = store.memory.add({
      merchant_id: m, kind: "A", entity_key: "profile",
      body_json: JSON.stringify({ name: "Shop" }), source: "test",
      confidence: 1, superseded_by: null,
    });
    assert.equal(typeof id1, "number");
    const id2 = store.memory.add({
      merchant_id: m, kind: "A", entity_key: "profile",
      body_json: JSON.stringify({ name: "Shop v2" }), source: "test",
      confidence: 1, superseded_by: null,
    });
    store.memory.update(id1, { superseded_by: id2 });
    const all = store.memory.list(m, "A");
    assert.equal(all.length, 2);
    assert.equal(all.find((e) => e.id === id1).superseded_by, id2);
    assert.equal(store.memory.list(m, "C").length, 0);
    store.close();
  });

  test(`${label}: cases upsert/get/list`, () => {
    const store = makeStore();
    const m = freshMerchant();
    const caseId = `PP-R-CONTRACT-${m}`; // run-unique: PG test DB persists across runs
    store.cases.upsert({
      id: caseId, merchant_id: m, body_json: "{}",
      deadline_at: "2026-11-01T00:00:00.000Z", status: "UNDER_REVIEW",
    });
    assert.equal(store.cases.get(caseId).status, "UNDER_REVIEW");
    store.cases.upsert({
      id: caseId, merchant_id: m, body_json: "{}",
      deadline_at: "2026-11-02T00:00:00.000Z", status: "RESOLVED",
    });
    assert.equal(store.cases.get(caseId).status, "RESOLVED");
    assert.equal(store.cases.list(m).length, 1);
    assert.equal(store.cases.list(freshMerchant()).length, 0);
    store.close();
  });

  test(`${label}: approvals insert/get/update/list-by-status`, () => {
    const store = makeStore();
    const m = freshMerchant();
    const row = {
      id: `appr-${m}`, merchant_id: m, tool: "create_refund",
      args_json: "{}", args_hash: "h1", reason: "test", amount_usd: 12.5,
      status: "PENDING", created_by: "coordinator", decided_by: null,
      created_at: new Date().toISOString(), decided_at: null,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    };
    store.approvals.insert(row);
    assert.equal(store.approvals.get(row.id).status, "PENDING");
    assert.equal(Number(store.approvals.get(row.id).amount_usd), 12.5);
    store.approvals.update(row.id, { status: "APPROVED", decided_by: "merchant" });
    assert.equal(store.approvals.get(row.id).status, "APPROVED");
    assert.equal(store.approvals.list(m, "APPROVED").length, 1);
    assert.equal(store.approvals.list(m, "PENDING").length, 0);
    assert.equal(store.approvals.list(m).length, 1);
    store.close();
  });

  test(`${label}: ledger append/find-success/flagged toggle`, () => {
    const store = makeStore();
    const m = freshMerchant();
    const key = `k-contract-${m}`; // run-unique, mirrors production keys embedding merchant+entity
    const badId = store.ledger.append({
      merchant_id: m, actor: "coordinator", kind: "tool_call", tool: "create_invoice",
      result_json: JSON.stringify({ ok: false }), idempotency_key: key,
    });
    assert.equal(store.ledger.findSuccessByIdempotencyKey(key), undefined);
    const okId = store.ledger.append({
      merchant_id: m, actor: "coordinator", kind: "tool_call", tool: "create_invoice",
      result_json: JSON.stringify({ ok: true, data: { id: "INV2-X" } }),
      idempotency_key: key, reconcile_flag: true,
    });
    assert.equal(typeof okId, "number");
    assert.equal(store.ledger.findSuccessByIdempotencyKey(key).id, okId);
    assert.equal(store.ledger.byId(badId).tool, "create_invoice");
    assert.deepEqual(store.ledger.flagged(m).map((r) => r.id), [okId]);
    store.ledger.setReconcileFlag(okId, false);
    assert.equal(store.ledger.flagged(m).length, 0);
    store.close();
  });

  test(`${label}: jobState set/get roundtrip`, () => {
    const store = makeStore();
    const m = freshMerchant();
    assert.equal(store.jobState.get("digest", m), undefined);
    store.jobState.set({
      job_name: "digest", merchant_id: m,
      cursor_json: JSON.stringify({ lastDate: "2026-10-23" }),
      last_run_at: new Date().toISOString(), last_status: "ok",
    });
    const got = store.jobState.get("digest", m);
    assert.equal(JSON.parse(got.cursor_json).lastDate, "2026-10-23");
    store.jobState.set({
      job_name: "digest", merchant_id: m, cursor_json: "{}",
      last_run_at: new Date().toISOString(), last_status: "ok_with_errors",
    });
    assert.equal(store.jobState.get("digest", m).last_status, "ok_with_errors");
    store.close();
  });

  test(`${label}: events dedupe + markProcessed`, () => {
    const store = makeStore();
    const ev = { event_id: `EVT-${freshMerchant()}`, type: "CUSTOMER.DISPUTE.CREATED", payload_json: "{}", processed_at: null };
    assert.equal(store.events.add(ev), true);
    assert.equal(store.events.add(ev), false); // duplicate event_id rejected
    assert.equal(store.events.get(ev.event_id).processed_at, null);
    store.events.markProcessed(ev.event_id, "2026-10-22T00:00:00.000Z");
    assert.equal(store.events.get(ev.event_id).processed_at, "2026-10-22T00:00:00.000Z");
    store.close();
  });
}

runContract("sqlite", () => createStore(":memory:"));

let pgAvailable = true;
try {
  const probe = new PgGuardianStore(PG_URL);
  probe.close();
} catch (e) {
  pgAvailable = false;
  console.warn(`[store-contract] Postgres not reachable at ${PG_URL}: ${e.message} — PG suite SKIPPED`);
}
if (pgAvailable) {
  runContract("postgres", () => new PgGuardianStore(PG_URL));
} else {
  test("postgres: suite skipped (no test DB)", { skip: true }, () => {});
}
