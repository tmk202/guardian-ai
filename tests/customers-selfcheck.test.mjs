// Customer Memory B (Phase 4D) + beta self-check tests — no network.
// Proves: per-customer summaries derive behaviour ONLY from observable
// facts (paid / overdue / dispute-linked), writes go through §2.4
// (identical = no-op, changed = supersede, never delete), the
// collections scan maintains memory B as a side effect, and the
// self-check maps real setup states to PASS/WARN/FAIL — with the
// current sandbox truth (Transaction Search missing) landing on WARN,
// not FAIL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../tests-dist/lib/db.js";
import { memoryRead } from "../tests-dist/lib/memory.js";
import {
  summarizeCustomers,
  updateCustomerMemories,
} from "../tests-dist/lib/customers.js";
import { runCollectionsScan } from "../tests-dist/lib/jobs/collections-scan.js";
import { runBetaSelfCheck } from "../tests-dist/lib/selfcheck.js";

const MERCHANT = "sandbox-merchant";
const NOW = new Date("2026-10-22T00:00:00.000Z");

const inv = (id, email, status, value, extra = {}) => ({
  id,
  status,
  amount: { value, currency_code: "USD" },
  detail: { invoice_date: "2026-10-01", ...(extra.detail ?? {}) },
  primary_recipients: [
    { billing_info: { email_address: email, name: { full_name: extra.name ?? "Cust" } } },
  ],
  ...(extra.due ? { due_date: extra.due } : {}),
});

const ITEMS = [
  inv("INV2-A1", "a@x.com", "PAID", "120.00", { name: "Ann" }),
  inv("INV2-A2", "a@x.com", "SENT", "60.00", { due: "2026-10-10" }), // overdue → late
  inv("INV2-B1", "b@x.com", "SENT", "30.00", { due: "2026-10-05" }), // overdue
  inv("INV2-B2", "b@x.com", "UNPAID", "45.00", { due: "2026-10-08" }), // overdue → chronic-late
  inv("INV2-C1", "c@x.com", "SENT", "200.00", { due: "2026-12-01" }), // dispute-linked
];
const CASES_BY_INVOICE = new Map([["INV2-C1", ["PP-R-C1"]]]);

function setupStore() {
  const store = createStore(":memory:");
  store.merchants.upsert({
    id: MERCHANT, profile_json: "{}", policy_yaml: "",
    created_at: NOW.toISOString(),
  });
  return store;
}

test("customers: behaviour derives from observable facts only", () => {
  const s = summarizeCustomers(ITEMS, { now: NOW, caseIdsByInvoice: CASES_BY_INVOICE });
  const byEmail = Object.fromEntries(s.map((c) => [c.email, c]));
  assert.equal(byEmail["a@x.com"].payment_behavior, "late");
  assert.equal(byEmail["a@x.com"].total_paid_usd, 120);
  assert.equal(byEmail["a@x.com"].invoice_ids.length, 2);
  assert.equal(byEmail["b@x.com"].payment_behavior, "chronic-late");
  assert.equal(byEmail["b@x.com"].overdue_count, 2);
  assert.equal(byEmail["c@x.com"].payment_behavior, "disputed");
  assert.deepEqual(byEmail["c@x.com"].disputes, ["PP-R-C1"]);
});

test("customers: writes are idempotent, changes supersede (§2.4)", () => {
  const store = setupStore();
  const r1 = updateCustomerMemories(store, MERCHANT, ITEMS, {
    now: NOW, updatedBy: "test", caseIdsByInvoice: CASES_BY_INVOICE,
  });
  assert.deepEqual(r1.created.sort(), ["a@x.com", "b@x.com", "c@x.com"]);

  const r2 = updateCustomerMemories(store, MERCHANT, ITEMS, {
    now: NOW, updatedBy: "test", caseIdsByInvoice: CASES_BY_INVOICE,
  });
  assert.deepEqual(r2.unchanged.sort(), ["a@x.com", "b@x.com", "c@x.com"]);
  assert.equal(r2.created.length, 0);

  // Ann pays her overdue invoice → her record is superseded, not edited.
  const changed = ITEMS.map((i) =>
    i.id === "INV2-A2" ? { ...i, status: "PAID" } : i
  );
  const r3 = updateCustomerMemories(store, MERCHANT, changed, {
    now: NOW, updatedBy: "test", caseIdsByInvoice: CASES_BY_INVOICE,
  });
  assert.deepEqual(r3.updated, ["a@x.com"]);
  const all = store.memory.list(MERCHANT, "B").filter((e) => e.entity_key === "a@x.com");
  assert.equal(all.length, 2);
  assert.equal(all.filter((e) => e.superseded_by !== null).length, 1);
  const active = memoryRead(store, MERCHANT, { kind: "B", entity: "a@x.com" });
  assert.equal(active[0].body.payment_behavior, "on-time");
  assert.equal(active[0].body.customer_key, "email:a@x.com");
  store.close();
});

