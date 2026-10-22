// Analyst worker tests (Phase 2B, §3.4) — fake PayPal readers, no network.
// Proves the honesty rules: missing Transaction Search scope → money_in
// null with a declared note (never an invoice-sum substitute); open
// disputes merge PayPal's list with Guardian's tracked cases, deduped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../tests-dist/lib/db.js";
import { runAnalyst } from "../tests-dist/lib/workers/analyst.js";

const MERCHANT = "sandbox-merchant";
const RANGE = { start: "2026-09-22T00:00:00.000Z", end: "2026-10-22T00:00:00.000Z" };
const TS_SCOPE = "https://uri.paypal.com/services/reporting/search/read";

function setup() {
  const store = createStore(":memory:");
  store.merchants.upsert({
    id: MERCHANT, profile_json: "{}", policy_yaml: "",
    created_at: new Date().toISOString(),
  });
  return store;
}

const INVOICES = {
  items: [
    { id: "INV2-OPEN-1", status: "SENT", amount: { value: "450.00", currency_code: "USD" } },
    { id: "INV2-PAID-1", status: "PAID", amount: { value: "120.00", currency_code: "USD" } },
  ],
  total_pages: 1,
};

test("analyst: missing Transaction Search scope → money_in null + declared note", async () => {
  const store = setup();
  store.cases.upsert({
    id: "PP-R-TRACKED-1", merchant_id: MERCHANT,
    body_json: JSON.stringify({ amount_usd: 120 }),
    deadline_at: null, status: "UNDER_REVIEW",
  });
  let txCalled = false;
  const readers = {
    getScopes: async () => ["https://uri.paypal.com/services/invoicing"],
    listTransactions: async () => { txCalled = true; return {}; },
    listInvoices: async () => INVOICES,
    listDisputes: async () => ({ items: [] }), // sandbox list quirk: empty
  };
  const report = await runAnalyst(store, readers, RANGE, { merchantId: MERCHANT });
  assert.equal(txCalled, false); // scope known missing → call never made
  assert.equal(report.money_in, null);
  assert.ok(report.notes.some((n) => n.includes("Transaction Search scope is not enabled")));
  assert.equal(report.outstanding.amount, 450);
  assert.equal(report.outstanding.count, 1);
  assert.equal(report.top_unpaid[0].invoice_id, "INV2-OPEN-1");
  // dispute came from tracked case memory, declared in notes
  assert.equal(report.at_risk.dispute_total, 120);
  assert.equal(report.at_risk.open_disputes, 1);
  assert.ok(report.notes.some((n) => n.includes("tracking locally")));
  store.close();
});

test("analyst: with scope → sums settled, counts held into at_risk, dedupes disputes", async () => {
  const store = setup();
  store.cases.upsert({
    id: "PP-R-DUP-1", merchant_id: MERCHANT,
    body_json: JSON.stringify({ amount_usd: 40 }),
    deadline_at: null, status: "UNDER_REVIEW",
  });
  const readers = {
    getScopes: async () => [TS_SCOPE],
    listTransactions: async () => ({
      transaction_details: [
        { transaction_info: { transaction_status: "S", transaction_amount: { value: "120.00", currency_code: "USD" } } },
        { transaction_info: { transaction_status: "S", transaction_amount: { value: "30.50", currency_code: "USD" } } },
        { transaction_info: { transaction_status: "P", transaction_amount: { value: "75.00", currency_code: "USD" } } },
        { transaction_info: { transaction_status: "S", transaction_amount: { value: "-20.00", currency_code: "USD" } } },
      ],
    }),
    listInvoices: async () => INVOICES,
    listDisputes: async () => ({
      items: [
        { dispute_id: "PP-R-DUP-1", status: "UNDER_REVIEW", dispute_amount: { value: "40.00", currency_code: "USD" } },
        { dispute_id: "PP-R-OLD-1", status: "RESOLVED", dispute_amount: { value: "999.00", currency_code: "USD" } },
      ],
    }),
  };
  const report = await runAnalyst(store, readers, RANGE, { merchantId: MERCHANT });
  assert.equal(report.money_in.amount, 150.5);
  assert.equal(report.at_risk.held_total, 75);
  assert.equal(report.at_risk.dispute_total, 40); // PP-R-DUP-1 counted once, RESOLVED excluded
  assert.equal(report.at_risk.open_disputes, 1);
  assert.equal(report.at_risk.amount, 115);
  store.close();
});
