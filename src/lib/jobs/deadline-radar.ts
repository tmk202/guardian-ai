// Deadline radar (ARCHITECTURE-DETAIL.md §6, PHASES 1D.3) — Phase 1D.
//
// The pain this kills: miss a dispute response deadline and the case is
// lost automatically (REDDIT-PROBLEMS #3). The radar scans every open case
// in the cases table and escalates by time left:
//   < 7 days  → digest list (reported once per case)
//   < 48h     → instant alert (once per case)
//   < 24h     → one single reminder, and only if the merchant still has
//               neither evidence on file nor a provide_evidence approval
//               in flight (§6: "nhắc lại 1 lần duy nhất")
// Dedup state lives in job_state.cursor_json: { notified: {caseId: {7d|48h|24h: iso|"satisfied"}} }.
//
// Deadlines are never invented: if a case has none stored, the radar tries
// to fetch the real one through the executor's READ get_dispute and only
// then updates the case row + case memory. If PayPal's payload carries no
// deadline either, the case is reported as unknown and left alone.
import {
  DEFAULT_MERCHANT_ID,
  type CaseRow,
  type GuardianStore,
} from "../db";
import type { GuardianExecutor } from "../executor";
import { getExecutor } from "../executor";
import { registerCoreTools } from "../tools";
import { extractDisputeDeadline } from "../triage";
import { memoryRead, memoryWrite } from "../memory";
import { recordAlert } from "../alerts";

export const DEADLINE_RADAR_JOB = "deadline-radar";
const HOUR_MS = 3600_000;
const CLOSED_STATUS = /^(RESOLVED|CLOSED|DENIED|CANCELLED)/i;

export type DisputeReader = (caseId: string) => Promise<unknown>;

/** Production reader: get_dispute through the single executor path (§4.3). */
export function executorDisputeReader(
  executor: GuardianExecutor = getExecutor()
): DisputeReader {
  registerCoreTools(executor);
  return async (caseId: string) => {
    const res = await executor.execute("get_dispute", { dispute_id: caseId }, {
      actor: DEADLINE_RADAR_JOB,
    });
    return res.data;
  };
}

export interface DeadlineRadarOptions {
  merchantId?: string;
  now?: Date;
  /** injectable for tests; defaults to the executor-backed reader */
  readDispute?: DisputeReader;
}

export interface RadarDigestItem {
  caseId: string;
  deadlineAt: string;
  hoursLeft: number;
}
export interface RadarAlertItem extends RadarDigestItem {
  milestone: "48h" | "24h";
  ledgerId: number;
}

export interface DeadlineRadarReport {
  merchantId: string;
  ranAt: string;
  casesChecked: number;
  openCases: number;
  deadlinesFetched: string[];
  digest: RadarDigestItem[];
  alerts: RadarAlertItem[];
  unknownDeadline: string[];
  errors: { caseId: string; error: string }[];
}

interface RadarCursor {
  notified: Record<string, Record<string, string>>;
}

function loadCursor(store: GuardianStore, merchantId: string): RadarCursor {
  const row = store.jobState.get(DEADLINE_RADAR_JOB, merchantId);
  if (row?.cursor_json) {
    try {
      const parsed = JSON.parse(row.cursor_json) as RadarCursor;
      if (parsed && typeof parsed.notified === "object") return parsed;
    } catch {
      /* fall through to a fresh cursor */
    }
  }
  return { notified: {} };
}

function isOpen(row: CaseRow): boolean {
  return !CLOSED_STATUS.test(row.status ?? "");
}

function bodyOf(row: CaseRow): Record<string, any> {
  try {
    return JSON.parse(row.body_json) as Record<string, any>;
  } catch {
    return {};
  }
}

function deadlineOf(row: CaseRow): string | null {
  if (row.deadline_at && !Number.isNaN(Date.parse(row.deadline_at))) {
    return row.deadline_at;
  }
  const fromBody = extractDisputeDeadline(bodyOf(row));
  return fromBody;
}

function hasEvidenceOrApproval(store: GuardianStore, merchantId: string, row: CaseRow): boolean {
  const body = bodyOf(row);
  const evidence = body.evidence_submitted;
  if (Array.isArray(evidence) && evidence.length > 0) return true;
  return store
    .approvals.list(merchantId)
    .some(
      (a) =>
        a.tool === "provide_evidence" &&
        a.args_json.includes(row.id) &&
        (a.status === "PENDING" || a.status === "APPROVED" || a.status === "EXECUTED")
    );
}