test("customers: the collections scan maintains memory B as a side effect", async () => {
  const store = setupStore();
  const readers = {
    listInvoices: async () => ({ items: ITEMS }),
    listDisputes: async () => ({ items: [] }),
    listTransactions: async () => ({ transaction_details: [] }),
    getScopes: async () => [],
  };
  const report = await runCollectionsScan(store, { readers, now: NOW });
  assert.equal(report.status, "ok");
  assert.ok(report.customersUpdated);
  assert.ok(report.customersUpdated.created.includes("a@x.com"));
  const cust = memoryRead(store, MERCHANT, { kind: "B", entity: "b@x.com" });
  assert.equal(cust.length, 1);
  assert.equal(cust[0].body.payment_behavior, "chronic-late");
  store.close();
});

// --- beta self-check -------------------------------------------------------------

const FULL_SCOPES = [
  "https://uri.paypal.com/services/invoicing",
  "https://uri.paypal.com/services/disputes/read-seller",
  "openid",
];

function stubDeps(over = {}) {
  return {
    env: {
      PAYPAL_CLIENT_ID: "id-present",
      PAYPAL_CLIENT_SECRET: "secret-present",
      PAYPAL_WEBHOOK_ID: "WH-TEST-1",
      GUARDIAN_JOB_SECRET: "job-secret-present",
      ...(over.env ?? {}),
    },
    getTokenInfo:
      over.getTokenInfo ?? (async () => ({ token: "tok", scopes: FULL_SCOPES })),
    listWebhooks:
      over.listWebhooks ??
      (async () => ({
        webhooks: [
          { id: "WH-TEST-1", url: "https://guardian-ai-ruby.vercel.app/api/webhooks/paypal" },
        ],
      })),
    openStore: over.openStore ?? (() => createStore(":memory:")),
  };
}

test("selfcheck: complete setup with Transaction Search missing → WARN, usable", async () => {
  const r = await runBetaSelfCheck(stubDeps());
  const byCheck = Object.fromEntries(r.lines.map((l) => [l.check, l.status]));
  assert.equal(byCheck.credentials_configured, "PASS");
  assert.equal(byCheck.token_fetch, "PASS");
  assert.equal(byCheck.scope_invoicing, "PASS");
  assert.equal(byCheck.scope_transaction_search, "WARN"); // the current sandbox truth
  assert.equal(byCheck.scope_disputes, "PASS");
  assert.equal(byCheck.webhook_registered, "PASS");
  assert.equal(byCheck.store_roundtrip, "PASS");
  assert.equal(byCheck.job_secret_configured, "PASS");
  assert.equal(r.fail, 0);
  assert.equal(r.ok, true);
});

test("selfcheck: no credentials → FAIL lines and not usable", async () => {
  const r = await runBetaSelfCheck(
    stubDeps({
      env: { PAYPAL_CLIENT_ID: undefined, PAYPAL_CLIENT_SECRET: undefined },
      getTokenInfo: async () => {
        throw new Error("should not be called");
      },
    })
  );
  const byCheck = Object.fromEntries(r.lines.map((l) => [l.check, l.status]));
  assert.equal(byCheck.credentials_configured, "FAIL");
  assert.equal(byCheck.token_fetch, "FAIL");
  assert.equal(byCheck.scope_invoicing, "FAIL");
  assert.equal(r.ok, false);
});

test("selfcheck: webhook pointing somewhere else → WARN with both URLs", async () => {
  const r = await runBetaSelfCheck(
    stubDeps({
      listWebhooks: async () => ({
        webhooks: [{ id: "WH-TEST-1", url: "https://example.com/old-hook" }],
      }),
    })
  );
  const line = r.lines.find((l) => l.check === "webhook_registered");
  assert.equal(line.status, "WARN");
  assert.match(line.detail, /example\.com\/old-hook/);
  assert.match(line.detail, /guardian-ai-ruby\.vercel\.app/);
});
