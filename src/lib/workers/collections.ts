// Collections Worker (ARCHITECTURE-DETAIL.md §3.3, DEVELOPMENT-PLAN
// pain #6: freelancers re-sending the same invoice 14 times because the
// customer "forgot") — Phase 3B.
//
// The worker plans the chase and drafts every reminder; it NEVER sends
// anything itself. Each due reminder becomes a PENDING approval for the
// SENSITIVE tool `send_invoice_reminder` whose args carry the exact
// subject + note — the merchant approves the words, not just the idea,
// and the executor refuses to send anything whose args differ (§5.5).
//
// Rules implemented from §3.3 (transparent, in code order):
// - Tone ladder by days overdue (calendar days past the due date):
//   rung 1 friendly (1–3), rung 2 firm with facts (4–10), rung 3 final
//   notice + offer to split into a payment plan (11+). Capped by
//   policy.collections.max_rung.
// - A payer with an OPEN DISPUTE linked to the invoice gets NO reminder
//   (returned as blocked_dispute) — chasing someone mid-dispute is both
//   rude and strategically wrong.
// - Content is built ONLY from invoice facts (id/number, amount, due
//   date, days overdue). No threats, no legal language, no deadlines
//   Guardian cannot enforce, no invented links or fees.
// - Dedupe: the same invoice at the same rung is proposed at most once,
//   ever (live, dismissed, expired or executed — the record stands, kept
//   in the scan's job_state cursor and cross-checked against the
//   approvals table). A reminder already sent also enforces
//   policy.collections.min_gap_hours_between_reminders before the next
//   rung may be proposed.
import type { GuardianStore } from "../db";
import { createApproval, surfaceApproval } from "../approvals";
import type { GuardianPolicy } from "../policy";

export const COLLECTIONS_TOOL = "send_invoice_reminder";
const DAY_MS = 24 * 3600_000;
const UNPAID_STATUSES = new Set(["SENT", "UNPAID", "PARTIALLY_PAID", "PAYMENT_PENDING"]);

export type Rung = 1 | 2 | 3;

export function rungForDays(daysOverdue: number): Rung | null {
  if (daysOverdue < 1) return null;
  if (daysOverdue <= 3) return 1;
  if (daysOverdue <= 10) return 2;
  return 3;
}

