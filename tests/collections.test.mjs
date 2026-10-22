// Collections tests (Phase 3B, §3.3, pain #6) — fake readers + a
// fetch-stubbed PayPal REST layer; the real sandbox is never touched.
// Proves: the 3-rung ladder by overdue age with factual, threat-free
// drafts; open-dispute payers are blocked; paid/not-yet-due invoices get
// nothing; the same invoice+rung is never proposed twice (pending or
// dismissed); a sent reminder enforces the policy min gap before the
// next rung; and send_invoice_reminder is SENSITIVE in the executor —
// blocked without approval, and after approval the exact approved text
// is what reaches PayPal, with a read-back in the ledger.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../tests-dist/lib/db.js";
import { GuardianExecutor } from "../tests-dist/lib/executor.js";
import { registerCoreTools } from "../tests-dist/lib/tools.js";
import { decideApproval } from "../tests-dist/lib/approvals.js";
import { runCollectionsScan } from "../tests-dist/lib/jobs/collections-scan.js";

const MERCHANT = "sandbox-merchant";
const NOW = new Date("2026-10-22T12:00:00.000Z");

const inv = (id, status, due, value, extra = {}) => ({
  id, status, due_date: due,
  amount: { value, currency_code: "USD" },
  ...extra,
});

const ITEMS = [
  inv("INV2-RUNG1", "SENT", "2026-10-20", "100.00", {
    detail: { invoice_number: "GUARDIAN-101" },
    primary_recipients: [{ billing_info: { email_address: "ana@example.com", name: { alternate_full_name: "Ana" } } }],
  }), // 2 days overdue → rung 1
  inv("INV2-RUNG2", "UNPAID", "2026-10-15", "250.00"), // 7 days → rung 2
  inv("INV2-RUNG3", "SENT", "2026-09-30", "900.00"), // 22 days → rung 3
  inv("INV2-FRESH", "SENT", "2026-10-29", "450.00"), // not yet due (the POC shape)
  inv("INV2-PAID1", "PAID", "2026-10-01", "10.00"),
  inv("INV2-DISP", "SENT", "2026-10-01", "75.00"), // overdue but disputed
];

function setup(items = ITEMS) {
  const store = createStore(":memory:");
  store.merchants.upsert({
    id: MERCHANT, profile_json: "{}", policy_yaml: "",
    created_at: NOW.toISOString(),
  });
  store.cases.upsert({
    id: "PP-R-CHASE-1", merchant_id: MERCHANT,
    body_json: JSON.stringify({ related_invoice: "INV2-DISP", amount_usd: 75 }),
    deadline_at: null, status: "UNDER_REVIEW",
  });
  const readers = {
    getScopes: async () => [],
    listTransactions: async () => ({ transaction_details: [] }),
    listInvoices: async () => ({ items, total_pages: 1 }),
    listDisputes: async () => ({ items: [] }),
  };
  return { store, readers };
}

const THREATS = /sue|lawsuit|attorney|legal action|debt collector|credit score/i;

test("collections scan: ladder proposals, dispute blocked, paid/fresh skipped, no re-proposal", async () => {
  const { store, readers } = setup();
  const r1 = await runCollectionsScan(store, { merchantId: MERCHANT, now: NOW, readers });
  assert.equal(r1.status, "ok");
  assert.equal(r1.scanned, 6);
  const byId = Object.fromEntries(r1.proposalsCreated.map((p) => [p.invoice_id, p]));
  assert.equal(byId["INV2-RUNG1"].rung, 1);
  assert.equal(byId["INV2-RUNG2"].rung, 2);
  assert.equal(byId["INV2-RUNG3"].rung, 3);
  assert.equal(byId["INV2-RUNG3"].plan_offer.suggested_installments, 3); // $900 → 3-way split offer
  assert.deepEqual(r1.blockedDispute, ["INV2-DISP"]);
  assert.deepEqual(r1.skippedPaid, ["INV2-PAID1"]);
  assert.ok(r1.skipped.some((s) => s.invoice_id === "INV2-FRESH" && s.reason.includes("not yet overdue")));

  const pending = store.approvals.list(MERCHANT, "PENDING");
  assert.equal(pending.length, 3);
  assert.ok(pending.every((a) => a.tool === "send_invoice_reminder" && a.created_by === "collections"));
  const argsOf = (id) => JSON.parse(pending.find((a) => a.id === byId[id].approval_id).args_json);
  const a1 = argsOf("INV2-RUNG1");
  assert.ok(a1.subject.includes("Friendly reminder"));
  assert.ok(a1.note.includes("Hi Ana,")); // payer name from the invoice record
  assert.ok(a1.note.includes("$100.00 USD") && a1.note.includes("2026-10-20"));
  const a2 = argsOf("INV2-RUNG2");
  assert.ok(a2.note.includes("7 days overdue") && a2.note.includes("$250.00 USD"));
  const a3 = argsOf("INV2-RUNG3");
  assert.ok(a3.subject.includes("Final reminder"));
  assert.ok(a3.note.includes("split it into 3 smaller payments"));
  for (const a of [a1, a2, a3]) assert.ok(!THREATS.test(a.note + a.subject), "no threats, ever");

  // Re-run: everything already proposed — zero new approvals.
  const r2 = await runCollectionsScan(store, { merchantId: MERCHANT, now: NOW, readers });
  assert.equal(r2.proposalsCreated.length, 0);
  assert.equal(store.approvals.list(MERCHANT, "PENDING").length, 3);
  store.close();
});

