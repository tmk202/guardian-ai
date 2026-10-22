// ScamShield — scoring core for invoices addressed TO the merchant
// (PHASES 4C, DEVELOPMENT-PLAN pain #5) — Phase 4C.
//
// The scam, documented across r/paypal (REDDIT-PROBLEMS #5): a fake
// "invoice" arrives through PayPal's real invoicing system — often
// impersonating a big brand — with a note urging the recipient to CALL
// a phone number "to cancel" before a large amount is "charged". One
// Connecticut shop was impersonated by 200+ such invoices. The money
// has NOT left the recipient's account; the invoice is just a payment
// request. The damage happens when the victim phones the number.
//
// This worker scores an inbound invoice with transparent heuristics —
// every point carries its reason, thresholds live in policy (`scam:`),
// and the verdict ships with plain-language guidance. It extends the
// Triage scam screen (§3.5, triage.ts `scam_suspect` for webhook
// events): same signature patterns, deeper scoring for the invoice
// list. Nothing here blocks or deletes anything — Guardian warns; the
// merchant decides.
import type { GuardianPolicy } from "../policy";

export type ScamVerdict = "ok" | "caution" | "likely_scam";

export interface InboundInvoiceFacts {
  invoice_id: string;
  /** display name of whoever sent the invoice */
  invoicer_name: string | null;
  invoicer_email: string | null;
  /** email of the recipient (the merchant, for an inbound invoice) */
  recipient_email: string | null;
  /** invoice note/memo text — where the scam leaves its phone number */
  note: string;
  amount: number;
  currency: string;
  status: string;
}

export interface ScamReason {
  code: string;
  points: number;
  detail: string;
}

export interface ScamAssessment {
  invoice_id: string;
  score: number;
  verdict: ScamVerdict;
  reasons: ScamReason[];
  /** plain-language guidance, written for a non-technical merchant */
  guidance: string[];
}

export type ScamThresholds = GuardianPolicy["scam"];

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

/** Facts of one invoice list item, from the recipient's point of view. */
export function inboundInvoiceFacts(item: any): InboundInvoiceFacts {
  const invoicer = item?.invoicer ?? {};
  const recipient = item?.primary_recipients?.[0]?.billing_info ?? {};
  const noteParts = [item?.detail?.note, item?.detail?.memo, item?.note, item?.memo];
  return {
    invoice_id: String(item?.id ?? ""),
    invoicer_name:
      invoicer?.name?.alternate_full_name ?? invoicer?.name?.full_name ?? null,
    invoicer_email:
      typeof invoicer?.email_address === "string" ? invoicer.email_address : null,
    recipient_email:
      typeof recipient?.email_address === "string" ? recipient.email_address : null,
    note: noteParts.filter((p) => typeof p === "string").join("\n"),
    amount: num(item?.amount?.value),
    currency: item?.amount?.currency_code ?? "USD",
    status: String(item?.status ?? ""),
  };
}

// The two signature patterns are the same ones Triage screens webhook
// events with (triage.ts §3.5) — kept in sync deliberately: a phone
// number in a note, and "call us / cancellation department" lures.
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/;
const CALL_LURE_RE =
  /call\s+(us|now|to\s+cancel|this\s+number)|cancell?ation\s+(department|team|desk)|refund\s+department|fraud\s+department/i;
const URGENCY_RE =
  /urgent(ly)?|immediately|act now|within (24|48) hours|final notice|account (will be|has been) (suspended|limited|closed|blocked|charged)/i;

// Brands the fake-invoice scam impersonates most (per the Reddit
// evidence): the name claims the brand while the sender address is
// some unrelated mailbox.
const BRAND_TOKENS = [
  "paypal",
  "apple",
  "amazon",
  "microsoft",
  "netflix",
  "geek squad",
  "norton",
  "mcafee",
  "best buy",
  "walmart",
  "bank of america",
  "chase bank",
  "wells fargo",
];

const GUIDANCE: Record<ScamVerdict, string[]> = {
  likely_scam: [
    "This is a payment REQUEST — receiving it does not take any money from your account.",
    "Do NOT call any phone number written in the invoice note.",
    "Check your real balance by opening paypal.com or the PayPal app yourself — never through links in the invoice.",
    "You can safely ignore the request, or cancel it inside PayPal. PayPal support will never ask you to cancel an invoice by phone.",
  ],
  caution: [
    "Before paying, verify the sender through a channel you already trust — not the contact details on this invoice.",
    "Do not use any phone number or link from the invoice note to 'confirm' or 'cancel' it.",
  ],
  ok: [
    "No scam signals were found by the checks Guardian runs. Stay alert if anything else about it feels off.",
  ],
};

export function assessInboundInvoice(
  facts: InboundInvoiceFacts,
  ctx: { knownSenderEmails: Set<string>; thresholds: ScamThresholds }
): ScamAssessment {
  const reasons: ScamReason[] = [];
  const add = (code: string, points: number, detail: string) =>
    reasons.push({ code, points, detail });

  if (PHONE_RE.test(facts.note)) {
    add(
      "phone_number_in_note",
      3,
      "The invoice note contains a phone number — the signature move of the fake-invoice scam; a real invoice never asks you to phone a 'cancellation department'."
    );
  }
  if (CALL_LURE_RE.test(facts.note)) {
    add(
      "call_to_cancel_lure",
      3,
      "The note uses 'call to cancel / cancellation department' language designed to get the recipient on the phone with a scammer."
    );
  }
  if (URGENCY_RE.test(facts.note)) {
    add(
      "urgency_language",
      1,
      "The note pressures the recipient to act fast (urgency / account-threat language)."
    );
  }

  const senderEmail = facts.invoicer_email?.toLowerCase() ?? null;
  if (!senderEmail) {
    add(
      "sender_unidentified",
      2,
      "The invoice carries no sender email address to check against your customer records."
    );
  } else if (!ctx.knownSenderEmails.has(senderEmail)) {
    add(
      "unknown_sender",
      2,
      `The sender (${senderEmail}) is not in your customer memory — you have no recorded history with them.`
    );
  }

  const name = (facts.invoicer_name ?? "").toLowerCase();
  if (name && senderEmail) {
    const domain = senderEmail.split("@")[1] ?? "";
    for (const brand of BRAND_TOKENS) {
      if (name.includes(brand) && !domain.includes(brand.replace(/\s+/g, ""))) {
        add(
          "brand_impersonation",
          2,
          `The display name claims "${facts.invoicer_name}" but the sender domain (${domain}) is not that brand's domain.`
        );
        break;
      }
    }
  }

  if (facts.amount >= 100 && Number.isInteger(facts.amount) && facts.amount % 100 === 0) {
    add(
      "round_amount",
      1,
      `The amount is a round $${facts.amount.toFixed(2)} — a common fake-invoice pattern (weak signal on its own).`
    );
  }

  const score = reasons.reduce((s, r) => s + r.points, 0);
  const verdict: ScamVerdict =
    score >= ctx.thresholds.likely_scam_at
      ? "likely_scam"
      : score >= ctx.thresholds.caution_at
        ? "caution"
        : "ok";

  return {
    invoice_id: facts.invoice_id,
    score,
    verdict,
    reasons,
    guidance: GUIDANCE[verdict],
  };
}
