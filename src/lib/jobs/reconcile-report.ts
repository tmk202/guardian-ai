// Reconciliation report job (PHASES 5.4, pain #10) — Phase 5C.
//
// Wraps workers/reconcile-report.ts as a §6 watcher: run the check,
// ledger the summary, and stash the counts in job state so the morning
// digest can quote ONE line ("Reconciliation: N matched / M
// mismatched") without re-reading PayPal itself. The Phase 1 sweep
// (jobs/reconcile.ts) is untouched — mismatches found here are flagged
// RECONCILE_NEEDED on their ledger rows, which is exactly the sweep's
// worklist.
import { DEFAULT_MERCHANT_ID, type GuardianStore } from "../db";
import {
  buildReconcileReport,
  executorReconcileReaders,
  type ReconcileReportReaders,
  type ReconcileReportResult,
} from "../workers/reconcile-report";

export const RECONCILE_REPORT_JOB = "reconcile-report";

export interface ReconcileSummary {
  checked: number;
  matched: number;
  mismatched: number;
  unverifiable: number;
  lastRunAt: string;
}

/** The last report's counts as stored by the job — the digest's source. */
export function lastReconcileSummary(
  store: GuardianStore,
  merchantId: string = DEFAULT_MERCHANT_ID
): ReconcileSummary | null {
  const row = store.jobState.get(RECONCILE_REPORT_JOB, merchantId);
  if (!row?.cursor_json) return null;
  try {
    const parsed = JSON.parse(row.cursor_json) as { summary?: ReconcileSummary };
    return parsed.summary ?? null;
  } catch {
    return null;
  }
}

export interface ReconcileReportJobOptions {
  merchantId?: string;
  now?: Date;
  /** injectable for tests; defaults to the executor-backed readers */
  readers?: ReconcileReportReaders;
}

export interface ReconcileReportJobResult extends ReconcileReportResult {
  ledgerId: number;
}

export async function runReconcileReport(
  store: GuardianStore,
  opts?: ReconcileReportJobOptions
): Promise<ReconcileReportJobResult> {
  const merchantId = opts?.merchantId ?? DEFAULT_MERCHANT_ID;
  const now = opts?.now ?? new Date();
  const readers = opts?.readers ?? executorReconcileReaders();

  const report = await buildReconcileReport(store, readers, { merchantId, now });

  const summary: ReconcileSummary = {
    checked: report.checked,
    matched: report.matched.length,
    mismatched: report.mismatched.length,
    unverifiable: report.unverifiable.length,
    lastRunAt: report.ranAt,
  };
  const ledgerId = store.ledger.append({
    merchant_id: merchantId,
    actor: RECONCILE_REPORT_JOB,
    kind: "job",
    tool: RECONCILE_REPORT_JOB,
    result_json: JSON.stringify({
      ok: report.mismatched.length === 0,
      ...summary,
      mismatched_ledger_ids: report.mismatched.map((m) => m.ledgerId),
    }),
  });
  store.jobState.set({
    job_name: RECONCILE_REPORT_JOB,
    merchant_id: merchantId,
    cursor_json: JSON.stringify({ summary }),
    last_run_at: now.toISOString(),
    last_status: report.mismatched.length ? "ok_with_mismatches" : "ok",
  });

  return { ...report, ledgerId };
}
