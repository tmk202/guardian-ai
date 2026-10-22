// Hold Radar — classification core (PHASES 3A, DEVELOPMENT-PLAN pain #1:
// funds held 21–120 days). Phase 3A.
//
// HONESTY CONTRACT (project-wide, see DEVELOPMENT-PLAN): PayPal has NO API
// to release a hold or unfreeze an account, and the transaction record does
// not state WHY a payment is pending. Guardian therefore does exactly three
// things here: detect held money early, say what is known about it, and
// estimate the release window from PayPal's PUBLISHED hold policy — every
// estimate is labelled `estimated: true` and carries its basis in words.
// Nothing in this file invents a reason or a date.
//
// Data semantics & rules, with sources:
// - Transaction Search (GET /v1/reporting/transactions): each record's
//   transaction_info.transaction_status is "S" (success/settled) or "P"
//   (pending — the money is not yet in the available balance). A positive
//   "P" record is what "funds on hold" looks like in the only API PayPal
//   exposes for it. (The Analyst worker §3.4 already reads "P" as held.)
// - Standard payment hold: PayPal's public help page "Why is my payment
//   on hold?" states payments can be held for up to 21 days, released
//   sooner when tracking shows delivery or the buyer confirms receipt.
//   → STANDARD_HOLD_DAYS = 21 is the published outer window, used as the
//   estimate for new-account and unknown holds.
// - Dispute-related holds: when a dispute/claim is open, the disputed
//   amount stays held until the case is resolved (PayPal Disputes docs).
//   There is NO fixed release date while a case is open, so the estimate
//   is null and the basis says exactly that — never a guessed date.
// - Rolling reserves: PayPal may hold a merchant-specific percentage of
//   each payment for a merchant-specific window (reserve agreement;
//   commonly 30–120 days per PayPal's reserve documentation). Guardian can
//   only apply this group when the reserve terms are a RECORDED merchant
//   fact (merchant profile memory). No recorded terms → never "reserve".
// - New-account holds: the 21-day hold applies most broadly to new
//   sellers. Guardian uses "new_account" only when the merchant profile
//   records an account creation date AND the transaction happened within
//   NEW_ACCOUNT_DAYS of it. No recorded date → not this group.
// - Anything else pending stays "unknown": the reason is not visible in
//   the data PayPal exposes, and the report says so.

/** PayPal's published maximum window for a standard payment hold. */
export const STANDARD_HOLD_DAYS = 21;
/** A transaction within this many days of account creation counts as new-seller. */
export const NEW_ACCOUNT_DAYS = 90;

const DAY_MS = 24 * 3600_000;

export type HoldReasonGroup =
  | "new_account"
  | "dispute_related"
  | "reserve"
  | "unknown";

export interface HoldFinding {
  transaction_id: string;
  amount: number;
  currency: string;
  /** ISO instant of the transaction, as reported by PayPal */
  transaction_date: string;
  reason_group: HoldReasonGroup;
  /** every date this worker emits is an estimate — there is no exact API */
  estimated: true;
  /** ISO date of the estimated release, or null when no window exists */
  estimated_release_at: string | null;
  /** the published rule the estimate stands on, in plain words */
  estimate_basis: string;
  /** set only for dispute_related findings */
  case_id?: string;
}

/** A tracked open dispute, reduced to the fields a hold can link through. */
export interface HoldCaseLink {
  case_id: string;
  transaction_id?: string | null;
  invoice_id?: string | null;
}

