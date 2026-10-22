// Triage — deterministic event classification (ARCHITECTURE-DETAIL.md
// §3.5) — Phase 1D.
//
// The spec's Triage is a small fast model running the §3.5 prompt. There
// is no LLM key in this environment, so this module implements the exact
// same contract with rules: same input (a PayPal event), same output JSON
// shape, same rules (new dispute → instant; response deadline < 48h →
// dispute_deadline_risk + instant; a received invoice whose note carries a
// phone number or "call to cancel" language → scam_suspect + instant;
// unsure → other/daily). TRIAGE_PROMPT_V1 keeps the spec prompt next to
// the code so an LLM-backed implementation can replace `triageEvent`
// behind the identical interface later.

export const TRIAGE_RULES_VERSION = "rules-v1 (spec §3.5)";

export const TRIAGE_PROMPT_V1 = `Classify this PayPal event for Guardian. Output JSON only:
{ "kind": "dispute_new|dispute_updated|dispute_deadline_risk|invoice_paid|invoice_overdue|
  hold_placed|hold_released|payment_received|scam_suspect|other",
  "urgency": "instant|daily|digest",
  "entity_ids": [...], "one_line": "<=15 words, facts only" }
Rules: deadline < 48h or new dispute → instant. A received invoice whose note contains
a phone number or "call to cancel" language → scam_suspect + instant.
When unsure → kind "other", urgency "daily". Never invent fields not in the event.`;

export type TriageKind =
  | "dispute_new"
  | "dispute_updated"
  | "dispute_deadline_risk"
  | "invoice_paid"
  | "invoice_overdue"
  | "hold_placed"
  | "hold_released"
  | "payment_received"
  | "scam_suspect"
  | "other";

export type TriageUrgency = "instant" | "daily" | "digest";

export interface TriageResult {
  kind: TriageKind;
  urgency: TriageUrgency;
  entity_ids: string[];
  one_line: string;
}

export interface PayPalEventLike {
  id?: string;
  event_id?: string;
  event_type?: string;
  summary?: string;
  resource?: Record<string, any>;
  [key: string]: unknown;
}

const HOUR_MS = 3600_000;

/** Response-deadline fields seen across PayPal dispute payload versions. */
const DEADLINE_FIELDS = [
  "seller_response_due_date",
  "response_due_date",
  "buyer_response_due_date",
  "dispute_deadline",
  "deadline_at",
] as const;

export function extractDisputeDeadline(dispute: any): string | null {
  if (!dispute || typeof dispute !== "object") return null;
  for (const f of DEADLINE_FIELDS) {
    const v = dispute[f];
    if (typeof v === "string" && v && !Number.isNaN(Date.parse(v))) return v;
  }
  return null;
}

function firstDeadline(event: PayPalEventLike): string | null {
  return (
    extractDisputeDeadline(event.resource) ??
    extractDisputeDeadline((event as any).dispute) ??
    null
  );
}

function entityIds(event: PayPalEventLike): string[] {
  const r = event.resource ?? {};
  const ids = new Set<string>();
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) ids.add(v);
  };
  push(r.dispute_id);
  push(r.invoice_id);
  push(r.id);
  if (Array.isArray(r.disputed_transactions)) {
    for (const t of r.disputed_transactions) push(t?.seller_transaction_id);
  }
  return [...ids];
}

/** Note-bearing text of an invoice/money-request resource, if any. */
function noteText(resource: any): string {
  if (!resource || typeof resource !== "object") return "";
  const parts: string[] = [];
  const candidates = [
    resource.detail?.note,
    resource.detail?.memo,
    resource.note,
    resource.memo,
    resource.description,
  ];
  for (const c of candidates) if (typeof c === "string") parts.push(c);
  return parts.join("\n");
}

// A phone number written into a note is the signature move of the fake
// invoice scam (§3.5 + REDDIT-PROBLEMS #5): a real invoice never asks the
// recipient to phone a "cancellation department".
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/;
const CALL_LURE_RE =
  /call\s+(us|now|to\s+cancel|this\s+number)|cancell?ation\s+(department|team|desk)|refund\s+department|fraud\s+department/i;

export function looksLikeScamNote(text: string): boolean {
  if (!text) return false;
  return PHONE_RE.test(text) || CALL_LURE_RE.test(text);
}

function amountStr(resource: any): string {
  const a = resource?.dispute_amount ?? resource?.amount ?? resource?.total;
  if (!a) return "";
  if (typeof a === "object" && a.value) return `${a.value} ${a.currency_code ?? ""}`.trim();
  if (typeof a === "string") return a;
  return "";
}

