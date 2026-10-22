// Appeal Packet (Phase 4B) + ScamShield (Phase 4C) tests — fixtures
// shaped on the real sandbox POC and on the Reddit fake-invoice pattern;
// stub readers, no network. Proves: the packet for the POC case carries
// the real tracking/carrier/deadline and names proof of delivery as
// MISSING instead of inventing it; a case with nothing on file lists
// every gap; the scam fixture (phone number + call-to-cancel lure +
// brand impersonation) scores likely_scam with all reasons shown; a
// normal invoice from a known customer scores ok; the scan job alerts
// once per scam invoice and refreshes Customer Memory B.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../tests-dist/lib/db.js";
import { seedGuardianMemory } from "../tests-dist/lib/seed.js";
import { memoryRead } from "../tests-dist/lib/memory.js";
import { buildAppealPacket } from "../tests-dist/lib/workers/appeal-packet.js";
import {
  assessInboundInvoice,
  inboundInvoiceFacts,
} from "../tests-dist/lib/workers/scam-shield.js";
import { triageEvent } from "../tests-dist/lib/triage.js";
import { runScanInbound } from "../tests-dist/lib/jobs/scan-inbound.js";
import { DEFAULT_POLICY } from "../tests-dist/lib/policy.js";

const MERCHANT = "sandbox-merchant";
const CASE_ID = "PP-R-GAW-10194043";
const DEADLINE = "2026-11-01T16:59:59Z"; // real deadline the Phase 1D radar read

// --- Appeal Packet --------------------------------------------------------------

const pocReaders = {
  getDispute: async () => ({
    dispute_id: CASE_ID,
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    status: "UNDER_REVIEW",
    dispute_state: "CLAIM",
    dispute_amount: { value: "120.00", currency_code: "USD" },
    create_time: "2026-10-22T07:35:00.000Z",
    update_time: "2026-10-22T07:41:00.000Z",
    seller_response_due_date: DEADLINE,
    disputed_transactions: [
      { seller_transaction_id: "8JX318412P638845D", invoice_id: "INV2-BYHA-VCDE-7EF2-A9N9" },
    ],
    evidences: [
      {
        evidence_type: "PROOF_OF_FULFILLMENT",
        evidence_info: {
          tracking_info: [{ carrier_name: "FEDEX", tracking_number: "GUARDIAN-TRACK-001" }],
        },
      },
    ],
  }),
  getInvoice: async () => ({
    id: "INV2-BYHA-VCDE-7EF2-A9N9",
    status: "PAID",
    detail: { invoice_number: "GUARDIAN-POC-002" },
    amount: { value: "120.00", currency_code: "USD" },
    primary_recipients: [
      { billing_info: { email_address: "buyer@example.com", name: { full_name: "John Doe" } } },
    ],
    items: [
      {
        name: "Wireless earbuds — Bluetooth 5.3",
        quantity: "1",
        unit_amount: { value: "120.00", currency_code: "USD" },
      },
    ],
    payments: [{ transaction_id: "16F19418T8805571K", method: "PAYPAL" }],
  }),
};

function pocStore() {
  const store = createStore(":memory:");
  store.merchants.upsert({
    id: MERCHANT, profile_json: "{}", policy_yaml: "",
    created_at: "2026-10-22T00:00:00.000Z",
  });
  seedGuardianMemory(store, MERCHANT);
  // The seed predates the radar: re-upsert the case row with the real
  // deadline Phase 1D read from PayPal, body unchanged.
  const row = store.cases.get(CASE_ID);
  store.cases.upsert({
    id: CASE_ID,
    merchant_id: MERCHANT,
    body_json: row.body_json,
    deadline_at: DEADLINE,
    status: "UNDER_REVIEW",
  });
  store.ledger.append({
    merchant_id: MERCHANT,
    actor: "executor",
    kind: "tool_call",
    tool: "provide_evidence",
    result_json: JSON.stringify({ ok: true, dispute_id: CASE_ID }),
  });
  return store;
}