/** Calendar days between the due date and `now` (UTC calendar days). */
export function daysOverdue(dueDate: string, now: Date): number {
  const due = Date.parse(`${dueDate.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(due)) return 0;
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((todayUtc - due) / DAY_MS);
}

export interface InvoiceFacts {
  invoice_id: string;
  status: string;
  amount: number;
  currency: string;
  due_date: string | null;
  invoice_number: string | null;
  payer_name: string | null;
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

/** Facts of one invoice list item — defensive reads, nothing invented. */
export function invoiceFacts(item: any): InvoiceFacts {
  const billing = item?.primary_recipients?.[0]?.billing_info ?? {};
  const name =
    billing?.name?.alternate_full_name ?? billing?.name?.full_name ?? null;
  return {
    invoice_id: String(item?.id ?? ""),
    status: String(item?.status ?? ""),
    amount: num(item?.amount?.value),
    currency: item?.amount?.currency_code ?? "USD",
    due_date: item?.due_date ?? item?.detail?.due_date ?? null,
    invoice_number: item?.detail?.invoice_number ?? item?.invoice_number ?? null,
    payer_name: typeof name === "string" && name.trim() ? name : null,
  };
}

// --- reminder drafts ---------------------------------------------------------

export interface ReminderDraft {
  subject: string;
  note: string;
  /** rung 3 only: the split-payment offer carried in the note */
  plan_offer?: { suggested_installments: number };
}

const money = (a: number, c: string) => `$${a.toFixed(2)} ${c}`;

export function draftReminder(facts: InvoiceFacts, rung: Rung, days: number): ReminderDraft {
  const label = facts.invoice_number
    ? `invoice ${facts.invoice_number}`
    : `invoice ${facts.invoice_id}`;
  const Label = label.charAt(0).toUpperCase() + label.slice(1);
  const amount = money(facts.amount, facts.currency);
  const greet = facts.payer_name ? `Hi ${facts.payer_name},` : "Hello,";

  if (rung === 1) {
    return {
      subject: `Friendly reminder: ${label} for ${amount} was due on ${facts.due_date}`,
      note:
        `${greet}\n\n` +
        `A friendly reminder that ${label} for ${amount} was due on ${facts.due_date} ` +
        `and is still unpaid. If you have already paid, please ignore this message — ` +
        `and thank you.\n\n` +
        `You can pay from the PayPal invoice you received. If anything looks wrong ` +
        `with the invoice, just reply and we will sort it out.\n\n` +
        `Thank you!`,
    };
  }
  if (rung === 2) {
    return {
      subject: `${Label} is ${days} days overdue — ${amount}`,
      note:
        `${greet}\n\n` +
        `${Label} for ${amount} was due on ${facts.due_date} and is now ${days} days ` +
        `overdue. Please arrange payment as soon as you can — or reply to this email ` +
        `if there is a problem with the invoice. We would rather hear from you than ` +
        `guess what happened.\n\n` +
        `Payment can be made from the PayPal invoice you received. If you have ` +
        `already paid, please ignore this message.`,
    };
  }
  const installments = facts.amount >= 500 ? 3 : 2;
  return {
    subject: `Final reminder: ${label} — ${amount}, ${days} days overdue`,
    note:
      `${greet}\n\n` +
      `This is our final reminder about ${label} for ${amount}, due on ` +
      `${facts.due_date} and now ${days} days overdue. Please pay, or contact us ` +
      `so we can agree on how this gets settled.\n\n` +
      `If paying the full amount at once is difficult, reply to this email and ` +
      `we can split it into ${installments} smaller payments.\n\n` +
      `If you have already paid, please ignore this message.`,
    plan_offer: { suggested_installments: installments },
  };
}

// --- planning (pure) -----------------------------------------------------------

export interface CollectionProposal {
  invoice_id: string;
  rung: Rung;
  days_overdue: number;
  amount: number;
  currency: string;
  due_date: string;
  subject: string;
  note: string;
  plan_offer?: { suggested_installments: number };
}

export interface CollectionSkip {
  invoice_id: string;
  reason: string;
}

export interface CollectionsPlan {
  proposals: CollectionProposal[];
  blocked_dispute: string[];
  skipped_paid: string[];
  skipped: CollectionSkip[];
}

export function planCollections(
  items: any[],
  ctx: { now: Date; maxRung: number; disputedInvoiceIds: Set<string> }
): CollectionsPlan {
  const plan: CollectionsPlan = {
    proposals: [],
    blocked_dispute: [],
    skipped_paid: [],
    skipped: [],
  };
  for (const item of items ?? []) {
    const facts = invoiceFacts(item);
    if (!facts.invoice_id) continue;
    if (facts.status === "PAID") {
      plan.skipped_paid.push(facts.invoice_id); // §3.3: paid since → skip
      continue;
    }
    if (!UNPAID_STATUSES.has(facts.status)) {
      plan.skipped.push({
        invoice_id: facts.invoice_id,
        reason: `status ${facts.status || "unknown"} — reminders need a sent, unpaid invoice`,
      });
      continue;
    }
    if (ctx.disputedInvoiceIds.has(facts.invoice_id)) {
      plan.blocked_dispute.push(facts.invoice_id); // §3.3: open dispute → NO reminder
      continue;
    }
    if (!facts.due_date) {
      plan.skipped.push({
        invoice_id: facts.invoice_id,
        reason: "no due_date on the invoice record — its age cannot be computed, so no rung is guessed",
      });
      continue;
    }
    const days = daysOverdue(facts.due_date, ctx.now);
    const rawRung = rungForDays(days);
    if (rawRung === null) {
      plan.skipped.push({
        invoice_id: facts.invoice_id,
        reason: `not yet overdue (due ${facts.due_date})`,
      });
      continue;
    }
    const rung = Math.min(rawRung, Math.max(1, ctx.maxRung)) as Rung;
    const draft = draftReminder(facts, rung, days);
    plan.proposals.push({
      invoice_id: facts.invoice_id,
      rung,
      days_overdue: days,
      amount: facts.amount,
      currency: facts.currency,
      due_date: facts.due_date,
      subject: draft.subject,
      note: draft.note,
      ...(draft.plan_offer ? { plan_offer: draft.plan_offer } : {}),
    });
  }
  return plan;
}

// --- applying the plan: proposals → PENDING approvals, deduped -----------------

export interface CollectionsState {
  proposals: Record<string, { rung: number; approval_id: string; proposed_at: string }>;
  sent: Record<string, { rung: number; at: string }>;
}

export function emptyCollectionsState(): CollectionsState {
  return { proposals: {}, sent: {} };
}

export interface CreatedProposal {
  invoice_id: string;
  rung: Rung;
  approval_id: string;
  plan_offer?: { suggested_installments: number };
}

function executedAt(store: GuardianStore, merchantId: string, approvalId: string): string | null {
  for (const row of store.ledger.list(merchantId, 500)) {
    if (row.kind !== "approval") continue;
    try {
      const r = JSON.parse(row.result_json ?? "{}") as { approval_id?: string; to?: string };
      if (r.approval_id === approvalId && r.to === "EXECUTED") return row.at;
    } catch {
      /* not the row we are looking for */
    }
  }
  return null;
}

const LIVE_STATUSES = new Set(["PROPOSED", "PENDING", "APPROVED"]);

export function applyCollectionsPlan(
  store: GuardianStore,
  plan: CollectionsPlan,
  opts: { merchantId: string; now: Date; policy: GuardianPolicy; state: CollectionsState }
): { created: CreatedProposal[]; skipped: CollectionSkip[]; state: CollectionsState } {
  const { merchantId, now, policy } = opts;
  const state: CollectionsState = {
    proposals: { ...opts.state.proposals },
    sent: { ...opts.state.sent },
  };
  const created: CreatedProposal[] = [];
  const skipped: CollectionSkip[] = [...plan.skipped];
  const minGapMs = policy.collections.min_gap_hours_between_reminders * 3600_000;

  for (const p of plan.proposals) {
    const prev = state.proposals[p.invoice_id];
    if (prev) {
      const ap = store.approvals.get(prev.approval_id);
      if (ap?.status === "EXECUTED") {
        // Fold the finished proposal into the sent record, then evaluate
        // the (possibly higher) rung below.
        state.sent[p.invoice_id] = {
          rung: prev.rung,
          at: executedAt(store, merchantId, prev.approval_id) ?? ap.created_at,
        };
        delete state.proposals[p.invoice_id];
      } else if (prev.rung >= p.rung) {
        // Same invoice + same rung is never proposed twice — whatever the
        // earlier proposal's fate, the record stands.
        const reason = !ap
          ? `rung ${prev.rung} was already proposed (approval record missing)`
          : LIVE_STATUSES.has(ap.status)
            ? `a rung ${prev.rung} reminder proposal is already waiting for the merchant`
            : ap.status === "DISMISSED"
              ? `the merchant dismissed the rung ${prev.rung} proposal`
              : `the rung ${prev.rung} proposal expired unanswered — not proposed twice`;
        skipped.push({ invoice_id: p.invoice_id, reason });
        continue;
      } else if (ap && LIVE_STATUSES.has(ap.status)) {
        skipped.push({
          invoice_id: p.invoice_id,
          reason: `the rung ${prev.rung} proposal is still waiting for the merchant`,
        });
        continue;
      } else {
        // Lower-rung proposal dismissed/expired: the new rung supersedes it.
        delete state.proposals[p.invoice_id];
      }
    }

    const sent = state.sent[p.invoice_id];
    if (sent) {
      if (p.rung <= sent.rung) {
        skipped.push({
          invoice_id: p.invoice_id,
          reason: `already reminded at rung ${sent.rung}`,
        });
        continue;
      }
      if (now.getTime() - Date.parse(sent.at) < minGapMs) {
        skipped.push({
          invoice_id: p.invoice_id,
          reason: `last reminder sent less than ${policy.collections.min_gap_hours_between_reminders}h ago (policy min gap)`,
        });
        continue;
      }
    }

    const args = {
      invoice_id: p.invoice_id,
      subject: p.subject,
      note: p.note,
      send_to_invoicer: false,
    };
    const approval = createApproval(store, {
      merchantId,
      tool: COLLECTIONS_TOOL,
      args,
      reason:
        `Collections rung ${p.rung}: invoice ${p.invoice_id} is ${p.days_overdue} days ` +
        `overdue (${money(p.amount, p.currency)} due ${p.due_date})`,
      amountUsd: p.amount,
      createdBy: "collections",
    });
    surfaceApproval(store, approval.id);
    state.proposals[p.invoice_id] = {
      rung: p.rung,
      approval_id: approval.id,
      proposed_at: now.toISOString(),
    };
    created.push({
      invoice_id: p.invoice_id,
      rung: p.rung,
      approval_id: approval.id,
      ...(p.plan_offer ? { plan_offer: p.plan_offer } : {}),
    });
  }

  return { created, skipped, state };
}