function line(words: string): string {
  const w = words.trim().split(/\s+/).filter(Boolean);
  return w.slice(0, 15).join(" ");
}

export function triageEvent(
  event: PayPalEventLike,
  opts?: { now?: Date }
): TriageResult {
  const now = opts?.now ?? new Date();
  const type = String(event.event_type ?? "").toUpperCase();
  const resource: any = event.resource ?? {};
  const ids = entityIds(event);
  const deadline = firstDeadline(event);
  const hoursToDeadline = deadline
    ? (Date.parse(deadline) - now.getTime()) / HOUR_MS
    : null;
  const deadlineRisk = hoursToDeadline !== null && hoursToDeadline < 48;

  // --- scam screen first: a poisoned invoice must never be filed away ---
  const isInvoiceEvent =
    type.startsWith("INVOICING.") ||
    typeof resource?.detail?.invoice_number === "string" ||
    (typeof resource?.id === "string" && resource.id.startsWith("INV2-"));
  if (isInvoiceEvent && looksLikeScamNote(noteText(resource))) {
    return {
      kind: "scam_suspect",
      urgency: "instant",
      entity_ids: ids,
      one_line: line(
        `Suspect invoice ${resource.id ?? ""}: note contains a phone number or call-to-cancel lure`
      ),
    };
  }

  // --- disputes ------------------------------------------------------------
  if (type.startsWith("CUSTOMER.DISPUTE.") || resource?.dispute_id) {
    const caseId = resource.dispute_id ?? resource.id ?? "unknown case";
    const amt = amountStr(resource);
    const reason = typeof resource.reason === "string" ? resource.reason : "";
    if (deadlineRisk) {
      return {
        kind: "dispute_deadline_risk",
        urgency: "instant",
        entity_ids: ids,
        one_line: line(
          `Dispute ${caseId} response deadline in under 48 hours ${amt}`.trim()
        ),
      };
    }
    if (type === "CUSTOMER.DISPUTE.CREATED") {
      return {
        kind: "dispute_new",
        urgency: "instant",
        entity_ids: ids,
        one_line: line(
          `New dispute ${caseId} opened ${reason} ${amt}`.replace(/\s+/g, " ")
        ),
      };
    }
    if (type === "CUSTOMER.DISPUTE.RESOLVED") {
      return {
        kind: "dispute_updated",
        urgency: "digest",
        entity_ids: ids,
        one_line: line(`Dispute ${caseId} resolved ${amt}`.trim()),
      };
    }
    return {
      kind: "dispute_updated",
      urgency: "daily",
      entity_ids: ids,
      one_line: line(`Dispute ${caseId} updated ${reason} ${amt}`.trim()),
    };
  }

  // --- invoices --------------------------------------------------------------
  if (type === "INVOICING.INVOICE.PAID") {
    return {
      kind: "invoice_paid",
      urgency: "digest",
      entity_ids: ids,
      one_line: line(`Invoice ${resource.id ?? ""} paid ${amountStr(resource)}`),
    };
  }
  if (type.includes("OVERDUE")) {
    return {
      kind: "invoice_overdue",
      urgency: "daily",
      entity_ids: ids,
      one_line: line(`Invoice ${resource.id ?? ""} is overdue ${amountStr(resource)}`),
    };
  }

  // --- payments & holds --------------------------------------------------------
  if (/HOLD|ONHOLD/.test(type)) {
    if (/RELEASE/.test(type)) {
      return {
        kind: "hold_released",
        urgency: "daily",
        entity_ids: ids,
        one_line: line(`Funds hold released ${amountStr(resource)}`),
      };
    }
    return {
      kind: "hold_placed",
      urgency: "instant", // §5.3 policy: hold_placed notifies instantly
      entity_ids: ids,
      one_line: line(`Funds placed on hold ${amountStr(resource)}`),
    };
  }
  if (type === "PAYMENT.CAPTURE.COMPLETED" || type === "PAYMENT.SALE.COMPLETED") {
    return {
      kind: "payment_received",
      urgency: "digest",
      entity_ids: ids,
      one_line: line(`Payment received ${resource.id ?? ""} ${amountStr(resource)}`),
    };
  }

  // --- unsure → other/daily (§3.5) ---------------------------------------------
  return {
    kind: "other",
    urgency: "daily",
    entity_ids: ids,
    one_line: line(event.summary || `PayPal event ${type || "unknown"}`),
  };
}