test("appeal packet: POC case carries real facts and names its gaps", async () => {
  const store = pocStore();
  const packet = await buildAppealPacket(store, CASE_ID, { readers: pocReaders });
  const md = packet.markdown;
  assert.match(md, /PP-R-GAW-10194043/);
  assert.match(md, /GUARDIAN-TRACK-001/);
  assert.match(md, /FEDEX/);
  assert.match(md, /2026-11-01/);
  assert.match(md, /INV2-BYHA-VCDE-7EF2-A9N9/);
  assert.match(md, /16F19418T8805571K/);
  assert.match(md, /Wireless earbuds/);
  // tracking IS on file → not missing; proof of delivery is not → MISSING
  assert.ok(!packet.missing.some((m) => /tracking number/.test(m)));
  assert.ok(packet.missing.some((m) => m.startsWith("MISSING: proof of delivery")));
  for (const m of packet.missing) assert.ok(m.startsWith("MISSING: "));
  assert.equal(packet.sources.paypalDispute, true);
  assert.equal(packet.sources.paypalInvoice, true);
  store.close();
});

test("appeal packet: a bare case lists every gap and invents nothing", async () => {
  const store = createStore(":memory:");
  store.merchants.upsert({
    id: MERCHANT, profile_json: "{}", policy_yaml: "",
    created_at: "2026-10-22T00:00:00.000Z",
  });
  store.cases.upsert({
    id: "PP-R-BARE-1",
    merchant_id: MERCHANT,
    body_json: JSON.stringify({ reason: "NOT_AS_DESCRIBED", amount_usd: 40 }),
    deadline_at: null,
    status: "OPEN",
  });
  const packet = await buildAppealPacket(store, "PP-R-BARE-1", {
    readers: {
      getDispute: async () => ({ dispute_id: "PP-R-BARE-1", reason: "NOT_AS_DESCRIBED" }),
      getInvoice: async () => {
        throw new Error("no invoice");
      },
    },
  });
  assert.ok(packet.missing.some((m) => /tracking number/.test(m)));
  assert.ok(packet.missing.some((m) => /proof of delivery/.test(m)));
  assert.ok(packet.missing.some((m) => /related invoice/.test(m)));
  assert.ok(packet.missing.some((m) => /response deadline/.test(m)));
  store.close();
});

test("appeal packet: an unknown case is an error, not a document", async () => {
  const store = createStore(":memory:");
  await assert.rejects(
    buildAppealPacket(store, "PP-R-NOPE", {
      readers: {
        getDispute: async () => {
          throw new Error("404");
        },
        getInvoice: async () => ({}),
      },
    }),
    /not found/
  );
  store.close();
});

// --- ScamShield -------------------------------------------------------------------

const MERCHANT_EMAIL = "shop@business.example.com";

// The Reddit pattern (REDDIT-PROBLEMS #5): brand name, unrelated sender,
// a note with a phone number and a call-to-cancel lure, round amount.
const SCAM_ITEM = {
  id: "INV2-SCAM-1",
  status: "SENT",
  amount: { value: "500.00", currency_code: "USD" },
  invoicer: {
    email_address: "billing@random-mail.example",
    name: { full_name: "Geek Squad" },
  },
  detail: {
    note:
      "Your Geek Squad subscription will renew for $500.00 today. If you did not authorise this payment, call our cancellation department immediately at 1-888-555-0142 to cancel within 24 hours.",
  },
  primary_recipients: [{ billing_info: { email_address: MERCHANT_EMAIL } }],
};

const NORMAL_ITEM = {
  id: "INV2-OK-1",
  status: "SENT",
  amount: { value: "120.50", currency_code: "USD" },
  invoicer: {
    email_address: "buyer@example.com",
    name: { full_name: "John Doe" },
  },
  detail: { note: "Thanks for your order — this is the invoice for the earbuds." },
  primary_recipients: [{ billing_info: { email_address: MERCHANT_EMAIL } }],
};

test("scamshield: the Reddit fake-invoice pattern scores likely_scam with reasons", () => {
  const facts = inboundInvoiceFacts(SCAM_ITEM);
  const a = assessInboundInvoice(facts, {
    knownSenderEmails: new Set(),
    thresholds: DEFAULT_POLICY.scam,
  });
  assert.equal(a.verdict, "likely_scam");
  const codes = a.reasons.map((r) => r.code);
  for (const code of [
    "phone_number_in_note",
    "call_to_cancel_lure",
    "unknown_sender",
    "brand_impersonation",
  ]) {
    assert.ok(codes.includes(code), `expected reason ${code}, got ${codes.join(",")}`);
  }
  assert.ok(a.score >= DEFAULT_POLICY.scam.likely_scam_at);
  assert.match(a.guidance.join(" "), /payment REQUEST/);
  assert.match(a.guidance.join(" "), /Do NOT call/);

  // Coexistence with Triage (§3.5): the same note on a webhook-shaped
  // event is still classified scam_suspect by the older screen.
  const t = triageEvent({
    event_type: "INVOICING.INVOICE.CREATED",
    resource: { id: "INV2-SCAM-1", detail: { note: SCAM_ITEM.detail.note } },
  });
  assert.equal(t.kind, "scam_suspect");
});

