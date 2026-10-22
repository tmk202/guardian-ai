// Customer Memory — kind B (ARCHITECTURE-DETAIL.md §2.2 B, §2.3) —
// Phase 4D (pulled forward from Phase 3B.1, where it was left pending).
//
// One record per customer, keyed by email (§2.2: `customer_key` is
// "email:<address>"; the memory entity_key is the bare email), rebuilt
// from the merchant's invoice list every time an invoice/collections
// scan runs: invoice ids, totals paid, unpaid/overdue counts, linked
// disputes, and a payment_behaviour label derived ONLY from observable
// facts:
//   any linked open dispute            → "disputed"
//   ≥2 invoices currently overdue      → "chronic-late"
//   1 invoice currently overdue        → "late"
//   ≥1 invoice paid, none overdue      → "on-time"
//   nothing paid and nothing overdue   → "unknown" (no basis to judge —
//                                        the §2.2 enum has no value for
//                                        "no history yet", so Guardian
//                                        says so instead of guessing)
// Writes go through memoryWrite, so §2.4 applies unchanged: a source is
// required, a changed summary supersedes the old record (never deletes
// it), and an identical summary is a no-op — re-running a scan is free.
import { DEFAULT_MERCHANT_ID, type GuardianStore } from "./db";
import { memoryRead, memoryWrite } from "./memory";
import { daysOverdue, invoiceFacts } from "./workers/collections";

