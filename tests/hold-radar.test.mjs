// Hold Radar tests (Phase 3A, pain #1) — fake readers, no network.
// Proves: classification by transparent rules (new_account 21-day window,
// dispute_related with NO invented release date, reserve only from
// recorded merchant terms, unknown otherwise); settled/negative records
// are not holds; the job writes one memory entry per hold, alerts only
// on first sight, never re-alerts, detects releases; missing Transaction
// Search scope → status "unavailable" with the reason, zero invention;
// the morning digest surfaces the tracked holds as estimates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../tests-dist/lib/db.js";
import { memoryWrite, memoryRead } from "../tests-dist/lib/memory.js";
import { classifyHolds } from "../tests-dist/lib/workers/hold-radar.js";
import { runHoldRadar } from "../tests-dist/lib/jobs/hold-radar.js";
import { runDigest } from "../tests-dist/lib/jobs/digest.js";

const MERCHANT = "sandbox-merchant";
const NOW = new Date("2026-10-22T00:00:00.000Z");
const TS_SCOPE = "https://uri.paypal.com/services/reporting/search/read";

const txn = (id, status, value, date, extra = {}) => ({
  transaction_info: {
    transaction_id: id,
    transaction_status: status,
    transaction_amount: { value, currency_code: "USD" },
    transaction_initiation_date: date,
    ...extra,
  },
});

const FIXTURE_TXNS = [
  txn("TXN-HOLD-NEW", "P", "200.00", "2026-10-10T00:00:00.000Z"),
  txn("TXN-HOLD-DISP", "P", "120.00", "2026-10-05T00:00:00.000Z", { invoice_id: "INV2-DISP-TXN" }),
  txn("TXN-DONE", "S", "500.00", "2026-10-08T00:00:00.000Z"),
  txn("TXN-OUT", "P", "-50.00", "2026-10-09T00:00:00.000Z"),
];

function setupStore({ withProfile = true } = {}) {
  const store = createStore(":memory:");
  store.merchants.upsert({
    id: MERCHANT, profile_json: "{}", policy_yaml: "",
    created_at: NOW.toISOString(),
  });
  if (withProfile) {
    memoryWrite(store, {
      merchantId: MERCHANT, kind: "A", entityKey: "MERCH-1",
      body: { account_created_at: "2026-09-01T00:00:00.000Z" },
      source: "test", confidence: 1,
    });
  }
  store.cases.upsert({
    id: "PP-R-LINK-1", merchant_id: MERCHANT,
    body_json: JSON.stringify({ transaction_id: "TXN-HOLD-DISP" }),
    deadline_at: null, status: "UNDER_REVIEW",
  });
  return store;
}

const readersWithTxns = (details) => ({
  getScopes: async () => [TS_SCOPE],
  listTransactions: async () => ({ transaction_details: details }),
  listInvoices: async () => ({ items: [] }),
  listDisputes: async () => ({ items: [] }),
});

test("classifyHolds: 21-day new-account hold, dispute hold without a date, settled excluded", () => {
  const findings = classifyHolds(
    FIXTURE_TXNS,
    { account_created_at: "2026-09-01T00:00:00.000Z" },
    [{ case_id: "PP-R-LINK-1", transaction_id: "TXN-HOLD-DISP", invoice_id: null }]
  );
  assert.equal(findings.length, 2); // TXN-DONE settled, TXN-OUT negative — not holds
  const fresh = findings.find((f) => f.transaction_id === "TXN-HOLD-NEW");
  assert.equal(fresh.reason_group, "new_account");
  assert.equal(fresh.estimated, true);
  assert.equal(fresh.estimated_release_at, "2026-10-31T00:00:00.000Z"); // Oct 10 + 21d
  assert.ok(fresh.estimate_basis.includes("21 days"));
  const disp = findings.find((f) => f.transaction_id === "TXN-HOLD-DISP");
  assert.equal(disp.reason_group, "dispute_related");
  assert.equal(disp.case_id, "PP-R-LINK-1");
  assert.equal(disp.estimated_release_at, null); // never invent a date for an open case
  assert.ok(disp.estimate_basis.includes("until the case is resolved"));
});

test("classifyHolds: reserve only from recorded terms; otherwise unknown", () => {
  const one = [txn("TXN-RSV", "P", "80.00", "2026-10-01T00:00:00.000Z")];
  const reserve = classifyHolds(one, { rolling_reserve: { percent: 10, days: 30 } }, []);
  assert.equal(reserve[0].reason_group, "reserve");
  assert.equal(reserve[0].estimated_release_at, "2026-10-31T00:00:00.000Z"); // +30d per terms
  const unknown = classifyHolds(one, {}, []);
  assert.equal(unknown[0].reason_group, "unknown");
  assert.equal(unknown[0].estimated_release_at, "2026-10-22T00:00:00.000Z"); // +21d outer bound
  assert.ok(unknown[0].estimate_basis.includes("not visible in the transaction data"));
});

