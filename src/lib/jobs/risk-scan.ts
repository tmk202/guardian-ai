// Account risk scan job (ARCHITECTURE-DETAIL.md §6 watchers,
// PHASES 4B) — Phase 4A.
//
// Gathers the measurable risk signals for one merchant — dispute rate
// and money at risk from the Analyst (§3.4), case deadlines from the
// cases table, held funds from the Hold Radar's memory — grades them
// with the pure worker (workers/risk-scan.ts) against the merchant's
// policy thresholds, and raises ONE instant alert per day while the
// level is HIGH (WATCH/LOW ride the digest; a HIGH that persists must
// not spam). A signal that cannot be measured is reported in
// signals_missing with its reason — never faked (§6: a watcher that
// ran must leave a trace; silence is a failure mode).
import { DEFAULT_MERCHANT_ID, type GuardianStore } from "../db";
import { getPolicy, type GuardianPolicy } from "../policy";
import { memoryRead } from "../memory";
import { recordAlert } from "../alerts";
import {
  runAnalyst,
  trailingRange,
  executorReaders,
  type PayPalReaders,
} from "../workers/analyst";
import {
  assessRisk,
  type RiskAssessment,
  type RiskDeadlineCase,
  type RiskInputs,
} from "../workers/risk-scan";
import { HOLD_RADAR_JOB } from "./hold-radar";

export const RISK_SCAN_JOB = "risk-scan";
const CLOSED_CASE = /^(RESOLVED|CLOSED|DENIED|CANCELLED)/i;
const HOUR_MS = 3600_000;

export interface RiskScanOptions {
  merchantId?: string;
  now?: Date;
  timezone?: string;
  /** injectable for tests; defaults to the executor-backed readers */
  readers?: PayPalReaders;
  policy?: GuardianPolicy;
}

export interface RiskScanReport {
  merchantId: string;
  ranAt: string;
  /** merchant-local day (YYYY-MM-DD) — the alert idempotency key */
  date: string;
  status: "ok" | "error";
  level: RiskAssessment["level"] | null;
  assessment: RiskAssessment | null;
  inputs: RiskInputs | null;
  /** invoice list items with no invoice_date — excluded from the window count */
  undatedInvoices: number;
  alertsRaised: { level: string; ledgerId: number }[];
  notes: string[];
}

interface RiskCursor {
  lastHighAlertDate?: string;
  lastLevel?: string;
}

