// Risk Warning tests (Phase 4A, pain #2) — pure assessment + job, fake
// readers, no network. Proves: thresholds grade LOW/WATCH/HIGH with a
// reason + concrete action per signal; unmeasurable signals land in
// signals_missing (never computed from nothing); a case deadline inside
// 48h is HIGH; the job raises ONE instant alert per merchant-local day
// at HIGH and re-arms the next day.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../tests-dist/lib/db.js";
import { assessRisk } from "../tests-dist/lib/workers/risk-scan.js";
import { runRiskScan } from "../tests-dist/lib/jobs/risk-scan.js";
import { DEFAULT_POLICY } from "../tests-dist/lib/policy.js";

const MERCHANT = "sandbox-merchant";
const T = DEFAULT_POLICY.risk;

const baseInputs = (over = {}) => ({
  windowDays: 30,
  invoicesInWindow: 100,
  openDisputes: 0,
  atRiskUsd: 0,
  atRiskCurrency: "USD",
  deadlineCases: [],
  heldUsd: 0,
  heldCount: 0,
  ...over,
});

test("risk: quiet account grades LOW with a computable rate", () => {
  const a = assessRisk(baseInputs(), T);
  assert.equal(a.level, "LOW");
  assert.equal(a.disputeRate, 0);
  assert.equal(a.reasons.length, 0);
  assert.equal(a.signalsMissing.length, 0);
});

test("risk: dispute rate grades WATCH then HIGH at the policy thresholds", () => {
  const watch = assessRisk(baseInputs({ openDisputes: 4 }), T); // 4% ≥ 3%
  assert.equal(watch.level, "WATCH");
  assert.equal(watch.reasons[0].signal, "dispute_rate");
  assert.ok(watch.reasons[0].action.length > 10);

  const high = assessRisk(baseInputs({ openDisputes: 7 }), T); // 7% ≥ 6%
  assert.equal(high.level, "HIGH");
  assert.equal(high.reasons[0].severity, "high");
});

test("risk: a case deadline inside 48h is HIGH; inside 72h is WATCH", () => {
  const high = assessRisk(baseInputs({ deadlineCases: [{ caseId: "PP-R-1", hoursLeft: 24 }] }), T);
  assert.equal(high.level, "HIGH");
  assert.match(high.reasons[0].detail, /PP-R-1/);
  assert.match(high.reasons[0].action, /PP-R-1/);

  const watch = assessRisk(baseInputs({ deadlineCases: [{ caseId: "PP-R-2", hoursLeft: 60 }] }), T);
  assert.equal(watch.level, "WATCH");

  const calm = assessRisk(baseInputs({ deadlineCases: [{ caseId: "PP-R-3", hoursLeft: 100 }] }), T);
  assert.equal(calm.level, "LOW");
});

test("risk: unmeasurable signals are declared missing, never computed", () => {
  const a = assessRisk(
    baseInputs({ invoicesInWindow: null, atRiskUsd: null, heldUsd: null, heldCount: 0 }),
    T
  );
  assert.equal(a.disputeRate, null);
  assert.equal(a.signalsMissing.length, 3);
  assert.match(a.signalsMissing.join(" "), /dispute rate/);
  assert.match(a.signalsMissing.join(" "), /money at risk/);
  assert.match(a.signalsMissing.join(" "), /funds on hold/);

  // disputes but no denominator: no rate is invented
  const b = assessRisk(baseInputs({ invoicesInWindow: 0, openDisputes: 2 }), T);
  assert.equal(b.disputeRate, null);
  assert.match(b.signalsMissing.join(" "), /no invoices/);
});

// --- job ----------------------------------------------------------------------

function setupStore() {
  const store = createStore(":memory:");
  store.merchants.upsert({
    id: MERCHANT, profile_json: "{}", policy_yaml: "",
    created_at: "2026-10-01T00:00:00.000Z",
  });
  // Case with a deadline 26h after the first run's `now` — inside 48h → HIGH.
  store.cases.upsert({
    id: "PP-R-TEST-1",
    merchant_id: MERCHANT,
    body_json: JSON.stringify({ amount_usd: 120, related_invoice: "INV2-T1" }),
    deadline_at: "2026-10-23T04:00:00.000Z",
    status: "UNDER_REVIEW",
  });
  return store;
}

const readers = {
  getScopes: async () => [], // no Transaction Search — analyst declares it
  listTransactions: async () => ({ transaction_details: [] }),
  listInvoices: async () => ({
    items: Array.from({ length: 10 }, (_, i) => ({
      id: `INV2-T${i}`,
      status: "PAID",
      amount: { value: "10.00", currency_code: "USD" },
      detail: { invoice_date: "2026-10-20" },
    })),
  }),
  listDisputes: async () => ({
    items: [
      {
        dispute_id: "PP-R-TEST-1",
        status: "UNDER_REVIEW",
        dispute_amount: { value: "120.00", currency_code: "USD" },
      },
    ],
  }),
};

test("risk job: HIGH from the near deadline, one alert per local day", async () => {
  const store = setupStore();
  const day1Morning = new Date("2026-10-22T02:00:00.000Z"); // 09:00 Saigon

  const r1 = await runRiskScan(store, { readers, now: day1Morning });
  assert.equal(r1.status, "ok");
  assert.equal(r1.date, "2026-10-22");
  assert.equal(r1.level, "HIGH");
  assert.equal(r1.alertsRaised.length, 1);
  // holds are unobservable (Hold Radar never ran) → declared missing
  assert.ok(r1.assessment.signalsMissing.some((s) => /funds on hold/.test(s)));

  const r2 = await runRiskScan(store, {
    readers,
    now: new Date("2026-10-22T10:00:00.000Z"), // 17:00 Saigon, same local day
  });
  assert.equal(r2.level, "HIGH");
  assert.equal(r2.alertsRaised.length, 0); // no second alert the same day

  const r3 = await runRiskScan(store, {
    readers,
    now: new Date("2026-10-22T18:30:00.000Z"), // 01:30 Saigon next day
  });
  assert.equal(r3.date, "2026-10-23");
  assert.equal(r3.alertsRaised.length, 1); // re-armed on the new day

  const alerts = store.ledger
    .list(MERCHANT, 100)
    .filter((row) => row.kind === "alert" && row.tool === "risk_high");
  assert.equal(alerts.length, 2);
  store.close();
});
