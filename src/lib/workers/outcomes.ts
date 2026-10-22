// Outcome Learning (ARCHITECTURE-DETAIL.md §2.2 kind E + §3.6 Memory
// Keeper, PHASES 5.2) — Phase 5A.
//
// The Memory Keeper's learning half, minus the LLM: for every dispute
// Guardian tracks, read the case back from PayPal; when PayPal says the
// case is RESOLVED, distill ONE durable outcome record (memory kind E,
// entity_key = caseId): the reason, the amount, which evidence types
// were submitted, whether tracking was among them, the outcome code
// PayPal reported, and how long the case took. Playbook stats are then
// a pure aggregation over those records — win rates by (reason ×
// tracking) with the sample size ALWAYS shown, and no rate at all when
// the sample is too small to mean anything.
//
// HONESTY CONTRACT: an outcome is recorded only from a live read-back
// that says RESOLVED. A case PayPal still shows as open stays open —
// Guardian never guesses how a case ended, and an outcome code PayPal
// did not return is stored as UNKNOWN, never inferred from the status.
import { DEFAULT_MERCHANT_ID, type GuardianStore } from "../db";
import { getExecutor, type GuardianExecutor } from "../executor";
import { registerCoreTools } from "../tools";
import { memoryRead, memoryWrite } from "../memory";

/** The PayPal read the outcome scan needs — injected so tests never touch the network. */
export interface OutcomeReaders {
  getDispute(disputeId: string): Promise<any>;
}

export type CaseOutcomeVerdict = "SELLER_FAVOR" | "BUYER_FAVOR" | "OTHER" | "UNKNOWN";

export interface CaseOutcome {
  caseId: string;
  reason: string;
  amount: number | null;
  currency: string;
  /** SELLER_FAVOR / BUYER_FAVOR / OTHER / UNKNOWN (PayPal gave no code) */
  outcome: CaseOutcomeVerdict;
  /** the raw outcome code PayPal returned, when it returned one */
  outcomeRaw: string | null;
  evidenceTypes: string[];
  hasTracking: boolean;
  openedAt: string | null;
  resolvedAt: string | null;
  daysOpen: number | null;
}

export interface OutcomesScanResult {
  merchantId: string;
  ranAt: string;
  scanned: number;
  /** cases PayPal still shows as not resolved — nothing was recorded */
  stillOpen: { caseId: string; status: string | null }[];
  /** outcomes newly written to memory kind E on this run */
  recorded: CaseOutcome[];
  /** resolved cases that already had an outcome record (idempotency) */
  alreadyRecorded: number;
  errors: { caseId: string; error: string }[];
}

/** Below this many recorded outcomes a bucket reports no win rate. */
export const PLAYBOOK_MIN_SAMPLE = 3;

