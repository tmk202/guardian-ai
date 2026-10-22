// Morning digest tests (Phase 2C, PHASES 2.3) — fake readers, no network.
// Proves: content assembly (overdue, deadlines <7d, pending approvals,
// new alerts), one ledger digest row per merchant-local day, and the
// second run of the day returning alreadyDone without duplicating.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../tests-dist/lib/db.js";
import { runDigest } from "../tests-dist/lib/jobs/digest.js";

const MERCHANT = "sandbox-merchant";
// 08:00 in Asia/Saigon on 2026-10-23 — digest o'clock.
const NOW = new Date("2026-10-23T01:00:00.000Z");

function setup() {
  const store = createStore(":memory:");
  store.merchants.upsert({
    id: MERCHANT, profile_json: "{}", policy_yaml: "",
    created_at: NOW.toISOString(),
  });
  // Case with a deadline 3 days out → must appear in upcomingDeadlines.
  store.cases.upsert({
    id: "PP-R-SOON-1", merchant_id: MERCHANT, body_json: "{}",
    deadline_at: "2026-10-26T01:00:00.000Z", status: "UNDER_REVIEW",
  });
  // One approval waiting on the merchant.
  store.approvals.insert({
    id: "appr-digest-1", merchant_id: MERCHANT, tool: "provide_evidence",
    args_json: "{}", args_hash: "h", reason: "test", amount_usd: 120,
    status: "PENDING", created_by: "coordinator", decided_by: null,
    created_at: NOW.toISOString(), decided_at: null,
    expires_at: new Date(NOW.getTime() + 3600_000).toISOString(),
  });
  // One fresh instant alert in the ledger.
  store.ledger.append({
    merchant_id: MERCHANT, actor: "deadline-radar", kind: "alert",
    tool: "dispute_deadline_risk", result_json: JSON.stringify({ alert: true }),
  });
  return store;
}

const READERS = {
  getScopes: async () => [], // no Transaction Search → money unavailable, declared
  listTransactions: async () => { throw new Error("must not be called without scope"); },
  listInvoices: async () => ({
    items: [
      // SENT, due 2026-10-20 (before yesterday) → overdue
      { id: "INV2-LATE-1", status: "SENT", due_date: "2026-10-20", amount: { value: "450.00", currency_code: "USD" } },
      // SENT, due tomorrow → outstanding but not overdue
      { id: "INV2-FRESH-1", status: "SENT", due_date: "2026-10-24", amount: { value: "60.00", currency_code: "USD" } },
      { id: "INV2-PAID-1", status: "PAID", due_date: "2026-10-01", amount: { value: "10.00", currency_code: "USD" } },
    ],
    total_pages: 1,
  }),
  listDisputes: async () => ({ items: [] }),
};

test("digest: assembles content and is idempotent per day", async () => {
  const store = setup();
  const first = await runDigest(store, { merchantId: MERCHANT, now: NOW, readers: READERS });
  assert.equal(first.date, "2026-10-23");
  assert.equal(first.alreadyDone, false);
  assert.equal(first.moneyYesterday, null); // no TS scope — declared, not faked
  assert.ok(first.notes.some((n) => n.includes("Transaction Search")));
  assert.equal(first.outstanding.amount, 510);
  assert.deepEqual(first.overdueInvoices.map((o) => o.invoice_id), ["INV2-LATE-1"]);
  assert.deepEqual(first.upcomingDeadlines.map((d) => d.caseId), ["PP-R-SOON-1"]);
  assert.equal(first.unhandledAlerts.length, 1);
  assert.equal(first.pendingApprovals.length, 1);
  assert.equal(first.pendingApprovals[0].tool, "provide_evidence");
  assert.ok(first.text.includes("Guardian morning digest — 2026-10-23"));
  assert.ok(first.text.includes("Overdue: INV2-LATE-1"));
  assert.ok(first.text.includes("Waiting for your approval: provide_evidence"));

  const digestRows = () =>
    store.ledger.list(MERCHANT, 500).filter((r) => r.kind === "job" && r.tool === "digest");
  assert.equal(digestRows().length, 1);

  const second = await runDigest(store, { merchantId: MERCHANT, now: NOW, readers: READERS });
  assert.equal(second.alreadyDone, true);
  assert.equal(second.date, "2026-10-23");
  assert.equal(digestRows().length, 1); // still exactly one digest for the day
  store.close();
});