/** Merchant-local calendar day, YYYY-MM-DD (digest uses the same notion). */
export function localDate(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function loadCursor(store: GuardianStore, merchantId: string): RiskCursor {
  const row = store.jobState.get(RISK_SCAN_JOB, merchantId);
  if (row?.cursor_json) {
    try {
      return JSON.parse(row.cursor_json) as RiskCursor;
    } catch {
      /* fall through to a fresh cursor */
    }
  }
  return {};
}

function invoiceDate(item: any): string | null {
  const v =
    item?.detail?.invoice_date ??
    item?.invoice_date ??
    item?.detail?.create_time ??
    null;
  return typeof v === "string" && v && !Number.isNaN(Date.parse(v)) ? v : null;
}

/** Held funds as tracked by the Hold Radar; null when holds aren't observable. */
function heldFunds(
  store: GuardianStore,
  merchantId: string
): { heldUsd: number | null; heldCount: number } {
  const radar = store.jobState.get(HOLD_RADAR_JOB, merchantId);
  if (!radar || radar.last_status !== "ok") return { heldUsd: null, heldCount: 0 };
  let total = 0;
  let count = 0;
  for (const e of memoryRead(store, merchantId, { kind: "C" })) {
    if (!e.entityKey.startsWith("hold:")) continue;
    if (e.body.status !== "held") continue;
    const amt = typeof e.body.amount === "number" ? e.body.amount : 0;
    total += amt;
    count++;
  }
  return { heldUsd: Math.round(total * 100) / 100, heldCount: count };
}

export async function runRiskScan(
  store: GuardianStore,
  opts?: RiskScanOptions
): Promise<RiskScanReport> {
  const merchantId = opts?.merchantId ?? DEFAULT_MERCHANT_ID;
  const now = opts?.now ?? new Date();
  const timezone = opts?.timezone ?? "Asia/Saigon";
  const readers = opts?.readers ?? executorReaders();
  const policy = opts?.policy ?? getPolicy();
  const date = localDate(now, timezone);

  const report: RiskScanReport = {
    merchantId,
    ranAt: now.toISOString(),
    date,
    status: "ok",
    level: null,
    assessment: null,
    inputs: null,
    undatedInvoices: 0,
    alertsRaised: [],
    notes: [],
  };

  const finish = (ok: boolean, cursor: RiskCursor): RiskScanReport => {
    store.jobState.set({
      job_name: RISK_SCAN_JOB,
      merchant_id: merchantId,
      cursor_json: JSON.stringify(cursor),
      last_run_at: now.toISOString(),
      last_status: ok ? report.assessment?.level ?? "ok" : "error",
    });
    store.ledger.append({
      merchant_id: merchantId,
      actor: RISK_SCAN_JOB,
      kind: "job",
      tool: RISK_SCAN_JOB,
      result_json: JSON.stringify({
        ok,
        level: report.level,
        dispute_rate: report.assessment?.disputeRate ?? null,
        reasons: report.assessment?.reasons.map((r) => r.signal) ?? [],
        signals_missing: report.assessment?.signalsMissing.length ?? 0,
        alerts: report.alertsRaised.length,
        notes: report.notes,
      }),
    });
    return report;
  };

  const cursor = loadCursor(store, merchantId);

  // ---- gather signals -------------------------------------------------------
  let inputs: RiskInputs;
  try {
    const range = trailingRange(policy.risk.window_days, now);
    const analyst = await runAnalyst(store, readers, range, { merchantId, timezone });

    // Dispute-rate denominator: invoices whose invoice_date falls inside
    // the window. The list API has no date filter, so undated items are
    // excluded and counted — reported, never silently folded in.
    const inv = await readers.listInvoices();
    const items: any[] = Array.isArray(inv?.items) ? inv.items : [];
    const startMs = Date.parse(range.start);
    const endMs = Date.parse(range.end);
    let inWindow = 0;
    for (const item of items) {
      const d = invoiceDate(item);
      if (!d) {
        report.undatedInvoices++;
        continue;
      }
      const ms = Date.parse(d);
      if (ms >= startMs && ms <= endMs) inWindow++;
    }
    if (report.undatedInvoices > 0) {
      report.notes.push(
        `${report.undatedInvoices} invoice(s) carried no invoice_date and were excluded from the ${policy.risk.window_days}-day window count.`
      );
    }
    report.notes.push(...analyst.notes);

    const deadlineCases: RiskDeadlineCase[] = store
      .cases.list(merchantId)
      .filter((row) => !CLOSED_CASE.test(row.status ?? "") && row.deadline_at)
      .map((row) => ({
        caseId: row.id,
        hoursLeft: (Date.parse(row.deadline_at as string) - now.getTime()) / HOUR_MS,
      }));

    const held = heldFunds(store, merchantId);

    inputs = {
      windowDays: policy.risk.window_days,
      invoicesInWindow: inWindow,
      openDisputes: analyst.at_risk.open_disputes,
      atRiskUsd: analyst.at_risk.amount,
      atRiskCurrency: analyst.at_risk.currency,
      deadlineCases,
      heldUsd: held.heldUsd,
      heldCount: held.heldCount,
    };
  } catch (e) {
    report.status = "error";
    report.notes.push(
      `Risk scan could not gather its signals (${e instanceof Error ? e.message.slice(0, 200) : String(e)}); no level was graded.`
    );
    return finish(false, cursor);
  }

  // ---- grade + alert ----------------------------------------------------------
  const assessment = assessRisk(inputs, policy.risk);
  report.inputs = inputs;
  report.assessment = assessment;
  report.level = assessment.level;

  if (assessment.level === "HIGH" && cursor.lastHighAlertDate !== date) {
    const ledgerId = recordAlert(store, {
      merchantId,
      actor: RISK_SCAN_JOB,
      name: "risk_high",
      payload: {
        level: assessment.level,
        dispute_rate: assessment.disputeRate,
        reasons: assessment.reasons.map((r) => ({
          signal: r.signal,
          detail: r.detail,
          action: r.action,
        })),
        signals_missing: assessment.signalsMissing,
      },
    });
    report.alertsRaised.push({ level: assessment.level, ledgerId });
    cursor.lastHighAlertDate = date;
  }
  cursor.lastLevel = assessment.level;

  return finish(true, cursor);
}