/** Verified merchant facts the classification is allowed to stand on. */
export interface HoldMerchantFacts {
  /** recorded account creation date (ISO), if the profile carries one */
  account_created_at?: string | null;
  /** recorded rolling-reserve terms from the merchant's reserve agreement */
  rolling_reserve?: { percent: number; days: number } | null;
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const plusDays = (iso: string, days: number) =>
  new Date(Date.parse(iso) + days * DAY_MS).toISOString();

/**
 * Classify the held payments inside a Transaction Search result set.
 * Pure: (transaction_details, merchant facts, open case links) → findings.
 * Settled ("S") records and non-positive amounts are not holds and are
 * excluded; the caller compares statuses itself for release detection.
 */
export function classifyHolds(
  transactionDetails: any[],
  facts: HoldMerchantFacts,
  openCases: HoldCaseLink[]
): HoldFinding[] {
  const findings: HoldFinding[] = [];
  const accountCreatedMs = facts.account_created_at
    ? Date.parse(facts.account_created_at)
    : NaN;

  for (const detail of transactionDetails ?? []) {
    const info = detail?.transaction_info ?? {};
    if (info.transaction_status !== "P") continue; // only pending = held
    const amount = num(info.transaction_amount?.value);
    if (amount <= 0) continue; // money out / reversals are not held income
    const txnId = String(info.transaction_id ?? "");
    if (!txnId) continue;
    const txnDate = String(
      info.transaction_initiation_date ?? info.transaction_updated_date ?? ""
    );
    const currency = info.transaction_amount?.currency_code ?? "USD";
    const base = {
      transaction_id: txnId,
      amount: round2(amount),
      currency,
      transaction_date: txnDate,
      estimated: true as const,
    };

    // 1 — dispute_related: the strongest signal, an explicit id link to a
    // case Guardian is tracking as open (transaction id, or the invoice
    // the transaction paid). No fixed release date exists while it is open.
    const linked = openCases.find(
      (c) =>
        (c.transaction_id && c.transaction_id === txnId) ||
        (c.invoice_id && info.invoice_id && c.invoice_id === String(info.invoice_id))
    );
    if (linked) {
      findings.push({
        ...base,
        reason_group: "dispute_related",
        estimated_release_at: null,
        estimate_basis:
          `Linked to open dispute ${linked.case_id}: PayPal keeps the disputed ` +
          `amount held until the case is resolved, so no fixed release date ` +
          `exists. Release follows the case outcome.`,
        case_id: linked.case_id,
      });
      continue;
    }

    // 2 — reserve: only when reserve terms are a recorded merchant fact.
    if (facts.rolling_reserve && txnDate) {
      const { percent, days } = facts.rolling_reserve;
      findings.push({
        ...base,
        reason_group: "reserve",
        estimated_release_at: plusDays(txnDate, days),
        estimate_basis:
          `Merchant has rolling-reserve terms on file (${percent}% of each ` +
          `payment held ${days} days per the reserve agreement); estimate is ` +
          `transaction date + ${days} days. PayPal's actual release follows ` +
          `its own reserve schedule.`,
      });
      continue;
    }

    // 3 — new_account: recorded creation date + transaction inside the
    // new-seller window → the published 21-day hold applies.
    if (
      Number.isFinite(accountCreatedMs) &&
      txnDate &&
      Date.parse(txnDate) - accountCreatedMs >= 0 &&
      Date.parse(txnDate) - accountCreatedMs <= NEW_ACCOUNT_DAYS * DAY_MS
    ) {
      findings.push({
        ...base,
        reason_group: "new_account",
        estimated_release_at: plusDays(txnDate, STANDARD_HOLD_DAYS),
        estimate_basis:
          `Account created ${facts.account_created_at} (merchant record); ` +
          `PayPal's published payment-hold window for new sellers is up to ` +
          `${STANDARD_HOLD_DAYS} days from the transaction date, released ` +
          `sooner with delivery tracking or buyer confirmation.`,
      });
      continue;
    }

    // 4 — unknown: pending, but the reason is not in the data PayPal
    // exposes. The 21-day figure is the published outer bound for a
    // standard hold, labelled as exactly that — not a promise.
    findings.push({
      ...base,
      reason_group: "unknown",
      estimated_release_at: txnDate ? plusDays(txnDate, STANDARD_HOLD_DAYS) : null,
      estimate_basis:
        `Hold reason is not visible in the transaction data PayPal exposes. ` +
        `${STANDARD_HOLD_DAYS} days is PayPal's published maximum for a ` +
        `standard payment hold, shown as an outer-bound estimate only.`,
    });
  }

  findings.sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));
  return findings;
}