test("collections scan: a dismissed rung is never re-proposed", async () => {
  const { store, readers } = setup();
  const r1 = await runCollectionsScan(store, { merchantId: MERCHANT, now: NOW, readers });
  const target = r1.proposalsCreated.find((p) => p.invoice_id === "INV2-RUNG1");
  decideApproval(store, target.approval_id, "dismissed", "merchant-ui");
  const r2 = await runCollectionsScan(store, { merchantId: MERCHANT, now: NOW, readers });
  assert.equal(r2.proposalsCreated.length, 0);
  assert.ok(r2.skipped.some((s) => s.invoice_id === "INV2-RUNG1" && s.reason.includes("dismissed")));
  assert.equal(store.approvals.list(MERCHANT, "PENDING").length, 2);
  store.close();
});

test("collections state: next rung after a sent reminder respects the policy min gap", async () => {
  const items = [
    inv("INV2-GAP", "SENT", "2026-09-30", "300.00"), // rung 3 territory
    inv("INV2-NEXT", "SENT", "2026-09-30", "300.00"), // rung 3 territory
  ];
  const { store, readers } = setup(items);
  store.jobState.set({
    job_name: "collections-scan", merchant_id: MERCHANT,
    cursor_json: JSON.stringify({
      proposals: {},
      sent: {
        "INV2-GAP": { rung: 2, at: "2026-10-22T00:00:00.000Z" }, // 12h ago < 24h gap
        "INV2-NEXT": { rung: 2, at: "2026-10-20T00:00:00.000Z" }, // 2.5 days ago
      },
    }),
    last_run_at: null, last_status: null,
  });
  const r = await runCollectionsScan(store, { merchantId: MERCHANT, now: NOW, readers });
  assert.deepEqual(r.proposalsCreated.map((p) => p.invoice_id), ["INV2-NEXT"]);
  assert.equal(r.proposalsCreated[0].rung, 3);
  assert.ok(r.skipped.some((s) => s.invoice_id === "INV2-GAP" && s.reason.includes("min gap")));
  store.close();
});

test("send_invoice_reminder: SENSITIVE gate blocks, approval sends the exact text once, read-back ledgered", async () => {
  const { store, readers } = setup();
  const scan = await runCollectionsScan(store, { merchantId: MERCHANT, now: NOW, readers });
  const proposal = scan.proposalsCreated.find((p) => p.invoice_id === "INV2-RUNG1");
  const approval = store.approvals.get(proposal.approval_id);
  const args = JSON.parse(approval.args_json);

  // Mock PayPal at the REST layer (fetch): token, remind (204), get invoice.
  const remindCalls = [];
  const realFetch = globalThis.fetch;
  const prevId = process.env.PAYPAL_CLIENT_ID;
  const prevSecret = process.env.PAYPAL_CLIENT_SECRET;
  process.env.PAYPAL_CLIENT_ID = "test-client";
  process.env.PAYPAL_CLIENT_SECRET = "test-secret";
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/v1/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
    }
    if (u.includes("/remind")) {
      remindCalls.push({ url: u, body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    }
    if (u.includes("/v2/invoicing/invoices/")) {
      return new Response(JSON.stringify({ id: "INV2-RUNG1", status: "SENT" }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  try {
    const executor = new GuardianExecutor({ store });
    registerCoreTools(executor);
    assert.equal(executor.classOf("send_invoice_reminder"), "SENSITIVE");

    // No approval → blocked, PayPal never called.
    await assert.rejects(
      executor.execute("send_invoice_reminder", args, { actor: "coordinator" }),
      (e) => e.code === "APPROVAL_REQUIRED"
    );
    assert.equal(remindCalls.length, 0);

    // Merchant approves the exact draft → one send, exact text, read-back.
    decideApproval(store, proposal.approval_id, "approved", "merchant-ui");
    const res = await executor.execute("send_invoice_reminder", args, {
      actor: "merchant-ui",
      approvalId: proposal.approval_id,
    });
    assert.equal(remindCalls.length, 1);
    assert.ok(remindCalls[0].url.endsWith("/v2/invoicing/invoices/INV2-RUNG1/remind"));
    assert.equal(remindCalls[0].body.subject, args.subject);
    assert.equal(remindCalls[0].body.note, args.note);
    assert.equal(remindCalls[0].body.send_to_invoicer, false);
    assert.equal(res.data.status, "reminder_sent");
    assert.equal(res.reconcileNeeded, false);
    const row = store.ledger.byId(res.ledgerId);
    assert.equal(JSON.parse(row.result_json).read_back.status, "SENT");
    assert.equal(store.approvals.get(proposal.approval_id).status, "EXECUTED");

    // After the send, a fresh scan does not propose rung 1 again.
    const after = await runCollectionsScan(store, { merchantId: MERCHANT, now: NOW, readers });
    assert.ok(!after.proposalsCreated.some((p) => p.invoice_id === "INV2-RUNG1"));
  } finally {
    globalThis.fetch = realFetch;
    if (prevId === undefined) delete process.env.PAYPAL_CLIENT_ID; else process.env.PAYPAL_CLIENT_ID = prevId;
    if (prevSecret === undefined) delete process.env.PAYPAL_CLIENT_SECRET; else process.env.PAYPAL_CLIENT_SECRET = prevSecret;
    store.close();
  }
});
