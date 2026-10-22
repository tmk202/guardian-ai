// Risk Warning — pure assessment core (PHASES 4B.1/4B.2,
// DEVELOPMENT-PLAN pain #2: permanent limitation, balance frozen 180
// days, generic reason). Phase 4A.
//
// HONESTY CONTRACT (project-wide): PayPal exposes NO API to lift a
// limitation or unfreeze an account, and it does not publish the exact
// thresholds its risk engine uses. Guardian therefore does only what the
// data supports: watch the signals a merchant CAN see (dispute rate,
// cases closing in on their response deadline, money currently at risk,
// funds on hold), grade them against thresholds the merchant configured
// in policy (`risk:` section), and attach a concrete fix-it action to
// every grade. A signal whose inputs cannot be produced lands in
// `signals_missing` with the reason — it is never estimated, never
// silently treated as zero-risk.
import type { GuardianPolicy } from "../policy";

export type RiskLevel = "LOW" | "WATCH" | "HIGH";
export type RiskSeverity = "watch" | "high";

export interface RiskDeadlineCase {
  caseId: string;
  /** hours until the seller response deadline; negative = already past */
  hoursLeft: number;
}

export interface RiskInputs {
  /** trailing window the signals describe */
  windowDays: number;
  /**
   * Denominator for the dispute rate: invoices observed in the window.
   * null = the count could not be produced at all.
   */
  invoicesInWindow: number | null;
  /** disputes currently open */
  openDisputes: number;
  /** open-dispute + held money, USD; null = the Analyst could not produce it */
  atRiskUsd: number | null;
  atRiskCurrency: string;
  /** open cases that carry a response deadline */
  deadlineCases: RiskDeadlineCase[];
  /** funds currently on hold, USD; null = holds are not observable */
  heldUsd: number | null;
  heldCount: number;
}

export interface RiskReason {
  signal: string;
  severity: RiskSeverity;
  /** the measured fact, in words */
  detail: string;
  /** the concrete thing the merchant should do about it */
  action: string;
}

export interface RiskAssessment {
  level: RiskLevel;
  /** openDisputes / invoicesInWindow, or null when not computable */
  disputeRate: number | null;
  reasons: RiskReason[];
  /** signals Guardian could NOT measure, each with why — never guessed */
  signalsMissing: string[];
  summary: string;
}

export type RiskThresholds = GuardianPolicy["risk"];

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
const money = (a: number, c: string) => `$${a.toFixed(2)} ${c}`;

