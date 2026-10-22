// Reconcile sweep (ARCHITECTURE-DETAIL.md §6 + §4.3 step 6) — Phase 1D,
// closing the Phase 1A.4 debt.
//
// When a write's read-back cannot confirm the result, the executor flags
// the ledger row RECONCILE_NEEDED instead of re-running the write. This
// sweep is the follow-up: for every flagged row it reads the real state
// back (through the executor, the same single path) and —
//   matches  → clears the flag and ledgers the reconciliation;
//   still off, age ≤ 24h → leaves the flag, tries again next run;
//   still off, age > 24h → raises ONE instant alert (§6 escalation), the
//     row stays flagged until a human or a later match resolves it.
// Read-back functions are injectable: production defaults cover the custom
// REST tool we own (provide_evidence → get_dispute via the executor);
// toolkit writes can be wired in by passing `readBack` per tool name.
import {
  DEFAULT_MERCHANT_ID,
  type GuardianStore,
  type LedgerRow,
} from "../db";
import type { GuardianExecutor } from "../executor";
import { getExecutor } from "../executor";
import { registerCoreTools, evidenceMatches } from "../tools";
import { recordAlert } from "../alerts";

export const RECONCILE_JOB = "reconcile";
const HOUR_MS = 3600_000;

/**
 * Returns true when PayPal's current state matches what the flagged write
 * intended. Injected in tests; defaults exist for provide_evidence.
 */
export type ReconcileReadBack = (row: LedgerRow) => Promise<boolean>;

export interface ReconcileOptions {
  merchantId?: string;
  now?: Date;
  executor?: GuardianExecutor;
  /** per-tool read-back override: tool name → fn */
  readBacks?: Record<string, ReconcileReadBack>;
  /** hours a mismatch may age before it escalates to an instant alert */
  staleAlertHours?: number;
}

export interface ReconcileReport {
  merchantId: string;
  ranAt: string;
  checked: number;
  reconciled: number[];
  stillOff: number[];
  alerted: number[];
  noGetter: number[];
  errors: { ledgerId: number; error: string }[];
}

function defaultReadBacks(executor: GuardianExecutor): Record<string, ReconcileReadBack> {
  registerCoreTools(executor);
  return {
    provide_evidence: async (row) => {
      let args: any = {};
      try {
        args = JSON.parse(row.args_redacted_json ?? "{}");
      } catch {
        return false;
      }
      if (!args?.dispute_id || !Array.isArray(args?.evidences)) return false;
      const res = await executor.execute(
        "get_dispute",
        { dispute_id: args.dispute_id },
        { actor: RECONCILE_JOB }
      );
      const dispute: any = res.data;
      const onFile: any[] = Array.isArray(dispute?.evidences) ? dispute.evidences : [];
      return args.evidences.every((ev: any) =>
        onFile.some((e) => evidenceMatches(e, ev))
      );
    },
  };
}

interface ReconcileCursor {
  alerted: number[];
}

function loadCursor(store: GuardianStore, merchantId: string): ReconcileCursor {
  const row = store.jobState.get(RECONCILE_JOB, merchantId);
  if (row?.cursor_json) {
    try {
      const parsed = JSON.parse(row.cursor_json) as ReconcileCursor;
      if (parsed && Array.isArray(parsed.alerted)) return parsed;
    } catch {
      /* fresh cursor */
    }
  }
  return { alerted: [] };
}

export async function runReconcileSweep(
  store: GuardianStore,
  opts?: ReconcileOptions
): Promise<ReconcileReport> {
  const merchantId = opts?.merchantId ?? DEFAULT_MERCHANT_ID;
  const now = opts?.now ?? new Date();
  const staleHours = opts?.staleAlertHours ?? 24;
  // Lazy defaults: building them wires the shared executor + file store,
  // which injected-readBack callers (tests) must never touch.
  let defaults: Record<string, ReconcileReadBack> | null = null;
  const readBackFor = (tool: string): ReconcileReadBack | undefined => {
    if (opts?.readBacks && tool in opts.readBacks) return opts.readBacks[tool];
    defaults ??= defaultReadBacks(opts?.executor ?? getExecutor());
    return defaults[tool];
  };
  const cursor = loadCursor(store, merchantId);
  const alertedSet = new Set(cursor.alerted);

  const report: ReconcileReport = {
    merchantId,
    ranAt: now.toISOString(),
    checked: 0,
    reconciled: [],
    stillOff: [],
    alerted: [],
    noGetter: [],
    errors: [],
  };

  const flagged = store.ledger.flagged(merchantId);
  for (const row of flagged) {
    report.checked++;
    const readBack = row.tool ? readBackFor(row.tool) : undefined;
    if (!readBack) {
      report.noGetter.push(row.id); // counted, never silently dropped
      continue;
    }
    try {
      const matches = await readBack(row);
      if (matches) {
        store.ledger.setReconcileFlag(row.id, false);
        alertedSet.delete(row.id);
        report.reconciled.push(row.id);
        store.ledger.append({
          merchant_id: merchantId,
          actor: RECONCILE_JOB,
          kind: "job",
          tool: RECONCILE_JOB,
          result_json: JSON.stringify({
            ok: true,
            action: "reconciled",
            ledger_id: row.id,
            original_tool: row.tool,
          }),
        });
      } else {
        report.stillOff.push(row.id);
        const ageHours = (now.getTime() - Date.parse(row.at)) / HOUR_MS;
        if (ageHours > staleHours && !alertedSet.has(row.id)) {
          alertedSet.add(row.id);
          recordAlert(store, {
            merchantId,
            actor: RECONCILE_JOB,
            name: "reconcile_still_mismatched",
            payload: {
              ledger_id: row.id,
              original_tool: row.tool,
              age_hours: Math.round(ageHours * 10) / 10,
              note: "Write result still unverified after read-back; do not re-run the write blind",
            },
          });
          report.alerted.push(row.id);
        }
      }
    } catch (e) {
      report.errors.push({
        ledgerId: row.id,
        error: e instanceof Error ? e.message.slice(0, 300) : String(e),
      });
    }
  }

  store.jobState.set({
    job_name: RECONCILE_JOB,
    merchant_id: merchantId,
    cursor_json: JSON.stringify({ alerted: [...alertedSet] }),
    last_run_at: now.toISOString(),
    last_status: report.errors.length ? "ok_with_errors" : "ok",
  });
  store.ledger.append({
    merchant_id: merchantId,
    actor: RECONCILE_JOB,
    kind: "job",
    tool: RECONCILE_JOB,
    result_json: JSON.stringify({
      ok: report.errors.length === 0,
      checked: report.checked,
      reconciled: report.reconciled,
      still_off: report.stillOff,
      alerted: report.alerted,
      no_getter: report.noGetter,
      errors: report.errors,
    }),
  });

  return report;
}