test("scamshield: a normal invoice from a known customer scores ok", () => {
  const a = assessInboundInvoice(inboundInvoiceFacts(NORMAL_ITEM), {
    knownSenderEmails: new Set(["buyer@example.com"]),
    thresholds: DEFAULT_POLICY.scam,
  });
  assert.equal(a.verdict, "ok");
  assert.equal(a.score, 0);
  assert.equal(a.reasons.length, 0);
});

test("scamshield: stranger + urgency alone lands on caution", () => {
  const item = {
    ...NORMAL_ITEM,
    id: "INV2-CAUTION-1",
    amount: { value: "250.75", currency_code: "USD" },
    invoicer: { email_address: "stranger@example.net", name: { full_name: "A Stranger" } },
    detail: { note: "Please pay immediately, this is urgent." },
  };
  const a = assessInboundInvoice(inboundInvoiceFacts(item), {
    knownSenderEmails: new Set(["buyer@example.com"]),
    thresholds: DEFAULT_POLICY.scam,
  });
  assert.equal(a.verdict, "caution");
  assert.deepEqual(
    a.reasons.map((r) => r.code).sort(),
    ["unknown_sender", "urgency_language"]
  );
});

// --- scan-inbound job ----------------------------------------------------------------

test("scan-inbound job: scores inbound, alerts once per scam, refreshes memory B", async () => {
  const store = createStore(":memory:");
  store.merchants.upsert({
    id: MERCHANT, profile_json: "{}", policy_yaml: "",
    created_at: "2026-10-22T00:00:00.000Z",
  });
  const outbound = {
    id: "INV2-OUT-1",
    status: "PAID",
    amount: { value: "120.50", currency_code: "USD" },
    invoicer: { email_address: MERCHANT_EMAIL, name: { full_name: "Test Store" } },
    detail: { invoice_date: "2026-10-20", invoice_number: "N-1" },
    primary_recipients: [
      { billing_info: { email_address: "buyer@example.com", name: { full_name: "John Doe" } } },
    ],
  };
  const readers = {
    listInvoices: async () => ({ items: [outbound, SCAM_ITEM, NORMAL_ITEM] }),
    listDisputes: async () => ({ items: [] }),
    listTransactions: async () => ({ transaction_details: [] }),
    getScopes: async () => [],
  };
  const opts = { readers, merchantEmail: MERCHANT_EMAIL, now: new Date("2026-10-22T03:00:00.000Z") };

  const r1 = await runScanInbound(store, opts);
  assert.equal(r1.status, "ok");
  assert.equal(r1.scanned, 3);
  assert.equal(r1.outbound, 1);
  assert.equal(r1.inbound, 2);
  const scam = r1.assessments.find((a) => a.invoice_id === "INV2-SCAM-1");
  assert.equal(scam.verdict, "likely_scam");
  const normal = r1.assessments.find((a) => a.invoice_id === "INV2-OK-1");
  assert.equal(normal.verdict, "ok"); // sender is a known customer (outbound payer)
  assert.equal(r1.alertsRaised.length, 1);
  assert.equal(r1.alertsRaised[0].invoice_id, "INV2-SCAM-1");

  // Customer Memory B was refreshed from the outbound invoice.
  const cust = memoryRead(store, MERCHANT, { kind: "B", entity: "buyer@example.com" });
  assert.equal(cust.length, 1);
  assert.equal(cust[0].body.total_paid_usd, 120.5);
  assert.equal(cust[0].body.payment_behavior, "on-time");
  assert.ok(r1.customersUpdated.created.includes("buyer@example.com"));

  const r2 = await runScanInbound(store, opts);
  assert.equal(r2.alertsRaised.length, 0); // never alert the same invoice twice

  const alerts = store.ledger
    .list(MERCHANT, 100)
    .filter((row) => row.kind === "alert" && row.tool === "scam_suspect");
  assert.equal(alerts.length, 1);
  store.close();
});
