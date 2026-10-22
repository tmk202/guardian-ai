// Hold scan job (ARCHITECTURE-DETAIL.md §6 "Hold scan, daily 07:30",
// PHASES 3A) — Phase 3A.
//
// Reads the last TRANSACTION_WINDOW_DAYS of transactions through the
// executor-backed readers, classifies the held payments with the pure
// worker (workers/hold-radar.ts), and maintains one memory entry per held
// transaction (kind C, entity_key `hold:<txn_id>`):
//   new hold       → memory entry created + instant alert when the amount
//                    reaches the policy threshold (policy.holds.alert_min_usd)
//   known hold     → memory entry updated (superseded, never duplicated),
//                    NEVER alerted twice for the same transaction
//   released hold  → the transaction now reads settled → memory updated to
//                    status "released" with the observation time
//
// When Transaction Search is not available (scope missing on the app) the
// radar reports status "unavailable" WITH the reason and writes its trace
// — it never guesses a held figure (§6: a watcher that ran must leave a
// trace; silence is a failure mode).
import { DEFAULT_MERCHANT_ID, type GuardianStore } from "../db";
import { getPolicy } from "../policy";
import { memoryRead, memoryWrite } from "../memory";
import { recordAlert } from "../alerts";
import {
  trailingRange,
  executorReaders,
  type PayPalReaders,
} from "../workers/analyst";
import {
  classifyHolds,
  type HoldCaseLink,
  type HoldFinding,
  type HoldMerchantFacts,
} from "../workers/hold-radar";
import { PayPalRestError, TRANSACTION_SEARCH_SCOPE } from "../paypal-rest";

export const HOLD_RADAR_JOB = "hold-radar";
/** Transaction Search allows at most 31 days per query — the scan window. */
export const TRANSACTION_WINDOW_DAYS = 31;
const CLOSED_CASE = /^(RESOLVED|CLOSED|DENIED|CANCELLED)/i;

export interface HoldRadarOptions {
  merchantId?: string;
  now?: Date;
  /** injectable for tests; defaults to the executor-backed readers */
  readers?: PayPalReaders;
  /** overrides policy.holds.alert_min_usd */
  alertMinUsd?: number;
}

export interface HoldRadarReport {
  merchantId: string;
  ranAt: string;
  status: "ok" | "unavailable";
  windowDays: number;
  /** transaction records read in the window (0 when unavailable) */
  scanned: number;
  holds: HoldFinding[];
  newHolds: string[];
  updated: string[];
  released: string[];
  alertsRaised: { transaction_id: string; ledgerId: number }[];
  totalHeld: { amount: number; currency: string };
  notes: string[];
}

