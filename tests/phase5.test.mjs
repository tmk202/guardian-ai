// Phase 5 tests — Outcome Learning (memory E + playbook stats),
// FX report (§5.3), reconciliation report (§5.4) + digest line, and the
// plans/entitlement frame (§5.1). All readers are stubs; no network.
// The honesty rules under test: outcomes are recorded ONLY for cases
// PayPal reports RESOLVED; playbook rates never appear below the
// minimum sample; FX numbers come only from payload conversion fields
// (absent fields are reported, not estimated); a write no read-back can
// settle is "unverifiable", never "matched"; unknown plans fall back to
// Free instead of crashing or granting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../tests-dist/lib/db.js";
import { memoryRead, memoryWrite } from "../tests-dist/lib/memory.js";
import {
  scanCaseOutcomes,
  playbookStats,
  PLAYBOOK_MIN_SAMPLE,
} from "../tests-dist/lib/workers/outcomes.js";
import { runOutcomesScan } from "../tests-dist/lib/jobs/outcomes-scan.js";
import { buildAppealPacket } from "../tests-dist/lib/workers/appeal-packet.js";
import { analyzeFx } from "../tests-dist/lib/workers/fx-report.js";
import { runAnalyst } from "../tests-dist/lib/workers/analyst.js";
import { buildReconcileReport } from "../tests-dist/lib/workers/reconcile-report.js";
import { runReconcileReport } from "../tests-dist/lib/jobs/reconcile-report.js";
import { runDigest } from "../tests-dist/lib/jobs/digest.js";
import {
  checkEntitlement,
  getMerchantPlan,
  loadPlans,
} from "../tests-dist/lib/plans.js";

const MERCHANT = "sandbox-merchant";
const REASON = "MERCHANDISE_OR_SERVICE_NOT_RECEIVED";
const NOW = new Date("2026-10-23T01:00:00.000Z");
const TS_SCOPE = "https://uri.paypal.com/services/reporting/search/read";

function setup() {
  const store = createStore(":memory:");
  store.merchants.upsert({
    id: MERCHANT, profile_json: "{}", policy_yaml: "",
    created_at: NOW.toISOString(),
  });
  return store;
}

function addCase(store, id, body = {}, status = "UNDER_REVIEW") {
  store.cases.upsert({
    id, merchant_id: MERCHANT,
    body_json: JSON.stringify({ reason: REASON, amount_usd: 100, ...body }),
    deadline_at: null, status,
  });
}

const resolvedDispute = (id, outcomeCode, withTracking, extra = {}) => ({
  dispute_id: id,
  reason: REASON,
  status: "RESOLVED",
  dispute_amount: { value: "100.00", currency_code: "USD" },
  create_time: "2026-10-01T00:00:00.000Z",
  update_time: "2026-10-11T00:00:00.000Z",
  dispute_outcome: { outcome_code: outcomeCode },
  evidences: withTracking
    ? [{
        evidence_type: "PROOF_OF_FULFILLMENT",
        evidence_info: { tracking_info: [{ carrier_name: "FEDEX", tracking_number: `TRK-${id}` }] },
      }]
    : [{ evidence_type: "OTHER", notes: "buyer note" }],
  ...extra,
});

// --- memory kind E -----------------------------------------------------------

test("phase5 memory: kind E is writable, kind F still refused", () => {
  const store = setup();
  const w = memoryWrite(store, {
    merchantId: MERCHANT, kind: "E", entityKey: "PP-R-X",
    body: { case_id: "PP-R-X", outcome: "SELLER_FAVOR" }, source: "test",
  });
  assert.equal(w.created, true);
  assert.equal(memoryRead(store, MERCHANT, { kind: "E" }).length, 1);
  assert.throws(
    () =>
      memoryWrite(store, {
        merchantId: MERCHANT, kind: "F", entityKey: "x",
        body: { rule: "later" }, source: "test",
      }),
    /not writable/
  );
  store.close();
});

// --- outcomes scan -------------------------------------------------------------

