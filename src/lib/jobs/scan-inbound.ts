// Inbound invoice scan — ScamShield job (PHASES 4C) — Phase 4C.
//
// Reads the merchant's invoice list through the executor-backed
// readers and splits it by direction: invoices whose invoicer is NOT
// the merchant are invoices addressed TO the merchant — the surface
// the fake-invoice scam (pain #5) arrives on. Each inbound invoice is
// scored by the pure ScamShield worker; a `likely_scam` verdict raises
// ONE instant alert per invoice, ever (cursor-kept).
//
// HONESTY: the Invoicing list API returns the invoices of the API
// account; for this sandbox merchant those are the invoices it SENT.
// When the inbound set is empty the report says exactly that — an
// empty set is a finding, not a gap to fill with inventions. The same
// scan also refreshes Customer Memory (kind B) from the outbound side
// (Phase 4D), which is what lets ScamShield tell a known customer from
// a stranger.
import { DEFAULT_MERCHANT_ID, type GuardianStore } from "../db";
import { getPolicy, type GuardianPolicy } from "../policy";
import { memoryRead } from "../memory";
import { recordAlert } from "../alerts";
import { executorReaders, type PayPalReaders } from "../workers/analyst";
import {
  assessInboundInvoice,
  inboundInvoiceFacts,
  type ScamAssessment,
} from "../workers/scam-shield";
import {
  knownCustomerEmails,
  payerEmailOf,
  updateCustomerMemories,
  type CustomerUpdateResult,
} from "../customers";

export const SCAM_SCAN_JOB = "scan-inbound";
const CLOSED_CASE = /^(RESOLVED|CLOSED|DENIED|CANCELLED)/i;

export interface ScanInboundOptions {
  merchantId?: string;
  now?: Date;
  /** injectable for tests; defaults to the executor-backed readers */
  readers?: PayPalReaders;
  policy?: GuardianPolicy;
  /** the merchant's own PayPal email; defaults to env/profile */
  merchantEmail?: string;
}

export interface ScanInboundReport {
  merchantId: string;
  ranAt: string;
  status: "ok" | "error";
  scanned: number;
  inbound: number;
  outbound: number;
  /** invoicer email missing → direction cannot be determined */
  unclassified: number;
  assessments: ScamAssessment[];
  alertsRaised: { invoice_id: string; ledgerId: number }[];
  customersUpdated: CustomerUpdateResult | null;
  notes: string[];
}

interface ScanCursor {
  alerted: string[];
}

function loadCursor(store: GuardianStore, merchantId: string): ScanCursor {
  const row = store.jobState.get(SCAM_SCAN_JOB, merchantId);
  if (row?.cursor_json) {
    try {
      const parsed = JSON.parse(row.cursor_json) as ScanCursor;
      if (parsed && Array.isArray(parsed.alerted)) return parsed;
    } catch {
      /* fall through to a fresh cursor */
    }
  }
  return { alerted: [] };
}

function merchantEmailOf(
  store: GuardianStore,
  merchantId: string,
  override?: string
): string | null {
  if (override) return override.toLowerCase();
  const env = process.env.PAYPAL_SANDBOX_BUSINESS_EMAIL;
  if (env) return env.toLowerCase();
  const profile = memoryRead(store, merchantId, { kind: "A", limit: 1 })[0];
  const fromProfile = profile?.body.paypal_email;
  return typeof fromProfile === "string" && fromProfile ? fromProfile.toLowerCase() : null;
}

/** invoiceId → open dispute case ids, for Customer Memory B dispute links. */
function caseIdsByInvoice(
  store: GuardianStore,
  merchantId: string
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of store.cases.list(merchantId)) {
    if (CLOSED_CASE.test(row.status ?? "")) continue;
    try {
      const body = JSON.parse(row.body_json) as Record<string, any>;
      const inv = body.related_invoice ?? body.invoice_id;
      if (typeof inv === "string" && inv) {
        const arr = map.get(inv) ?? [];
        arr.push(row.id);
        map.set(inv, arr);
      }
    } catch {
      /* an unparseable case body links nothing */
    }
  }
  return map;
}