interface HoldMemoryBody extends Record<string, unknown> {
  transaction_id: string;
  amount: number;
  currency: string;
  status: "held" | "released";
  reason_group: string;
  estimated: boolean;
  estimated_release_at: string | null;
  estimate_basis: string;
  transaction_date: string;
  first_seen_at: string;
  last_seen_at: string;
  case_id?: string;
  released_observed_at?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const holdKey = (txnId: string) => `hold:${txnId}`;

function merchantFacts(store: GuardianStore, merchantId: string): HoldMerchantFacts {
  const profile = memoryRead(store, merchantId, { kind: "A", limit: 1 })[0];
  if (!profile) return {};
  const reserve = profile.body.rolling_reserve as
    | { percent?: unknown; days?: unknown }
    | undefined;
  return {
    account_created_at:
      typeof profile.body.account_created_at === "string"
        ? profile.body.account_created_at
        : null,
    rolling_reserve:
      reserve && typeof reserve.percent === "number" && typeof reserve.days === "number"
        ? { percent: reserve.percent, days: reserve.days }
        : null,
  };
}

function openCaseLinks(store: GuardianStore, merchantId: string): HoldCaseLink[] {
  return store
    .cases.list(merchantId)
    .filter((row) => !CLOSED_CASE.test(row.status ?? ""))
    .map((row) => {
      let body: Record<string, any> = {};
      try {
        body = JSON.parse(row.body_json) as Record<string, any>;
      } catch {
        /* link fields stay empty */
      }
      return {
        case_id: row.id,
        transaction_id: body.transaction_id ?? null,
        invoice_id: body.related_invoice ?? body.invoice_id ?? null,
      };
    });
}

function activeHoldEntries(store: GuardianStore, merchantId: string) {
  return memoryRead(store, merchantId, { kind: "C" }).filter((e) =>
    e.entityKey.startsWith("hold:")
  );
}

export async function runHoldRadar(
  store: GuardianStore,
  opts?: HoldRadarOptions
): Promise<HoldRadarReport> {
  const merchantId = opts?.merchantId ?? DEFAULT_MERCHANT_ID;
  const now = opts?.now ?? new Date();
  const readers = opts?.readers ?? executorReaders();
  const alertMinUsd = opts?.alertMinUsd ?? getPolicy().holds.alert_min_usd;
  const notes: string[] = [
    `Scan window is the last ${TRANSACTION_WINDOW_DAYS} days (Transaction Search limit per query); older holds outside the window are not re-checked.`,
  ];

  const report: HoldRadarReport = {
    merchantId,
    ranAt: now.toISOString(),
    status: "ok",
    windowDays: TRANSACTION_WINDOW_DAYS,
    scanned: 0,
    holds: [],
    newHolds: [],
    updated: [],
    released: [],
    alertsRaised: [],
    totalHeld: { amount: 0, currency: "USD" },
    notes,
  };

  const finish = (status: "ok" | "unavailable", reason?: string): HoldRadarReport => {
    report.status = status;
    store.jobState.set({
      job_name: HOLD_RADAR_JOB,
      merchant_id: merchantId,
      cursor_json: JSON.stringify({
        lastStatus: status,
        ...(reason ? { reason } : {}),
        knownHolds: report.holds.map((h) => h.transaction_id),
        at: now.toISOString(),
      }),
      last_run_at: now.toISOString(),
      last_status: status,
    });
    store.ledger.append({
      merchant_id: merchantId,
      actor: HOLD_RADAR_JOB,
      kind: "job",
      tool: HOLD_RADAR_JOB,
      result_json: JSON.stringify({
        ok: status === "ok",
        status,
        ...(reason ? { reason } : {}),
        scanned: report.scanned,
        holds: report.holds.map((h) => h.transaction_id),
        new_holds: report.newHolds,
        released: report.released,
        alerts: report.alertsRaised.length,
        total_held: report.totalHeld,
      }),
    });
    return report;
  };

  // ---- availability gate: scope first (ground truth), like the Analyst ---
  if (readers.getScopes) {
    const scopes = await readers.getScopes().catch(() => [] as string[]);
    if (!scopes.includes(TRANSACTION_SEARCH_SCOPE)) {
      const reason =
        "Transaction Search scope is not enabled on the PayPal app, so held amounts cannot be seen. Enable 'Transaction Search' in Developer Dashboard > Apps & Credentials, then Save changes.";
      notes.push(reason);
      return finish("unavailable", reason);
    }
  }

  // ---- read the window -----------------------------------------------------
  let details: any[] = [];
  try {
    const range = trailingRange(TRANSACTION_WINDOW_DAYS, now);
    const tx = await readers.listTransactions({
      start_date: range.start,
      end_date: range.end,
    });
    details = Array.isArray(tx?.transaction_details) ? tx.transaction_details : [];
  } catch (e) {
    const status = e instanceof PayPalRestError ? e.status : undefined;
    const reason =
      status === 403 || /scope|NOT_AUTHORIZED/i.test(e instanceof Error ? e.message : "")
        ? "PayPal refused the transactions read (403): the Transaction Search scope appears to be missing, so held amounts cannot be seen."
        : `Transactions read failed (${e instanceof Error ? e.message.slice(0, 200) : String(e)}), so held amounts cannot be produced for this scan.`;
    notes.push(reason);
    return finish("unavailable", reason);
  }
  report.scanned = details.length;

  // ---- classify + maintain memory ------------------------------------------
  const findings = classifyHolds(details, merchantFacts(store, merchantId), openCaseLinks(store, merchantId));
  report.holds = findings;

  const statusByTxn = new Map<string, string>();
  for (const d of details) {
    const info = d?.transaction_info ?? {};
    if (info.transaction_id) statusByTxn.set(String(info.transaction_id), String(info.transaction_status ?? ""));
  }

  const existingByTxn = new Map(
    activeHoldEntries(store, merchantId).map((e) => [e.entityKey.slice("hold:".length), e])
  );

  let total = 0;
  const totalCurrency = findings[0]?.currency ?? "USD";
  const otherCurrencies = new Set<string>();
  for (const f of findings) {
    if (f.currency === totalCurrency) total += f.amount;
    else otherCurrencies.add(f.currency);

    const existing = existingByTxn.get(f.transaction_id);
    const prev = existing?.body as HoldMemoryBody | undefined;
    const body: HoldMemoryBody = {
      transaction_id: f.transaction_id,
      amount: f.amount,
      currency: f.currency,
      status: "held",
      reason_group: f.reason_group,
      estimated: true,
      estimated_release_at: f.estimated_release_at,
      estimate_basis: f.estimate_basis,
      transaction_date: f.transaction_date,
      first_seen_at: prev?.first_seen_at ?? now.toISOString(),
      last_seen_at: now.toISOString(),
      ...(f.case_id ? { case_id: f.case_id } : {}),
    };
    const isNew = !existing;
    const write = memoryWrite(store, {
      merchantId,
      kind: "C",
      entityKey: holdKey(f.transaction_id),
      body,
      source: "hold-radar: Transaction Search scan",
      confidence: 1,
    });
    if (isNew) {
      report.newHolds.push(f.transaction_id);
      if (f.amount >= alertMinUsd) {
        const ledgerId = recordAlert(store, {
          merchantId,
          actor: HOLD_RADAR_JOB,
          name: "hold_placed",
          payload: {
            transaction_id: f.transaction_id,
            amount: f.amount,
            currency: f.currency,
            reason_group: f.reason_group,
            estimated_release_at: f.estimated_release_at,
          },
        });
        report.alertsRaised.push({ transaction_id: f.transaction_id, ledgerId });
      }
    } else if (write.created) {
      report.updated.push(f.transaction_id);
    }
  }
  if (otherCurrencies.size) {
    notes.push(
      `Held amounts in other currencies (${[...otherCurrencies].join(", ")}) are tracked in memory but excluded from totalHeld, which is reported in ${totalCurrency}.`
    );
  }
  report.totalHeld = { amount: round2(total), currency: totalCurrency };

  // ---- releases: a tracked hold whose transaction now reads settled -------
  for (const [txnId, entry] of existingByTxn) {
    const body = entry.body as HoldMemoryBody;
    if (body.status !== "held") continue;
    if (statusByTxn.get(txnId) === "S") {
      memoryWrite(store, {
        merchantId,
        kind: "C",
        entityKey: holdKey(txnId),
        body: { ...body, status: "released", released_observed_at: now.toISOString(), last_seen_at: now.toISOString() },
        source: "hold-radar: Transaction Search scan (transaction now settled)",
        confidence: 1,
      });
      report.released.push(txnId);
    }
  }

  return finish("ok");
}
