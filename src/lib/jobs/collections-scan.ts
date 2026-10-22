// Overdue scan job (ARCHITECTURE-DETAIL.md §6 "Overdue scan, daily
// 08:30", PHASES 3B) — Phase 3B.
//
// Reads the invoice list through the executor-backed readers, finds the
// invoices linked to open disputes (Guardian's tracked cases — those
// payers are never chased), plans the chase with the Collections worker
// (§3.3 ladder) and turns each due reminder into a PENDING approval.
// Nothing is sent by this job: sending happens only when the merchant
// approves and the executor runs `send_invoice_reminder` behind that
// approval. Dedupe state lives in this job's job_state cursor.
import { DEFAULT_MERCHANT_ID, type GuardianStore } from "../db";
import { getPolicy, type GuardianPolicy } from "../policy";
import {
  executorReaders,
  type PayPalReaders,
} from "../workers/analyst";
import {
  planCollections,
  applyCollectionsPlan,
  emptyCollectionsState,
  type CollectionsState,
  type CollectionSkip,
  type CreatedProposal,
} from "../workers/collections";
import {
  updateCustomerMemories,
  type CustomerUpdateResult,
} from "../customers";

export const COLLECTIONS_SCAN_JOB = "collections-scan";
const CLOSED_CASE = /^(RESOLVED|CLOSED|DENIED|CANCELLED)/i;

export interface CollectionsScanOptions {
  merchantId?: string;
  now?: Date;
  /** injectable for tests; defaults to the executor-backed readers */
  readers?: PayPalReaders;
  policy?: GuardianPolicy;
}

export interface CollectionsScanReport {
  merchantId: string;
  ranAt: string;
  status: "ok" | "error";
  scanned: number;
  proposalsCreated: CreatedProposal[];
  blockedDispute: string[];
  skippedPaid: string[];
  skipped: CollectionSkip[];
  /** Customer Memory (kind B) refresh from the same invoice read (Phase 4D) */
  customersUpdated: CustomerUpdateResult | null;
  notes: string[];
}

/** Invoice ids an open tracked dispute is linked to — never chased (§3.3). */
export function disputedInvoiceIds(store: GuardianStore, merchantId: string): Set<string> {
  const ids = new Set<string>();
  for (const row of store.cases.list(merchantId)) {
    if (CLOSED_CASE.test(row.status ?? "")) continue;
    try {
      const body = JSON.parse(row.body_json) as Record<string, any>;
      const inv = body.related_invoice ?? body.invoice_id;
      if (typeof inv === "string" && inv) ids.add(inv);
    } catch {
      /* an unparseable case body links nothing */
    }
  }
  return ids;
}

function loadState(store: GuardianStore, merchantId: string): CollectionsState {
  const row = store.jobState.get(COLLECTIONS_SCAN_JOB, merchantId);
  if (row?.cursor_json) {
    try {
      const parsed = JSON.parse(row.cursor_json) as CollectionsState;
      if (parsed && typeof parsed.proposals === "object" && typeof parsed.sent === "object") {
        return parsed;
      }
    } catch {
      /* fall through to a fresh state */
    }
  }
  return emptyCollectionsState();
}

export async function runCollectionsScan(
  store: GuardianStore,
  opts?: CollectionsScanOptions
): Promise<CollectionsScanReport> {
  const merchantId = opts?.merchantId ?? DEFAULT_MERCHANT_ID;
  const now = opts?.now ?? new Date();
  const readers = opts?.readers ?? executorReaders();
  const policy = opts?.policy ?? getPolicy();

  const report: CollectionsScanReport = {
    merchantId,
    ranAt: now.toISOString(),
    status: "ok",
    scanned: 0,
    proposalsCreated: [],
    blockedDispute: [],
    skippedPaid: [],
    skipped: [],
    customersUpdated: null,
    notes: [],
  };

  const trace = (ok: boolean, extra?: Record<string, unknown>) => {
    store.ledger.append({
      merchant_id: merchantId,
      actor: COLLECTIONS_SCAN_JOB,
      kind: "job",
      tool: COLLECTIONS_SCAN_JOB,
      result_json: JSON.stringify({
        ok,
        scanned: report.scanned,
        proposals_created: report.proposalsCreated.map((p) => `${p.invoice_id}:rung${p.rung}`),
        blocked_dispute: report.blockedDispute,
        skipped_paid: report.skippedPaid,
        skipped: report.skipped.map((s) => s.invoice_id),
        ...extra,
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
      `Invoice read failed (${e instanceof Error ? e.message.slice(0, 200) : String(e)}); no reminders were proposed.`
    );
    store.jobState.set({
      job_name: COLLECTIONS_SCAN_JOB,
      merchant_id: merchantId,
      cursor_json: JSON.stringify(loadState(store, merchantId)),
      last_run_at: now.toISOString(),
      last_status: "error",
    });
    trace(false, { error: report.notes[report.notes.length - 1] });
    return report;
  }
  report.scanned = items.length;

  // Customer Memory B refresh (Phase 4D, §2.2 B): the same invoice read
  // that plans the chase also maintains one record per customer.
  // Wrapped: a memory failure must never take the collections scan down.
  try {
    const caseIds = new Map<string, string[]>();
    for (const row of store.cases.list(merchantId)) {
      if (CLOSED_CASE.test(row.status ?? "")) continue;
      try {
        const body = JSON.parse(row.body_json) as Record<string, any>;
        const inv = body.related_invoice ?? body.invoice_id;
        if (typeof inv === "string" && inv) {
          const arr = caseIds.get(inv) ?? [];
          arr.push(row.id);
          caseIds.set(inv, arr);
        }
      } catch {
        /* an unparseable case body links nothing */
      }
    }
    report.customersUpdated = updateCustomerMemories(store, merchantId, items, {
      now,
      updatedBy: COLLECTIONS_SCAN_JOB,
      caseIdsByInvoice: caseIds,
    });
  } catch (e) {
    report.notes.push(
      `Customer memory update failed (${e instanceof Error ? e.message.slice(0, 160) : String(e)}); collections planning continued without it.`
    );
  }

  const plan = planCollections(items, {
    now,
    maxRung: policy.collections.max_rung,
    disputedInvoiceIds: disputedInvoiceIds(store, merchantId),
  });
  report.blockedDispute = plan.blocked_dispute;
  report.skippedPaid = plan.skipped_paid;

  const applied = applyCollectionsPlan(store, plan, {
    merchantId,
    now,
    policy,
    state: loadState(store, merchantId),
  });
  report.proposalsCreated = applied.created;
  report.skipped = applied.skipped;

  store.jobState.set({
    job_name: COLLECTIONS_SCAN_JOB,
    merchant_id: merchantId,
    cursor_json: JSON.stringify(applied.state),
    last_run_at: now.toISOString(),
    last_status: "ok",
  });
  trace(true);
  return report;
}