export async function runScanInbound(
  store: GuardianStore,
  opts?: ScanInboundOptions
): Promise<ScanInboundReport> {
  const merchantId = opts?.merchantId ?? DEFAULT_MERCHANT_ID;
  const now = opts?.now ?? new Date();
  const readers = opts?.readers ?? executorReaders();
  const policy = opts?.policy ?? getPolicy();

  const report: ScanInboundReport = {
    merchantId,
    ranAt: now.toISOString(),
    status: "ok",
    scanned: 0,
    inbound: 0,
    outbound: 0,
    unclassified: 0,
    assessments: [],
    alertsRaised: [],
    customersUpdated: null,
    notes: [],
  };

  const trace = (ok: boolean) => {
    store.ledger.append({
      merchant_id: merchantId,
      actor: SCAM_SCAN_JOB,
      kind: "job",
      tool: SCAM_SCAN_JOB,
      result_json: JSON.stringify({
        ok,
        scanned: report.scanned,
        inbound: report.inbound,
        outbound: report.outbound,
        unclassified: report.unclassified,
        verdicts: report.assessments.map((a) => `${a.invoice_id}:${a.verdict}:${a.score}`),
        alerts: report.alertsRaised.length,
        notes: report.notes,
      }),
    });
  };

  let items: any[] = [];
  try {
    const inv = await readers.listInvoices();
    items = Array.isArray(inv?.items) ? inv.items : [];
    if (typeof inv?.total_pages === "number" && inv.total_pages > 1) {
      report.notes.push(
        `Invoice list has ${inv.total_pages} pages; only the first page (100) was scanned.`
      );
    }
  } catch (e) {
    report.status = "error";
    report.notes.push(
      `Invoice read failed (${e instanceof Error ? e.message.slice(0, 200) : String(e)}); nothing was scored.`
    );
    store.jobState.set({
      job_name: SCAM_SCAN_JOB,
      merchant_id: merchantId,
      cursor_json: JSON.stringify(loadCursor(store, merchantId)),
      last_run_at: now.toISOString(),
      last_status: "error",
    });
    trace(false);
    return report;
  }
  report.scanned = items.length;

  // Customer Memory B refresh (Phase 4D) — from the same invoice read.
  // Wrapped: a memory failure must never take the scam scan down.
  try {
    report.customersUpdated = updateCustomerMemories(store, merchantId, items, {
      now,
      updatedBy: SCAM_SCAN_JOB,
      caseIdsByInvoice: caseIdsByInvoice(store, merchantId),
    });
  } catch (e) {
    report.notes.push(
      `Customer memory update failed (${e instanceof Error ? e.message.slice(0, 160) : String(e)}); scam scoring continued without it.`
    );
  }

  // Direction split + known senders.
  const merchantEmail = merchantEmailOf(store, merchantId, opts?.merchantEmail);
  const known = knownCustomerEmails(store, merchantId);
  const inboundItems: any[] = [];
  for (const item of items) {
    const facts = inboundInvoiceFacts(item);
    const invoicer = facts.invoicer_email?.toLowerCase() ?? null;
    const payer = payerEmailOf(item);
    if (payer) known.add(payer); // the merchant's own customers are known senders
    if (!invoicer || !merchantEmail) {
      report.unclassified++;
      continue;
    }
    if (invoicer === merchantEmail) report.outbound++;
    else {
      report.inbound++;
      inboundItems.push(item);
    }
  }
  if (!merchantEmail) {
    report.notes.push(
      "The merchant's own PayPal email is unknown (no env value, no profile fact), so invoice direction could not be determined for any item."
    );
  }
  if (report.inbound === 0 && report.status === "ok") {
    report.notes.push(
      "No inbound invoices found: every classifiable invoice in this account's list was sent BY the merchant. The Invoicing list API exposes the account's own invoices; ScamShield scores any invoice addressed TO the merchant whenever one is observable here — an empty inbound set is reported as-is, never filled in."
    );
  }
  const cursor = loadCursor(store, merchantId);
  for (const item of inboundItems) {
    const facts = inboundInvoiceFacts(item);
    const assessment = assessInboundInvoice(facts, {
      knownSenderEmails: known,
      thresholds: policy.scam,
    });
    report.assessments.push(assessment);
    if (
      assessment.verdict === "likely_scam" &&
      !cursor.alerted.includes(facts.invoice_id)
    ) {
      const ledgerId = recordAlert(store, {
        merchantId,
        actor: SCAM_SCAN_JOB,
        name: "scam_suspect",
        payload: {
          invoice_id: facts.invoice_id,
          score: assessment.score,
          verdict: assessment.verdict,
          reasons: assessment.reasons.map((r) => r.code),
          guidance: assessment.guidance[0],
        },
      });
      report.alertsRaised.push({ invoice_id: facts.invoice_id, ledgerId });
      cursor.alerted.push(facts.invoice_id);
    }
  }

  store.jobState.set({
    job_name: SCAM_SCAN_JOB,
    merchant_id: merchantId,
    cursor_json: JSON.stringify(cursor),
    last_run_at: now.toISOString(),
    last_status: "ok",
  });
  trace(true);
  return report;
}