export function assessRisk(inputs: RiskInputs, t: RiskThresholds): RiskAssessment {
  const reasons: RiskReason[] = [];
  const signalsMissing: string[] = [];

  // ---- dispute rate -------------------------------------------------------
  let disputeRate: number | null = null;
  if (inputs.invoicesInWindow === null) {
    signalsMissing.push(
      "dispute rate — the invoice count for the window could not be read, so the rate was not computed"
    );
  } else if (inputs.invoicesInWindow === 0 && inputs.openDisputes > 0) {
    signalsMissing.push(
      `dispute rate — ${inputs.openDisputes} open dispute(s) but no invoices in the ${inputs.windowDays}-day window to divide by, so no rate was computed`
    );
  } else if (inputs.invoicesInWindow > 0) {
    disputeRate = round4(inputs.openDisputes / inputs.invoicesInWindow);
    if (disputeRate >= t.high_dispute_rate) {
      reasons.push({
        signal: "dispute_rate",
        severity: "high",
        detail: `Dispute rate is ${pct(disputeRate)} (${inputs.openDisputes} open disputes / ${inputs.invoicesInWindow} invoices in ${inputs.windowDays} days), at or above the HIGH threshold of ${pct(t.high_dispute_rate)}. Sustained high dispute rates are the pattern PayPal's risk reviews react to.`,
        action:
          "Answer every open case before its deadline with tracking/proof attached, and pause new sales of the item(s) behind the disputes until the rate falls.",
      });
    } else if (disputeRate >= t.watch_dispute_rate) {
      reasons.push({
        signal: "dispute_rate",
        severity: "watch",
        detail: `Dispute rate is ${pct(disputeRate)} (${inputs.openDisputes} open disputes / ${inputs.invoicesInWindow} invoices in ${inputs.windowDays} days), at or above the WATCH threshold of ${pct(t.watch_dispute_rate)}.`,
        action:
          "Review the open cases for a shared cause (shipping time, item description, tracking gaps) and fix that cause before more cases land.",
      });
    }
  }

  // ---- money at risk --------------------------------------------------------
  if (inputs.atRiskUsd === null) {
    signalsMissing.push(
      "money at risk — the Analyst could not produce the figure for this window"
    );
  } else if (inputs.atRiskUsd >= t.high_at_risk_usd) {
    reasons.push({
      signal: "money_at_risk",
      severity: "high",
      detail: `${money(inputs.atRiskUsd, inputs.atRiskCurrency)} is currently at risk (open disputes + held funds), at or above the HIGH threshold of ${money(t.high_at_risk_usd, inputs.atRiskCurrency)}.`,
      action:
        "Work the open cases largest-first; where a small case is not worth fighting, resolving it quickly cuts the exposure and the dispute count at once.",
    });
  } else if (inputs.atRiskUsd >= t.watch_at_risk_usd) {
    reasons.push({
      signal: "money_at_risk",
      severity: "watch",
      detail: `${money(inputs.atRiskUsd, inputs.atRiskCurrency)} is currently at risk (open disputes + held funds), at or above the WATCH threshold of ${money(t.watch_at_risk_usd, inputs.atRiskCurrency)}.`,
      action:
        "Keep an eye on the open cases behind this figure and answer each one well before its deadline.",
    });
  }

  // ---- case deadlines --------------------------------------------------------
  const sorted = [...inputs.deadlineCases].sort((a, b) => a.hoursLeft - b.hoursLeft);
  for (const c of sorted) {
    if (c.hoursLeft < t.deadline_high_hours) {
      reasons.push({
        signal: "case_deadline",
        severity: "high",
        detail:
          c.hoursLeft < 0
            ? `Case ${c.caseId} is PAST its response deadline by ${Math.abs(Math.round(c.hoursLeft))}h.`
            : `Case ${c.caseId} has ${Math.round(c.hoursLeft)}h left to respond — inside the ${t.deadline_high_hours}h danger window.`,
        action: `Submit evidence for case ${c.caseId} now — a missed response deadline loses the case automatically.`,
      });
    } else if (c.hoursLeft < t.deadline_watch_hours) {
      reasons.push({
        signal: "case_deadline",
        severity: "watch",
        detail: `Case ${c.caseId} has ${Math.round(c.hoursLeft)}h left to respond — inside the ${t.deadline_watch_hours}h watch window.`,
        action: `Prepare and submit the evidence packet for case ${c.caseId} today, not at the deadline.`,
      });
    }
  }

  // ---- funds on hold -----------------------------------------------------------
  if (inputs.heldUsd === null) {
    signalsMissing.push(
      "funds on hold — hold amounts are not observable (Transaction Search is unavailable, so the Hold Radar cannot see held payments)"
    );
  } else if (inputs.heldUsd > 0) {
    reasons.push({
      signal: "funds_on_hold",
      severity: "watch",
      detail: `${money(inputs.heldUsd, inputs.atRiskCurrency)} is currently on hold across ${inputs.heldCount} payment(s).`,
      action:
        "For each held payment, make sure carrier tracking is attached and the delivery is provable — tracking + delivery proof is the #1 condition PayPal releases holds on.",
    });
  }

  const level: RiskLevel = reasons.some((r) => r.severity === "high")
    ? "HIGH"
    : reasons.length > 0
      ? "WATCH"
      : "LOW";

  const summary =
    level === "LOW"
      ? `Account risk LOW: no watched signal crossed its threshold in the last ${inputs.windowDays} days${signalsMissing.length ? ` (${signalsMissing.length} signal(s) could not be measured — see signals_missing)` : ""}.`
      : `Account risk ${level}: ${reasons.map((r) => r.signal).join(", ")} need attention${signalsMissing.length ? `; ${signalsMissing.length} signal(s) could not be measured` : ""}.`;

  return { level, disputeRate, reasons, signalsMissing, summary };
}
