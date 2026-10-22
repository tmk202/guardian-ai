// Outcome scan job (ARCHITECTURE-DETAIL.md §6 Memory Keeper, §3.6) —
// Phase 5A. The nightly learner's deterministic core: scan tracked
// cases, record memory-E outcomes for the ones PayPal reports RESOLVED,
// and leave a trace in the ledger either way (§6: a watcher that ran
// must never vanish silently).
import { DEFAULT_MERCHANT_ID, type GuardianStore } from "../db";
import {
  scanCaseOutcomes,
  executorOutcomeReaders,
  type OutcomeReaders,
  type OutcomesScanResult,
} from "../workers/outcomes";

export const OUTCOMES_SCAN_JOB = "outcomes-scan";

export interface OutcomesScanOptions {
  merchantId?: string;
  now?: Date;
  /** injectable for tests; defaults to the executor-backed reader */
  readers?: OutcomeReaders;
}

export interface OutcomesScanReport extends OutcomesScanResult {
  ledgerId: number;
}

export async function runOutcomesScan(
  store: GuardianStore,
  opts?: OutcomesScanOptions
): Promise<OutcomesScanReport> {
  const merchantId = opts?.merchantId ?? DEFAULT_MERCHANT_ID;
  const now = opts?.now ?? new Date();
  const readers = opts?.readers ?? executorOutcomeReaders();

  const result = await scanCaseOutcomes(store, readers, { merchantId, now });

  const ledgerId = store.ledger.append({
    merchant_id: merchantId,
    actor: OUTCOMES_SCAN_JOB,
    kind: "job",
    tool: OUTCOMES_SCAN_JOB,
    result_json: JSON.stringify({
      ok: result.errors.length === 0,
      scanned: result.scanned,
      recorded: result.recorded.map((o) => ({
        case_id: o.caseId,
        outcome: o.outcome,
        reason: o.reason,
      })),
      still_open: result.stillOpen.map((o) => o.caseId),
      already_recorded: result.alreadyRecorded,
      errors: result.errors,
    }),
  });
  store.jobState.set({
    job_name: OUTCOMES_SCAN_JOB,
    merchant_id: merchantId,
    cursor_json: JSON.stringify({
      lastRunAt: now.toISOString(),
      recordedTotal: result.recorded.length,
      stillOpen: result.stillOpen.length,
    }),
    last_run_at: now.toISOString(),
    last_status: result.errors.length ? "ok_with_errors" : "ok",
  });

  return { ...result, ledgerId };
}