test("phase5 outcomes: resolved cases recorded once, open case untouched, stats gated by sample", async () => {
  const store = setup();
  addCase(store, "PP-R-WIN-1");
  addCase(store, "PP-R-LOSE-1");
  addCase(store, "PP-R-OPEN-1");
  // Case memory for the win, so the C-record outcome sync is exercised.
  memoryWrite(store, {
    merchantId: MERCHANT, kind: "C", entityKey: "PP-R-WIN-1",
    body: { case_id: "PP-R-WIN-1", reason: REASON, outcome: null },
    source: "test",
  });
  const disputes = {
    "PP-R-WIN-1": resolvedDispute("PP-R-WIN-1", "SELLER_FAVOR", true),
    "PP-R-LOSE-1": resolvedDispute("PP-R-LOSE-1", "BUYER_FAVOR", false),
    "PP-R-OPEN-1": { dispute_id: "PP-R-OPEN-1", status: "WAITING_FOR_SELLER_RESPONSE", reason: REASON },
  };
  const readers = { getDispute: async (id) => disputes[id] };

  const first = await scanCaseOutcomes(store, readers, { merchantId: MERCHANT, now: NOW });
  assert.equal(first.scanned, 3);
  assert.equal(first.recorded.length, 2);
  assert.deepEqual(first.stillOpen, [{ caseId: "PP-R-OPEN-1", status: "WAITING_FOR_SELLER_RESPONSE" }]);
  const win = first.recorded.find((o) => o.caseId === "PP-R-WIN-1");
  assert.equal(win.outcome, "SELLER_FAVOR");
  assert.equal(win.hasTracking, true);
  assert.equal(win.daysOpen, 10);
  assert.deepEqual(win.evidenceTypes, ["PROOF_OF_FULFILLMENT"]);
  const lose = first.recorded.find((o) => o.caseId === "PP-R-LOSE-1");
  assert.equal(lose.outcome, "BUYER_FAVOR");
  assert.equal(lose.hasTracking, false);
  // E records landed; cases table + case memory synced to RESOLVED.
  assert.equal(memoryRead(store, MERCHANT, { kind: "E" }).length, 2);
  assert.equal(store.cases.get("PP-R-WIN-1").status, "RESOLVED");
  const cMem = memoryRead(store, MERCHANT, { kind: "C", entity: "PP-R-WIN-1" })[0];
  assert.equal(cMem.body.outcome, "SELLER_FAVOR");
  // The open case produced NO outcome record — nothing guessed.
  assert.equal(memoryRead(store, MERCHANT, { kind: "E", entity: "PP-R-OPEN-1" }).length, 0);

  // Idempotent: a second scan records nothing new.
  const second = await scanCaseOutcomes(store, readers, { merchantId: MERCHANT, now: NOW });
  assert.equal(second.recorded.length, 0);
  assert.equal(second.alreadyRecorded, 2);
  assert.equal(memoryRead(store, MERCHANT, { kind: "E" }).length, 2);

  // Stats with n=1 per bucket: no rates, sample sizes shown.
  let stats = playbookStats(store, MERCHANT);
  assert.equal(stats.length, 2);
  for (const b of stats) {
    assert.equal(b.n, 1);
    assert.equal(b.sufficient, false);
    assert.equal(b.winRate, null);
    assert.match(b.note, /insufficient data \(n=1/);
  }

  // Two more tracking wins in the same reason bucket → n=3, rate appears.
  addCase(store, "PP-R-WIN-2");
  addCase(store, "PP-R-WIN-3");
  disputes["PP-R-WIN-2"] = resolvedDispute("PP-R-WIN-2", "SELLER_FAVOR", true);
  disputes["PP-R-WIN-3"] = resolvedDispute("PP-R-WIN-3", "SELLER_FAVOR", true);
  const third = await scanCaseOutcomes(store, readers, { merchantId: MERCHANT, now: NOW });
  assert.equal(third.recorded.length, 2);
  stats = playbookStats(store, MERCHANT);
  const bucket = stats.find((b) => b.reason === REASON && b.hasTracking);
  assert.equal(bucket.n, 3);
  assert.equal(bucket.won, 3);
  assert.equal(bucket.decided, 3);
  assert.equal(bucket.winRate, 1);
  assert.equal(bucket.sufficient, true);
  assert.ok(PLAYBOOK_MIN_SAMPLE >= 3);
  store.close();
});

test("phase5 outcomes: job wrapper ledgers the run and reports still-open honestly", async () => {
  const store = setup();
  addCase(store, "PP-R-GAW-10194043");
  const readers = {
    getDispute: async () => ({
      dispute_id: "PP-R-GAW-10194043",
      status: "WAITING_FOR_SELLER_RESPONSE",
      reason: REASON,
    }),
  };
  const report = await runOutcomesScan(store, { merchantId: MERCHANT, now: NOW, readers });
  assert.equal(report.recorded.length, 0);
  assert.equal(report.stillOpen.length, 1);
  assert.ok(report.ledgerId > 0);
  const jobRows = store.ledger.list(MERCHANT, 10).filter((r) => r.tool === "outcomes-scan");
  assert.equal(jobRows.length, 1);
  store.close();
});

// --- appeal packet playbook section ---------------------------------------------

test("phase5 packet: Similar cases appears only with a sufficient sample", async () => {
  const store = setup();
  // Seed 3 decided outcomes: reason REASON, with tracking, all won.
  for (const id of ["PP-R-H1", "PP-R-H2", "PP-R-H3"]) {
    memoryWrite(store, {
      merchantId: MERCHANT, kind: "E", entityKey: id,
      body: {
        case_id: id, reason: REASON, outcome: "SELLER_FAVOR",
        evidence_types: ["PROOF_OF_FULFILLMENT"], has_tracking: true,
      },
      source: "test",
    });
  }
  const packetReaders = {
    getDispute: async () => resolvedDispute("PP-R-NEW-1", undefined, true, {
      status: "UNDER_REVIEW",
      dispute_outcome: undefined,
    }),
    getInvoice: async () => ({ id: "INV2-1", status: "PAID", amount: { value: "100.00", currency_code: "USD" } }),
  };
  addCase(store, "PP-R-NEW-1");
  const packet = await buildAppealPacket(store, "PP-R-NEW-1", {
    merchantId: MERCHANT, now: NOW, readers: packetReaders,
  });
  assert.match(packet.markdown, /## Similar cases \(Guardian playbook\)/);
  assert.match(packet.markdown, /n=3/);
  assert.ok(packet.playbook && packet.playbook.winRate === 1);

  // A case whose reason has no recorded outcomes → no section, no rate.
  const otherReaders = {
    getDispute: async () => ({
      dispute_id: "PP-R-NEW-2", reason: "UNAUTHORIZED_TRANSACTION",
      status: "UNDER_REVIEW",
      dispute_amount: { value: "10.00", currency_code: "USD" },
      evidences: [],
      disputed_transactions: [],
    }),
    getInvoice: async () => { throw new Error("none"); },
  };
  addCase(store, "PP-R-NEW-2", { reason: "UNAUTHORIZED_TRANSACTION" });
  const packet2 = await buildAppealPacket(store, "PP-R-NEW-2", {
    merchantId: MERCHANT, now: NOW, readers: otherReaders,
  });
  assert.doesNotMatch(packet2.markdown, /Similar cases/);
  assert.equal(packet2.playbook, null);
  store.close();
});

// --- FX report -------------------------------------------------------------------

const FX_DETAILS = [
  {
    transaction_info: {
      transaction_id: "TXN-FX-1",
      transaction_status: "S",
      transaction_amount: { value: "200.00", currency_code: "BRL" },
      fee_amount: { value: "1.80", currency_code: "USD" },
      exchange_rate: "0.18",
      settlement_amount: { value: "36.00", currency_code: "USD" },
    },
  },
  {
    transaction_info: {
      transaction_id: "TXN-USD-1",
      transaction_status: "S",
      transaction_amount: { value: "120.00", currency_code: "USD" },
      fee_amount: { value: "4.20", currency_code: "USD" },
    },
  },
  {
    transaction_info: {
      transaction_id: "TXN-EUR-1",
      transaction_status: "S",
      transaction_amount: { value: "80.00", currency_code: "EUR" },
      fee_amount: { value: "2.00", currency_code: "EUR" },
    },
  },
];

test("phase5 fx: conversion math is payload arithmetic; missing fields declared", () => {
  const fx = analyzeFx(FX_DETAILS, { baseCurrency: "USD" });
  assert.equal(fx.status, "ok");
  assert.equal(fx.conversions.length, 1);
  const c = fx.conversions[0];
  assert.equal(c.transaction_id, "TXN-FX-1");
  assert.deepEqual(c.gross_presentment, { amount: 200, currency: "BRL" });
  assert.equal(c.exchange_rate, 0.18);
  assert.deepEqual(c.gross_settlement, { amount: 36, currency: "USD" });
  assert.equal(c.net_settlement.amount, 34.2); // 36.00 − 1.80, hand-checked
  assert.equal(c.fee_pct_of_settlement_gross, 5); // 1.80 / 36.00, hand-checked
  assert.equal(fx.totals.length, 1);
  assert.equal(fx.totals[0].pair, "BRL->USD");
  assert.equal(fx.totals[0].fees_settlement, 1.8);
  // The EUR payment carries no conversion fields → declared, not estimated.
  assert.equal(fx.missing_fields.length, 1);
  assert.equal(fx.missing_fields[0].transaction_id, "TXN-EUR-1");
  assert.deepEqual(fx.missing_fields[0].missing, ["exchange_rate", "settlement_amount"]);
  assert.ok(fx.notes.some((n) => n.includes("no external or reference exchange rate")));
});

test("phase5 analyst: fx section ok with scope, unavailable without", async () => {
  const store = setup();
  const RANGE = { start: "2026-09-22T00:00:00.000Z", end: "2026-10-22T00:00:00.000Z" };
  const withScope = {
    getScopes: async () => [TS_SCOPE],
    listTransactions: async () => ({ transaction_details: FX_DETAILS }),
    listInvoices: async () => ({ items: [], total_pages: 1 }),
    listDisputes: async () => ({ items: [] }),
  };
  const r1 = await runAnalyst(store, withScope, RANGE, { merchantId: MERCHANT });
  assert.equal(r1.fx.status, "ok");
  assert.equal(r1.fx.conversions.length, 1);

  const noScope = {
    getScopes: async () => [],
    listTransactions: async () => { throw new Error("must not be called"); },
    listInvoices: async () => ({ items: [], total_pages: 1 }),
    listDisputes: async () => ({ items: [] }),
  };
  const r2 = await runAnalyst(store, noScope, RANGE, { merchantId: MERCHANT });
  assert.equal(r2.fx.status, "unavailable");
  assert.match(r2.fx.reason, /Transaction Search/);
  store.close();
});

// --- reconciliation report ----------------------------------------------------------

test("phase5 reconcile-report: matched / mismatched (flagged) / unverifiable buckets", async () => {
  const store = setup();
  const evidenceArgs = {
    dispute_id: "PP-R-1",
    evidences: [{
      evidence_type: "PROOF_OF_FULFILLMENT",
      evidence_info: { tracking_info: [{ carrier_name: "FEDEX", tracking_number: "T1" }] },
    }],
  };
  const evRow = store.ledger.append({
    merchant_id: MERCHANT, actor: "coordinator", kind: "tool_call",
    tool: "provide_evidence",
    args_redacted_json: JSON.stringify(evidenceArgs),
    result_json: JSON.stringify({ ok: true, data: { status: "submitted" } }),
  });
  const sendRow = store.ledger.append({
    merchant_id: MERCHANT, actor: "coordinator", kind: "tool_call",
    tool: "send_invoice",
    args_redacted_json: JSON.stringify({ invoice_id: "INV2-DRAFT-1" }),
    result_json: JSON.stringify({ ok: true, data: { id: "INV2-DRAFT-1" } }),
  });
  store.ledger.append({
    merchant_id: MERCHANT, actor: "coordinator", kind: "tool_call",
    tool: "send_invoice_reminder",
    args_redacted_json: JSON.stringify({ invoice_id: "INV2-DRAFT-1" }),
    result_json: JSON.stringify({ ok: true, data: { status: "reminder_sent" } }),
  });
  store.ledger.append({
    merchant_id: MERCHANT, actor: "analyst", kind: "tool_call",
    tool: "get_dispute",
    args_redacted_json: JSON.stringify({ dispute_id: "PP-R-1" }),
    result_json: JSON.stringify({ ok: true, data: {} }),
  });
  const readers = {
    getDispute: async () => ({ evidences: evidenceArgs.evidences }),
    getInvoice: async () => ({ id: "INV2-DRAFT-1", status: "DRAFT" }),
  };
  const report = await buildReconcileReport(store, readers, { merchantId: MERCHANT, now: NOW });
  assert.equal(report.checked, 3);
  assert.equal(report.skippedReads, 1);
  assert.equal(report.matched.length, 1);
  assert.equal(report.matched[0].ledgerId, evRow);
  assert.equal(report.mismatched.length, 1);
  assert.equal(report.mismatched[0].ledgerId, sendRow);
  assert.match(report.mismatched[0].detail, /still DRAFT/);
  assert.equal(report.unverifiable.length, 1);
  assert.equal(report.unverifiable[0].tool, "send_invoice_reminder");
  // The mismatch joined the Phase 1 sweep's worklist via the same flag.
  assert.equal(store.ledger.byId(sendRow).reconcile_flag, 1);
  assert.equal(store.ledger.byId(evRow).reconcile_flag, 0);
  store.close();
});

test("phase5 digest: quotes the last reconciliation report in one line", async () => {
  const store = setup();
  store.ledger.append({
    merchant_id: MERCHANT, actor: "coordinator", kind: "tool_call",
    tool: "send_invoice",
    args_redacted_json: JSON.stringify({ invoice_id: "INV2-OK-1" }),
    result_json: JSON.stringify({ ok: true, data: { id: "INV2-OK-1" } }),
  });
  const reconReaders = {
    getDispute: async () => ({}),
    getInvoice: async () => ({ id: "INV2-OK-1", status: "SENT" }),
  };
  await runReconcileReport(store, { merchantId: MERCHANT, now: NOW, readers: reconReaders });
  const digestReaders = {
    getScopes: async () => [],
    listTransactions: async () => { throw new Error("no scope"); },
    listInvoices: async () => ({ items: [] }),
    listDisputes: async () => ({ items: [] }),
  };
  const digest = await runDigest(store, { merchantId: MERCHANT, now: NOW, readers: digestReaders });
  assert.equal(digest.reconciliation.matched, 1);
  assert.equal(digest.reconciliation.mismatched, 0);
  assert.match(digest.text, /Reconciliation: 1 matched \/ 0 mismatched/);
  store.close();
});

// --- plans ----------------------------------------------------------------------------

test("phase5 plans: entitlement gate, Free fallback, merchant plan from profile", () => {
  assert.equal(checkEntitlement("free", "digest").allowed, true);
  assert.equal(checkEntitlement("free", "collections").allowed, false);
  assert.equal(checkEntitlement("pro", "collections").allowed, true);
  assert.equal(checkEntitlement("pro", "reconcile-report").allowed, true);
  const bogus = checkEntitlement("platinum", "digest");
  assert.equal(bogus.plan.id, "free");
  assert.match(bogus.reason, /unknown plan/);

  const plans = loadPlans();
  assert.deepEqual(plans.free.features, ["digest", "deadline-radar", "hold-radar"]);
  assert.equal(plans.pro.max_tracked_cases, null);

  const store = setup();
  // No profile at all → Free, nothing declared.
  let mp = getMerchantPlan(store, MERCHANT);
  assert.equal(mp.planId, "free");
  assert.equal(mp.declared, null);
  // Profile without a plan field (pre-Phase-5 shape) → still Free.
  memoryWrite(store, {
    merchantId: MERCHANT, kind: "A", entityKey: "PY1",
    body: { merchant_id: "PY1", business_name: "Shop" }, source: "test",
  });
  mp = getMerchantPlan(store, MERCHANT);
  assert.equal(mp.planId, "free");
  // Profile declaring Pro → Pro in force.
  memoryWrite(store, {
    merchantId: MERCHANT, kind: "A", entityKey: "PY1",
    body: { merchant_id: "PY1", business_name: "Shop", plan: "pro" }, source: "test",
  });
  mp = getMerchantPlan(store, MERCHANT);
  assert.equal(mp.planId, "pro");
  assert.equal(mp.declared, "pro");
  store.close();
});
