// Morning digest (PHASES 2.3, ARCHITECTURE-DETAIL.md §6) — Phase 2C.
//
// One factual summary per merchant per day, assembled from the same
// sources the watchers write: the Analyst query layer (money in /
// outstanding / at risk), the invoices read (overdue), the cases table
// (deadlines inside 7 days), the ledger (instant alerts not yet folded
// into a digest) and the approvals table (what waits on the merchant).
// No LLM prose here — this is the data pack; wording for the user is a
// later layer. Idempotent per merchant-local day: a second run on the
// same day returns the stored report with alreadyDone=true and writes
// nothing new.
import { DEFAULT_MERCHANT_ID, type GuardianStore } from "../db";
import { memoryRead } from "../memory";
import {
  runAnalyst,
  executorReaders,
  type PayPalReaders,
} from "../workers/analyst";
import { HOLD_RADAR_JOB } from "./hold-radar";
import { lastReconcileSummary } from "./reconcile-report";

export const DIGEST_JOB = "digest";
const DAY_MS = 24 * 3600_000;
const CLOSED_CASE = /^(RESOLVED|CLOSED|DENIED|CANCELLED)/i;
const UNPAID_STATUSES = new Set(["SENT", "UNPAID", "PARTIALLY_PAID", "PAYMENT_PENDING"]);

export interface DigestOptions {
  merchantId?: string;
  now?: Date;
  timezone?: string;
  /** injectable for tests; defaults to the executor-backed readers */
  readers?: PayPalReaders;
}

export interface MorningDigest {
  merchantId: string;
  /** merchant-local day this digest covers, YYYY-MM-DD */
  date: string;
  timezone: string;
  generatedAt: string;
  alreadyDone: boolean;
  moneyYesterday: { amount: number; currency: string } | null;
  outstanding: { amount: number; currency: string; count: number };
  atRisk: { amount: number; currency: string; open_disputes: number };
  /** held payments as tracked by the Hold Radar (Phase 3A, memory kind C) */
  holds: {
    total: number;
    currency: string;
    count: number;
    /** soonest ESTIMATED release among tracked holds, when one exists */
    nextEstimatedRelease: {
      transaction_id: string;
      amount: number;
      estimated_release_at: string;
    } | null;
  };
  overdueInvoices: {
    invoice_id: string;
    amount: number;
    currency: string;
    due_date: string;
  }[];
  upcomingDeadlines: { caseId: string; deadlineAt: string; hoursLeft: number }[];
  unhandledAlerts: { ledgerId: number; name: string; at: string }[];
  pendingApprovals: {
    id: string;
    tool: string;
    amount_usd: number | null;
    created_at: string;
  }[];
  /** last reconciliation report's verdict counts (Phase 5C); lastRunAt
   *  is null when no report has ever run for this merchant */
  reconciliation: {
    matched: number;
    mismatched: number;
    unverifiable: number;
    lastRunAt: string | null;
  };
  notes: string[];
  text: string;
  ledgerId?: number;
}

interface DigestCursor {
  lastDate?: string;
  lastAlertLedgerId?: number;
  report?: MorningDigest;
}