export interface CustomerSummary {
  email: string;
  name: string | null;
  invoice_ids: string[];
  total_invoiced_usd: number;
  total_paid_usd: number;
  paid_count: number;
  unpaid_count: number;
  overdue_count: number;
  disputes: string[];
  payment_behavior: "on-time" | "late" | "chronic-late" | "disputed" | "unknown";
  first_seen: string | null;
  last_seen: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const PAID = "PAID";
const UNPAID_STATUSES = new Set(["SENT", "UNPAID", "PARTIALLY_PAID", "PAYMENT_PENDING"]);

export function payerEmailOf(item: any): string | null {
  const raw = item?.primary_recipients?.[0]?.billing_info?.email_address;
  return typeof raw === "string" && raw.includes("@") ? raw.toLowerCase() : null;
}

function invoiceDateOf(item: any): string | null {
  const v = item?.detail?.invoice_date ?? item?.invoice_date ?? null;
  return typeof v === "string" && v ? v.slice(0, 10) : null;
}

/**
 * Reduce an invoice list to one summary per payer email. Pure.
 * `caseIdsByInvoice` maps an invoice id to the open dispute case ids
 * linked to it (from Guardian's cases table).
 */
export function summarizeCustomers(
  items: any[],
  opts: { now: Date; caseIdsByInvoice?: Map<string, string[]> }
): CustomerSummary[] {
  const byEmail = new Map<string, CustomerSummary & { dates: string[] }>();
  for (const item of items ?? []) {
    const email = payerEmailOf(item);
    if (!email) continue;
    const facts = invoiceFacts(item);
    let s = byEmail.get(email);
    if (!s) {
      s = {
        email,
        name: facts.payer_name,
        invoice_ids: [],
        total_invoiced_usd: 0,
        total_paid_usd: 0,
        paid_count: 0,
        unpaid_count: 0,
        overdue_count: 0,
        disputes: [],
        payment_behavior: "unknown",
        first_seen: null,
        last_seen: null,
        dates: [],
      };
      byEmail.set(email, s);
    }
    if (!s.name && facts.payer_name) s.name = facts.payer_name;
    if (facts.invoice_id) {
      s.invoice_ids.push(facts.invoice_id);
      s.total_invoiced_usd += facts.amount;
      if (facts.status === PAID) {
        s.total_paid_usd += facts.amount;
        s.paid_count++;
      } else if (UNPAID_STATUSES.has(facts.status)) {
        s.unpaid_count++;
        if (facts.due_date && daysOverdue(facts.due_date, opts.now) >= 1) {
          s.overdue_count++;
        }
      }
      for (const caseId of opts.caseIdsByInvoice?.get(facts.invoice_id) ?? []) {
        if (!s.disputes.includes(caseId)) s.disputes.push(caseId);
      }
    }
    const d = invoiceDateOf(item);
    if (d) s.dates.push(d);
  }
  const out: CustomerSummary[] = [];
  for (const s of byEmail.values()) {
    s.dates.sort();
    s.first_seen = s.dates[0] ?? null;
    s.last_seen = s.dates[s.dates.length - 1] ?? null;
    s.total_invoiced_usd = round2(s.total_invoiced_usd);
    s.total_paid_usd = round2(s.total_paid_usd);
    s.payment_behavior =
      s.disputes.length > 0
        ? "disputed"
        : s.overdue_count >= 2
          ? "chronic-late"
          : s.overdue_count === 1
            ? "late"
            : s.paid_count > 0
              ? "on-time"
              : "unknown";
    const { dates: _dates, ...summary } = s;
    out.push(summary);
  }
  out.sort((a, b) => a.email.localeCompare(b.email));
  return out;
}

export interface CustomerUpdateResult {
  created: string[];
  updated: string[];
  unchanged: string[];
}

/** §2.2 B body for one customer summary. */
export function customerMemoryBody(
  s: CustomerSummary,
  updatedBy: string
): Record<string, unknown> {
  const facts: string[] = [
    `${s.invoice_ids.length} invoice(s) on record: ${s.paid_count} paid, ${s.unpaid_count} unpaid, ${s.overdue_count} overdue`,
    `Total invoiced $${s.total_invoiced_usd.toFixed(2)} USD, total paid $${s.total_paid_usd.toFixed(2)} USD`,
  ];
  if (s.disputes.length) facts.push(`Open dispute(s): ${s.disputes.join(", ")}`);
  if (s.payment_behavior === "unknown") {
    facts.push("No payment or overdue history yet — behaviour not judged");
  }
  return {
    customer_key: `email:${s.email}`,
    name: s.name,
    first_seen: s.first_seen,
    last_seen: s.last_seen,
    invoices: s.invoice_ids,
    total_paid_usd: s.total_paid_usd,
    payment_behavior: s.payment_behavior,
    disputes: s.disputes,
    facts,
    updated_by: updatedBy,
  };
}

/**
 * Rebuild Customer Memory (kind B) from an invoice list. Called by the
 * invoice/collections scans; idempotent — unchanged customers write
 * nothing.
 */
export function updateCustomerMemories(
  store: GuardianStore,
  merchantId: string,
  items: any[],
  opts: { now: Date; updatedBy: string; caseIdsByInvoice?: Map<string, string[]> }
): CustomerUpdateResult {
  const summaries = summarizeCustomers(items, {
    now: opts.now,
    caseIdsByInvoice: opts.caseIdsByInvoice,
  });
  const result: CustomerUpdateResult = { created: [], updated: [], unchanged: [] };
  for (const s of summaries) {
    const existed =
      memoryRead(store, merchantId, { kind: "B", entity: s.email }).length > 0;
    const write = memoryWrite(store, {
      merchantId,
      kind: "B",
      entityKey: s.email,
      body: customerMemoryBody(s, opts.updatedBy),
      source: `customers:${opts.updatedBy} (invoice scan)`,
      confidence: 1,
    });
    if (!write.created) result.unchanged.push(s.email);
    else if (existed) result.updated.push(s.email);
    else result.created.push(s.email);
  }
  return result;
}

/** Emails Guardian already knows as customers (kind B entity keys). */
export function knownCustomerEmails(
  store: GuardianStore,
  merchantId: string = DEFAULT_MERCHANT_ID
): Set<string> {
  return new Set(
    memoryRead(store, merchantId, { kind: "B" }).map((e) => e.entityKey.toLowerCase())
  );
}