export interface PlaybookBucket {
  reason: string;
  hasTracking: boolean;
  /** total recorded outcomes in this bucket — always shown */
  n: number;
  won: number;
  lost: number;
  other: number;
  unknown: number;
  /** won + lost — the cases PayPal actually decided for a side */
  decided: number;
  /** won / decided, or null when the sample cannot support a rate */
  winRate: number | null;
  /** true when n >= PLAYBOOK_MIN_SAMPLE and at least one case was decided */
  sufficient: boolean;
  note: string;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v : null;
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

function verdictOf(raw: string | null): CaseOutcomeVerdict {
  if (!raw) return "UNKNOWN";
  if (/^SELLER_FAVOR/i.test(raw)) return "SELLER_FAVOR";
  if (/^BUYER_FAVOR/i.test(raw)) return "BUYER_FAVOR";
  return "OTHER";
}

/**
 * Scan tracked cases, read each back, and record an outcome (memory E)
 * for every case PayPal reports RESOLVED that does not have one yet.
 * Also syncs the cases table + case memory C with the resolution, so
 * every other watcher stops treating a finished case as open.
 */
export async function scanCaseOutcomes(
  store: GuardianStore,
  readers: OutcomeReaders,
  opts?: { merchantId?: string; now?: Date }
): Promise<OutcomesScanResult> {
  const merchantId = opts?.merchantId ?? DEFAULT_MERCHANT_ID;
  const now = opts?.now ?? new Date();
  const result: OutcomesScanResult = {
    merchantId,
    ranAt: now.toISOString(),
    scanned: 0,
    stillOpen: [],
    recorded: [],
    alreadyRecorded: 0,
    errors: [],
  };

  const knownOutcomes = new Set(
    memoryRead(store, merchantId, { kind: "E" }).map((e) => e.entityKey)
  );

  for (const row of store.cases.list(merchantId)) {
    result.scanned++;
    if (knownOutcomes.has(row.id)) {
      result.alreadyRecorded++;
      continue;
    }
    let body: Record<string, any> = {};
    try {
      body = JSON.parse(row.body_json) as Record<string, any>;
    } catch {
      /* body stays empty — the read-back is the source of truth anyway */
    }
    let dispute: any;
    try {
      dispute = await readers.getDispute(row.id);
    } catch (e) {
      result.errors.push({
        caseId: row.id,
        error: e instanceof Error ? e.message.slice(0, 300) : String(e),
      });
      continue;
    }
    if (!dispute || typeof dispute !== "object") {
      result.errors.push({ caseId: row.id, error: "get_dispute returned no dispute object" });
      continue;
    }
    const status = str(dispute.status) ?? row.status;
    if (status !== "RESOLVED") {
      // Not finished — record nothing, guess nothing.
      result.stillOpen.push({ caseId: row.id, status });
      continue;
    }

    // ---- distill the outcome from facts only -------------------------------
    const caseMem = memoryRead(store, merchantId, { kind: "C", entity: row.id })[0];
    const memBody: Record<string, any> = caseMem?.body ?? {};
    const evidenceTypes = new Set<string>();
    let hasTracking = false;
    for (const e of Array.isArray(memBody.evidence_submitted) ? memBody.evidence_submitted : []) {
      const t = str(e?.type) ?? str(e?.evidence_type);
      if (t) evidenceTypes.add(t);
      if (str(e?.tracking) ?? str(e?.tracking_number)) hasTracking = true;
    }
    for (const e of Array.isArray(body.evidence_submitted) ? body.evidence_submitted : []) {
      const t = str(e?.type) ?? str(e?.evidence_type);
      if (t) evidenceTypes.add(t);
      if (str(e?.tracking) ?? str(e?.tracking_number)) hasTracking = true;
    }
    for (const e of Array.isArray(dispute.evidences) ? dispute.evidences : []) {
      const t = str(e?.evidence_type);
      if (t) evidenceTypes.add(t);
      const infos = Array.isArray(e?.evidence_info?.tracking_info)
        ? e.evidence_info.tracking_info
        : [];
      if (infos.some((ti: any) => str(ti?.tracking_number))) hasTracking = true;
    }

    const outcomeRaw =
      str(dispute.dispute_outcome?.outcome_code) ??
      str(dispute.adjudication_outcome) ??
      null;
    const openedAt = str(dispute.create_time);
    const resolvedAt = str(dispute.update_time);
    const daysOpen =
      openedAt && resolvedAt
        ? round1((Date.parse(resolvedAt) - Date.parse(openedAt)) / 86_400_000)
        : null;
    const outcome: CaseOutcome = {
      caseId: row.id,
      reason: str(dispute.reason) ?? str(body.reason) ?? str(memBody.reason) ?? "UNKNOWN",
      amount: num(dispute.dispute_amount?.value) ?? num(body.amount_usd) ?? num(memBody.amount_usd),
      currency:
        str(dispute.dispute_amount?.currency_code) ?? str(body.currency) ?? "USD",
      outcome: verdictOf(outcomeRaw),
      outcomeRaw,
      evidenceTypes: [...evidenceTypes].sort(),
      hasTracking,
      openedAt,
      resolvedAt,
      daysOpen: daysOpen !== null && Number.isFinite(daysOpen) ? daysOpen : null,
    };

    const source = `outcomes-scan: get_dispute read-back ${now.toISOString().slice(0, 10)}`;
    memoryWrite(store, {
      merchantId,
      kind: "E",
      entityKey: row.id,
      body: {
        case_id: outcome.caseId,
        reason: outcome.reason,
        amount_usd: outcome.amount,
        currency: outcome.currency,
        outcome: outcome.outcome,
        outcome_raw: outcome.outcomeRaw,
        evidence_types: outcome.evidenceTypes,
        has_tracking: outcome.hasTracking,
        opened_at: outcome.openedAt,
        resolved_at: outcome.resolvedAt,
        days_open: outcome.daysOpen,
      },
      source,
      confidence: 1,
    });
    knownOutcomes.add(row.id);
    result.recorded.push(outcome);

    // Sync the operational records: the case is finished everywhere.
    store.cases.upsert({
      id: row.id,
      merchant_id: merchantId,
      body_json: row.body_json,
      deadline_at: row.deadline_at,
      status: "RESOLVED",
    });
    if (caseMem) {
      memoryWrite(store, {
        merchantId,
        kind: "C",
        entityKey: row.id,
        body: {
          ...memBody,
          status: "RESOLVED",
          outcome: outcome.outcome,
          outcome_raw: outcome.outcomeRaw,
          resolved_at: outcome.resolvedAt,
        },
        source,
        confidence: 1,
      });
    }
  }
  return result;
}

/**
 * Aggregate the recorded outcomes into playbook buckets keyed by
 * (reason × has_tracking). Rates appear only at/above PLAYBOOK_MIN_SAMPLE
 * recorded outcomes AND at least one decided case — a 100% rate on n=1
 * is a story, not a statistic, and is reported as insufficient data.
 */
export function playbookStats(
  store: GuardianStore,
  merchantId: string = DEFAULT_MERCHANT_ID
): PlaybookBucket[] {
  const buckets = new Map<string, PlaybookBucket>();
  for (const e of memoryRead(store, merchantId, { kind: "E" })) {
    const b = e.body;
    const reason = typeof b.reason === "string" ? b.reason : "UNKNOWN";
    const hasTracking = b.has_tracking === true;
    const key = `${reason}|${hasTracking ? "tracking" : "no-tracking"}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        reason,
        hasTracking,
        n: 0,
        won: 0,
        lost: 0,
        other: 0,
        unknown: 0,
        decided: 0,
        winRate: null,
        sufficient: false,
        note: "",
      };
      buckets.set(key, bucket);
    }
    bucket.n++;
    if (b.outcome === "SELLER_FAVOR") bucket.won++;
    else if (b.outcome === "BUYER_FAVOR") bucket.lost++;
    else if (b.outcome === "OTHER") bucket.other++;
    else bucket.unknown++;
  }
  const out = [...buckets.values()];
  for (const bucket of out) {
    bucket.decided = bucket.won + bucket.lost;
    bucket.sufficient = bucket.n >= PLAYBOOK_MIN_SAMPLE && bucket.decided > 0;
    bucket.winRate = bucket.sufficient
      ? round2(bucket.won / bucket.decided)
      : null;
    bucket.note = bucket.sufficient
      ? `win rate over ${bucket.decided} decided case(s), n=${bucket.n} recorded`
      : `insufficient data (n=${bucket.n}, need >= ${PLAYBOOK_MIN_SAMPLE} recorded outcomes with a decided result)`;
  }
  out.sort((a, b) => b.n - a.n || a.reason.localeCompare(b.reason));
  return out;
}

/** The bucket for one (reason, hasTracking) pair, when it is statistically usable. */
export function playbookFor(
  store: GuardianStore,
  merchantId: string,
  reason: string,
  hasTracking: boolean
): PlaybookBucket | null {
  const bucket = playbookStats(store, merchantId).find(
    (b) => b.reason === reason && b.hasTracking === hasTracking
  );
  return bucket && bucket.sufficient ? bucket : null;
}

/** Production readers: dispute read-backs through the single executor path. */
export function executorOutcomeReaders(
  executor: GuardianExecutor = getExecutor()
): OutcomeReaders {
  registerCoreTools(executor);
  return {
    getDispute: async (disputeId) =>
      (await executor.execute("get_dispute", { dispute_id: disputeId }, { actor: "outcomes-scan" })).data,
  };
}