// --- merchant-local day helpers (timezone-correct without a date lib) ------
function localParts(tz: string, date: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

function tzOffsetMs(tz: string, date: Date): number {
  const asLocal = new Date(date.toLocaleString("en-US", { timeZone: tz }));
  return asLocal.getTime() - date.getTime();
}

/** UTC instant of merchant-local midnight on the given local date. */
function localMidnightUtc(tz: string, y: number, m: number, d: number): Date {
  const guess = Date.UTC(y, m - 1, d);
  return new Date(guess - tzOffsetMs(tz, new Date(guess)));
}

const fmtDate = (p: { y: number; m: number; d: number }) =>
  `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
const money = (a: number, c: string) => `$${a.toFixed(2)} ${c}`;

export async function runDigest(
  store: GuardianStore,
  opts?: DigestOptions
): Promise<MorningDigest> {
  const merchantId = opts?.merchantId ?? DEFAULT_MERCHANT_ID;
  const tz = opts?.timezone ?? "Asia/Saigon";
  const now = opts?.now ?? new Date();
  const readers = opts?.readers ?? executorReaders();

  const today = localParts(tz, now);
  const dateStr = fmtDate(today);
  const todayStart = localMidnightUtc(tz, today.y, today.m, today.d);
  const yesterdayStart = new Date(todayStart.getTime() - DAY_MS);

  const stateRow = store.jobState.get(DIGEST_JOB, merchantId);
  let cursor: DigestCursor = {};
  if (stateRow?.cursor_json) {
    try {
      cursor = JSON.parse(stateRow.cursor_json) as DigestCursor;
    } catch {
      cursor = {};
    }
  }
  if (cursor.lastDate === dateStr && cursor.report) {
    // Reports stored before Phase 3A have no holds block, and reports
    // stored before Phase 5C have no reconciliation block — normalise.
    return {
      ...cursor.report,
      holds: cursor.report.holds ?? { total: 0, currency: "USD", count: 0, nextEstimatedRelease: null },
      reconciliation: cursor.report.reconciliation ?? {
        matched: 0,
        mismatched: 0,
        unverifiable: 0,
        lastRunAt: null,
      },
      alreadyDone: true,
    };
  }

  const notes: string[] = [];
  let degraded = false;

  // ---- money block via the Analyst (yesterday, merchant-local) -------------
  let moneyYesterday: MorningDigest["moneyYesterday"] = null;
  let outstanding: MorningDigest["outstanding"] = { amount: 0, currency: "USD", count: 0 };
  let atRisk: MorningDigest["atRisk"] = { amount: 0, currency: "USD", open_disputes: 0 };
  try {
    const report = await runAnalyst(
      store,
      readers,
      { start: yesterdayStart.toISOString(), end: todayStart.toISOString() },
      { merchantId, timezone: tz }
    );
    moneyYesterday = report.money_in;
    outstanding = report.outstanding;
    atRisk = {
      amount: report.at_risk.amount,
      currency: report.at_risk.currency,
      open_disputes: report.at_risk.open_disputes,
    };
    notes.push(...report.notes);
  } catch (e) {
    degraded = true;
    notes.push(
      `Analyst read failed (${e instanceof Error ? e.message.slice(0, 160) : String(e)}); money figures are missing from this digest.`
    );
  }

  // ---- holds (Hold Radar memory, Phase 3A) ----------------------------------
  // The radar job maintains one kind-C entry per held transaction; the
  // digest only reads them. Estimates stay labelled estimates.
  const holdEntries = memoryRead(store, merchantId, { kind: "C" }).filter(
    (e) => e.entityKey.startsWith("hold:") && e.body.status === "held"
  );
  const holdsCurrency = (holdEntries[0]?.body.currency as string) ?? "USD";
  let holdsTotal = 0;
  let nextRelease: MorningDigest["holds"]["nextEstimatedRelease"] = null;
  for (const e of holdEntries) {
    const amount = Number(e.body.amount ?? 0);
    if ((e.body.currency as string | undefined) === holdsCurrency && Number.isFinite(amount)) {
      holdsTotal += amount;
    }
    const eta = e.body.estimated_release_at as string | null | undefined;
    if (eta && (!nextRelease || eta < nextRelease.estimated_release_at)) {
      nextRelease = {
        transaction_id: String(e.body.transaction_id ?? e.entityKey.slice("hold:".length)),
        amount: Number.isFinite(amount) ? amount : 0,
        estimated_release_at: eta,
      };
    }
  }
  const holds: MorningDigest["holds"] = {
    total: Math.round(holdsTotal * 100) / 100,
    currency: holdsCurrency,
    count: holdEntries.length,
    nextEstimatedRelease: nextRelease,
  };
  const holdRadarState = store.jobState.get(HOLD_RADAR_JOB, merchantId);
  if (holdRadarState?.last_status === "unavailable") {
    notes.push(
      "Hold tracking is unavailable: the Transaction Search scope is not enabled on the PayPal app, so held amounts cannot be seen yet."
    );
  }

  // ---- overdue invoices (unpaid and past their due date) -------------------
  const overdueInvoices: MorningDigest["overdueInvoices"] = [];
  try {
    const inv = await readers.listInvoices();
    for (const item of (inv?.items ?? []) as any[]) {
      const status = String(item?.status ?? "");
      if (!UNPAID_STATUSES.has(status)) continue;
      const due = item?.due_date ?? item?.detail?.due_date ?? null;
      if (!due) continue;
      if (new Date(`${due}T23:59:59Z`).getTime() < yesterdayStart.getTime() + DAY_MS) {
        overdueInvoices.push({
          invoice_id: String(item?.id ?? ""),
          amount: Math.round(Number(item?.amount?.value ?? 0) * 100) / 100,
          currency: item?.amount?.currency_code ?? "USD",
          due_date: String(due),
        });
      }
    }
    overdueInvoices.sort((a, b) => a.due_date.localeCompare(b.due_date));
  } catch (e) {
    degraded = true;
    notes.push(
      `Invoice read failed (${e instanceof Error ? e.message.slice(0, 160) : String(e)}); overdue list may be incomplete.`
    );
  }

  // ---- deadlines inside 7 days (cases table) -------------------------------
  const upcomingDeadlines = store
    .cases.list(merchantId)
    .filter((row) => !CLOSED_CASE.test(row.status ?? "") && row.deadline_at)
    .map((row) => ({
      caseId: row.id,
      deadlineAt: row.deadline_at as string,
      hoursLeft: Math.round(((Date.parse(row.deadline_at as string) - now.getTime()) / 3600_000) * 10) / 10,
    }))
    .filter((d) => d.hoursLeft >= 0 && d.hoursLeft <= 7 * 24)
    .sort((a, b) => a.hoursLeft - b.hoursLeft);

  // ---- instant alerts not yet folded into a digest --------------------------
  const prevAlertId = cursor.lastAlertLedgerId ?? 0;
  const alertRows = store
    .ledger.list(merchantId, 500)
    .filter((r) => r.kind === "alert" && r.id > prevAlertId);
  const unhandledAlerts = alertRows
    .filter((r) => Date.parse(r.at) >= now.getTime() - 7 * DAY_MS)
    .map((r) => ({ ledgerId: r.id, name: r.tool ?? "alert", at: r.at }));
  const maxAlertId = alertRows.reduce((m, r) => Math.max(m, r.id), prevAlertId);

  // ---- approvals waiting on the merchant ------------------------------------
  const pendingApprovals = store.approvals.list(merchantId, "PENDING").map((a) => ({
    id: a.id,
    tool: a.tool,
    amount_usd: a.amount_usd,
    created_at: a.created_at,
  }));

  // ---- reconciliation (Phase 5C): quote the last report, never re-run it --
  const reconSummary = lastReconcileSummary(store, merchantId);
  const reconciliation: MorningDigest["reconciliation"] = reconSummary
    ? {
        matched: reconSummary.matched,
        mismatched: reconSummary.mismatched,
        unverifiable: reconSummary.unverifiable,
        lastRunAt: reconSummary.lastRunAt,
      }
    : { matched: 0, mismatched: 0, unverifiable: 0, lastRunAt: null };

  // ---- text summary ----------------------------------------------------------
  const lines: string[] = [`Guardian morning digest — ${dateStr} (${tz})`];
  lines.push(
    moneyYesterday
      ? `Money in yesterday: ${money(moneyYesterday.amount, moneyYesterday.currency)}`
      : "Money in yesterday: unavailable (see notes)"
  );
  lines.push(
    `Outstanding: ${money(outstanding.amount, outstanding.currency)} across ${outstanding.count} unpaid invoice(s)`
  );
  for (const o of overdueInvoices) {
    lines.push(`Overdue: ${o.invoice_id} — ${money(o.amount, o.currency)} (due ${o.due_date})`);
  }
  lines.push(
    `At risk: ${money(atRisk.amount, atRisk.currency)} (${atRisk.open_disputes} open dispute(s))`
  );
  lines.push(
    holds.count > 0
      ? `On hold: ${money(holds.total, holds.currency)} across ${holds.count} held payment(s)`
      : "On hold: none tracked"
  );
  if (holds.nextEstimatedRelease) {
    lines.push(
      `Next estimated release: ${money(holds.nextEstimatedRelease.amount, holds.currency)} on ${holds.nextEstimatedRelease.estimated_release_at.slice(0, 10)} (estimate)`
    );
  }
  for (const d of upcomingDeadlines) {
    lines.push(`Deadline <7d: ${d.caseId} — due ${d.deadlineAt} (${d.hoursLeft}h left)`);
  }
  lines.push(
    reconciliation.lastRunAt
      ? `Reconciliation: ${reconciliation.matched} matched / ${reconciliation.mismatched} mismatched (${reconciliation.unverifiable} unverifiable) — last run ${reconciliation.lastRunAt.slice(0, 10)}`
      : "Reconciliation: no report has run yet"
  );
  lines.push(`New instant alerts: ${unhandledAlerts.length}`);
  for (const p of pendingApprovals) {
    lines.push(
      `Waiting for your approval: ${p.tool}${p.amount_usd != null ? ` (${money(p.amount_usd, "USD")})` : ""} — since ${p.created_at}`
    );
  }
  for (const n of notes) lines.push(`Note: ${n}`);

  const digest: MorningDigest = {
    merchantId,
    date: dateStr,
    timezone: tz,
    generatedAt: now.toISOString(),
    alreadyDone: false,
    moneyYesterday,
    outstanding,
    atRisk,
    holds,
    overdueInvoices,
    upcomingDeadlines,
    unhandledAlerts,
    pendingApprovals,
    reconciliation,
    notes,
    text: lines.join("\n"),
  };

  // A watcher that ran must leave a trace (§6) — and the digest is a
  // commitment: exactly one ledger row per merchant per day.
  const ledgerId = store.ledger.append({
    merchant_id: merchantId,
    actor: DIGEST_JOB,
    kind: "job",
    tool: DIGEST_JOB,
    result_json: JSON.stringify({
      ok: !degraded,
      date: dateStr,
      money_in: moneyYesterday,
      outstanding,
      holds: { total: holds.total, currency: holds.currency, count: holds.count },
      overdue: overdueInvoices.map((o) => o.invoice_id),
      deadlines: upcomingDeadlines.map((d) => d.caseId),
      alerts: unhandledAlerts.length,
      pending_approvals: pendingApprovals.map((p) => p.id),
      reconciliation: {
        matched: reconciliation.matched,
        mismatched: reconciliation.mismatched,
        unverifiable: reconciliation.unverifiable,
        last_run_at: reconciliation.lastRunAt,
      },
    }),
  });
  digest.ledgerId = ledgerId;

  store.jobState.set({
    job_name: DIGEST_JOB,
    merchant_id: merchantId,
    cursor_json: JSON.stringify({
      lastDate: dateStr,
      lastAlertLedgerId: maxAlertId,
      report: digest,
    } satisfies DigestCursor),
    last_run_at: now.toISOString(),
    last_status: degraded ? "ok_with_errors" : "ok",
  });

  return digest;
}