test("hold radar job: missing scope → unavailable, declared, nothing invented", async () => {
  const store = setupStore();
  const readers = {
    getScopes: async () => ["https://uri.paypal.com/services/invoicing"],
    listTransactions: async () => { throw new Error("must not be called without scope"); },
    listInvoices: async () => ({ items: [] }),
    listDisputes: async () => ({ items: [] }),
  };
  const report = await runHoldRadar(store, { merchantId: MERCHANT, now: NOW, readers });
  assert.equal(report.status, "unavailable");
  assert.ok(report.notes.some((n) => n.includes("Transaction Search scope is not enabled")));
  assert.equal(report.holds.length, 0);
  assert.equal(memoryRead(store, MERCHANT, { kind: "C" }).filter((e) => e.entityKey.startsWith("hold:")).length, 0);
  const traces = store.ledger.list(MERCHANT, 100).filter((r) => r.kind === "job" && r.tool === "hold-radar");
  assert.equal(traces.length, 1); // a watcher that ran leaves a trace
  assert.equal(JSON.parse(traces[0].result_json).ok, false);
  assert.equal(store.jobState.get("hold-radar", MERCHANT).last_status, "unavailable");
  store.close();
});

test("hold radar job: new holds alert once, memory stays single, release is detected", async () => {
  const store = setupStore();
  const run1 = await runHoldRadar(store, {
    merchantId: MERCHANT, now: NOW, readers: readersWithTxns(FIXTURE_TXNS),
  });
  assert.equal(run1.status, "ok");
  assert.equal(run1.scanned, 4);
  assert.deepEqual(run1.newHolds.sort(), ["TXN-HOLD-DISP", "TXN-HOLD-NEW"]);
  assert.equal(run1.alertsRaised.length, 2);
  assert.equal(run1.totalHeld.amount, 320);
  const activeHolds = () =>
    memoryRead(store, MERCHANT, { kind: "C" }).filter((e) => e.entityKey.startsWith("hold:"));
  assert.equal(activeHolds().length, 2);
  const alertRows = () =>
    store.ledger.list(MERCHANT, 500).filter((r) => r.kind === "alert" && r.tool === "hold_placed");
  assert.equal(alertRows().length, 2);

  // Second run an hour later: same holds — updated in memory, NO new alert.
  const run2 = await runHoldRadar(store, {
    merchantId: MERCHANT, now: new Date(NOW.getTime() + 3600_000), readers: readersWithTxns(FIXTURE_TXNS),
  });
  assert.deepEqual(run2.newHolds, []);
  assert.equal(run2.alertsRaised.length, 0);
  assert.equal(activeHolds().length, 2); // supersede, never duplicate
  assert.equal(alertRows().length, 2);

  // Third run: TXN-HOLD-NEW has settled → release observed in memory.
  const settled = FIXTURE_TXNS.map((d) =>
    d.transaction_info.transaction_id === "TXN-HOLD-NEW"
      ? txn("TXN-HOLD-NEW", "S", "200.00", "2026-10-10T00:00:00.000Z")
      : d
  );
  const run3 = await runHoldRadar(store, {
    merchantId: MERCHANT, now: new Date(NOW.getTime() + 2 * 3600_000), readers: readersWithTxns(settled),
  });
  assert.deepEqual(run3.released, ["TXN-HOLD-NEW"]);
  const releasedEntry = activeHolds().find((e) => e.entityKey === "hold:TXN-HOLD-NEW");
  assert.equal(releasedEntry.body.status, "released");
  assert.equal(run3.holds.length, 1);
  store.close();
});

test("digest surfaces tracked holds with the next estimated release", async () => {
  const store = setupStore();
  await runHoldRadar(store, { merchantId: MERCHANT, now: NOW, readers: readersWithTxns(FIXTURE_TXNS) });
  const digestReaders = {
    getScopes: async () => [], // no TS scope for the analyst part — declared separately
    listTransactions: async () => { throw new Error("n/a"); },
    listInvoices: async () => ({ items: [], total_pages: 1 }),
    listDisputes: async () => ({ items: [] }),
  };
  const digest = await runDigest(store, { merchantId: MERCHANT, now: NOW, readers: digestReaders });
  assert.equal(digest.holds.count, 2);
  assert.equal(digest.holds.total, 320);
  // The dispute hold has no date; the new-account hold drives the estimate.
  assert.equal(digest.holds.nextEstimatedRelease.transaction_id, "TXN-HOLD-NEW");
  assert.equal(digest.holds.nextEstimatedRelease.estimated_release_at, "2026-10-31T00:00:00.000Z");
  assert.ok(digest.text.includes("On hold: $320.00 USD across 2 held payment(s)"));
  assert.ok(digest.text.includes("Next estimated release: $200.00 USD on 2026-10-31 (estimate)"));
  store.close();
});