/** Persist a fetched deadline into the cases table AND case memory (kind C). */
function persistDeadline(
  store: GuardianStore,
  merchantId: string,
  row: CaseRow,
  deadline: string
): void {
  const body = { ...bodyOf(row), deadline_at: deadline };
  store.cases.upsert({
    id: row.id,
    merchant_id: merchantId,
    body_json: JSON.stringify(body),
    deadline_at: deadline,
    status: row.status,
  });
  const existing = memoryRead(store, merchantId, { kind: "C", entity: row.id })[0];
  if (existing) {
    memoryWrite(store, {
      merchantId,
      kind: "C",
      entityKey: row.id,
      body: { ...existing.body, deadline_at: deadline },
      source: "deadline-radar: get_dispute read-back",
      confidence: 1,
    });
  }
}

export async function runDeadlineRadar(
  store: GuardianStore,
  opts?: DeadlineRadarOptions
): Promise<DeadlineRadarReport> {
  const merchantId = opts?.merchantId ?? DEFAULT_MERCHANT_ID;
  const now = opts?.now ?? new Date();
  // Lazy: the default reader wires the shared executor + file store, which
  // tests must never touch — build it only when a case actually lacks a
  // stored deadline.
  let readDispute = opts?.readDispute;
  const cursor = loadCursor(store, merchantId);
  const report: DeadlineRadarReport = {
    merchantId,
    ranAt: now.toISOString(),
    casesChecked: 0,
    openCases: 0,
    deadlinesFetched: [],
    digest: [],
    alerts: [],
    unknownDeadline: [],
    errors: [],
  };

  const cases = store.cases.list(merchantId);
  report.casesChecked = cases.length;

  for (const row of cases) {
    if (!isOpen(row)) continue;
    report.openCases++;
    try {
      let deadline = deadlineOf(row);
      if (!deadline) {
        readDispute ??= executorDisputeReader();
        const dispute = await readDispute(row.id);
        deadline = extractDisputeDeadline(dispute);
        if (deadline) {
          persistDeadline(store, merchantId, row, deadline);
          report.deadlinesFetched.push(row.id);
        } else {
          report.unknownDeadline.push(row.id);
          continue;
        }
      }

      const hoursLeft = (Date.parse(deadline) - now.getTime()) / HOUR_MS;
      const notified = (cursor.notified[row.id] ??= {});
      const item = {
        caseId: row.id,
        deadlineAt: deadline,
        hoursLeft: Math.round(hoursLeft * 10) / 10,
      };

      if (hoursLeft < 24 * 7 && !notified["7d"]) {
        notified["7d"] = now.toISOString();
        report.digest.push(item);
      }
      if (hoursLeft < 48 && !notified["48h"]) {
        notified["48h"] = now.toISOString();
        const ledgerId = recordAlert(store, {
          merchantId,
          actor: DEADLINE_RADAR_JOB,
          name: "dispute_deadline_risk",
          payload: { case_id: row.id, milestone: "48h", deadline_at: deadline, hours_left: item.hoursLeft },
        });
        report.alerts.push({ ...item, milestone: "48h", ledgerId });
      }
      if (hoursLeft < 24 && !notified["24h"]) {
        if (hasEvidenceOrApproval(store, merchantId, row)) {
          notified["24h"] = "satisfied"; // nothing to remind about
        } else {
          notified["24h"] = now.toISOString();
          const ledgerId = recordAlert(store, {
            merchantId,
            actor: DEADLINE_RADAR_JOB,
            name: "dispute_deadline_final_reminder",
            payload: {
              case_id: row.id,
              milestone: "24h",
              deadline_at: deadline,
              hours_left: item.hoursLeft,
              note: "No evidence on file and no provide_evidence approval in flight",
            },
          });
          report.alerts.push({ ...item, milestone: "24h", ledgerId });
        }
      }
    } catch (e) {
      report.errors.push({
        caseId: row.id,
        error: e instanceof Error ? e.message.slice(0, 300) : String(e),
      });
    }
  }

  store.jobState.set({
    job_name: DEADLINE_RADAR_JOB,
    merchant_id: merchantId,
    cursor_json: JSON.stringify(cursor),
    last_run_at: now.toISOString(),
    last_status: report.errors.length ? "ok_with_errors" : "ok",
  });
  // A watcher that ran must leave a trace even when it found nothing (§6:
  // silent background work is a failure mode).
  store.ledger.append({
    merchant_id: merchantId,
    actor: DEADLINE_RADAR_JOB,
    kind: "job",
    tool: DEADLINE_RADAR_JOB,
    result_json: JSON.stringify({
      ok: report.errors.length === 0,
      cases_checked: report.casesChecked,
      open_cases: report.openCases,
      deadlines_fetched: report.deadlinesFetched,
      digest: report.digest.map((d) => d.caseId),
      alerts: report.alerts.map((a) => `${a.caseId}:${a.milestone}`),
      unknown_deadline: report.unknownDeadline,
      errors: report.errors,
    }),
  });

  return report;
}
