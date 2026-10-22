// Analyst Worker (ARCHITECTURE-DETAIL.md §3.4) — Phase 2B.
//
// The query layer of the Analyst: a pure function over (store, PayPal
// readers, range) that returns the §3.4 output schema as JSON. No LLM is
// involved here — the Coordinator turns this JSON into prose. Every
// figure comes from an actual PayPal read through the executor; when a
// number cannot be produced (classically: the Transaction Search scope
// is not enabled on the app) the field is null and `notes` says exactly
// why — invoice sums are NEVER substituted for transaction sums (§3.4).
import { DEFAULT_MERCHANT_ID, type GuardianStore } from "../db";
import { getExecutor, type GuardianExecutor } from "../executor";
import { registerCoreTools } from "../tools";
import {
  getTokenInfo,
  TRANSACTION_SEARCH_SCOPE,
  PayPalRestError,
} from "../paypal-rest";

export interface AnalystRange {
  /** ISO instant, inclusive */
  start: string;
  /** ISO instant, inclusive */
  end: string;
}

/** The PayPal reads the Analyst needs — injected so tests never touch the network. */
export interface PayPalReaders {
  listTransactions(args: { start_date: string; end_date: string }): Promise<any>;
  listInvoices(): Promise<any>;
  listDisputes(): Promise<any>;
  /** OAuth scopes granted to the app; ground truth for feature availability. */
  getScopes?: () => Promise<string[]>;
}

export interface MoneyFigure {
  amount: number;
  currency: string;
}

export interface AnalystReport {
  range: { start: string; end: string; timezone: string };
  /** settled money in over the range — null when it cannot be produced */
  money_in: MoneyFigure | null;
  outstanding: MoneyFigure & { count: number };
  at_risk: MoneyFigure & {
    dispute_total: number;
    held_total: number;
    open_disputes: number;
  };
  top_unpaid: {
    invoice_id: string;
    amount: number;
    currency: string;
    status: string;
    due_date: string | null;
  }[];
  notes: string[];
}

export interface AnalystOptions {
  merchantId?: string;
  timezone?: string;
}

const UNPAID_STATUSES = new Set([
  "SENT",
  "UNPAID",
  "PARTIALLY_PAID",
  "PAYMENT_PENDING",
]);
const CLOSED_CASE = /^(RESOLVED|CLOSED|DENIED|CANCELLED)/i;

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

/** Single-currency accumulator; foreign currencies are reported, not mixed in. */
class MoneyBag {
  currency: string | null = null;
  total = 0;
  others = new Set<string>();
  add(amount: number, currency: string | undefined) {
    const cur = currency || "USD";
    if (!this.currency) this.currency = cur;
    if (cur === this.currency) this.total += amount;
    else this.others.add(cur);
  }
  figure(): MoneyFigure {
    return { amount: round2(this.total), currency: this.currency ?? "USD" };
  }
}

function caseBody(store: GuardianStore, merchantId: string) {
  return store.cases.list(merchantId).filter((row) => !CLOSED_CASE.test(row.status ?? ""));
}

export async function runAnalyst(
  store: GuardianStore,
  readers: PayPalReaders,
  range: AnalystRange,
  opts?: AnalystOptions
): Promise<AnalystReport> {
  const merchantId = opts?.merchantId ?? DEFAULT_MERCHANT_ID;
  const timezone = opts?.timezone ?? "Asia/Saigon";
  const notes: string[] = [];

  // ---- money in + held (transactions) -------------------------------------
  let moneyIn: MoneyFigure | null = null;
  const heldBag = new MoneyBag();
  let txScopeMissing = false;
  if (readers.getScopes) {
    const scopes = await readers.getScopes().catch(() => [] as string[]);
    txScopeMissing = !scopes.includes(TRANSACTION_SEARCH_SCOPE);
  }
  if (txScopeMissing) {
    notes.push(
      "Transaction Search scope is not enabled on the PayPal app, so money_in and held amounts cannot be produced. Enable 'Transaction Search' in Developer Dashboard > Apps & Credentials, then Save changes. (Invoice totals are not a substitute and were not used.)"
    );
  } else {
    try {
      const tx = await readers.listTransactions({
        start_date: range.start,
        end_date: range.end,
      });
      const inBag = new MoneyBag();
      for (const t of tx?.transaction_details ?? []) {
        const info = t?.transaction_info ?? {};
        const amount = num(info.transaction_amount?.value);
        const cur = info.transaction_amount?.currency_code;
        if (amount <= 0) continue;
        if (info.transaction_status === "S") inBag.add(amount, cur);
        else if (info.transaction_status === "P") heldBag.add(amount, cur);
      }
      moneyIn = inBag.figure();
      if (inBag.others.size) {
        notes.push(
          `Transactions in other currencies (${[...inBag.others].join(", ")}) were excluded from money_in, which is reported in ${inBag.currency}.`
        );
      }
    } catch (e) {
      const status = e instanceof PayPalRestError ? e.status : undefined;
      moneyIn = null;
      notes.push(
        status === 403 || /scope|NOT_AUTHORIZED/i.test(e instanceof Error ? e.message : "")
          ? "PayPal refused the transactions read (403): the Transaction Search scope appears to be missing, so money_in cannot be produced."
          : `Transactions read failed (${e instanceof Error ? e.message.slice(0, 160) : String(e)}), so money_in cannot be produced for this range.`
      );
    }
  }

  // ---- outstanding (unpaid sent invoices) ----------------------------------
  const inv = await readers.listInvoices();
  const invItems: any[] = Array.isArray(inv?.items) ? inv.items : [];
  if (typeof inv?.total_pages === "number" && inv.total_pages > 1) {
    notes.push(
      `Invoice list has ${inv.total_pages} pages; only the first page (100) was read, so outstanding may be understated.`
    );
  }
  const outBag = new MoneyBag();
  const unpaid: AnalystReport["top_unpaid"] = [];
  for (const item of invItems) {
    const status = String(item?.status ?? "");
    if (!UNPAID_STATUSES.has(status)) continue;
    const amount = num(item?.amount?.value);
    const currency = item?.amount?.currency_code ?? "USD";
    outBag.add(amount, currency);
    unpaid.push({
      invoice_id: String(item?.id ?? ""),
      amount: round2(amount),
      currency,
      status,
      due_date: item?.due_date ?? item?.detail?.due_date ?? null,
    });
  }
  unpaid.sort((a, b) => b.amount - a.amount);

  // ---- at risk (open disputes + held) --------------------------------------
  const disp = await readers.listDisputes().catch(() => ({ items: [] as any[] }));
  const dispItems: any[] = Array.isArray(disp?.items) ? disp.items : [];
  const riskBag = new MoneyBag();
  const seenDisputes = new Set<string>();
  let disputeTotal = 0;
  for (const d of dispItems) {
    const status = String(d?.status ?? "");
    if (CLOSED_CASE.test(status)) continue;
    const id = String(d?.dispute_id ?? d?.id ?? "");
    if (id) seenDisputes.add(id);
    const amount = num(d?.dispute_amount?.value ?? d?.amount?.value);
    const currency = d?.dispute_amount?.currency_code ?? d?.amount?.currency_code;
    riskBag.add(amount, currency);
    disputeTotal += amount;
  }
  // PayPal's sandbox dispute LIST is known to lag/return empty even when a
  // case exists (POC finding, Phase 1) — Guardian's own tracked cases are
  // the supplement, deduped by id, and the substitution is declared.
  let supplemented = 0;
  for (const row of caseBody(store, merchantId)) {
    if (seenDisputes.has(row.id)) continue;
    let amount = 0;
    let currency: string | undefined;
    try {
      const body = JSON.parse(row.body_json) as Record<string, any>;
      amount = num(body.amount_usd ?? body.dispute_amount?.value ?? body.amount?.value);
      currency = body.dispute_amount?.currency_code ?? body.amount?.currency_code;
    } catch {
      /* amount stays 0 */
    }
    riskBag.add(amount, currency);
    disputeTotal += amount;
    supplemented++;
  }
  if (supplemented > 0) {
    notes.push(
      `PayPal's dispute list did not include ${supplemented} open case(s) Guardian is tracking locally; they were included in at_risk from case memory.`
    );
  }

  const held = heldBag.figure();
  const risk = riskBag.figure();
  return {
    range: { start: range.start, end: range.end, timezone },
    money_in: moneyIn,
    outstanding: { ...outBag.figure(), count: unpaid.length },
    at_risk: {
      amount: round2(risk.amount + (moneyIn ? held.amount : 0)),
      currency: risk.currency,
      dispute_total: round2(disputeTotal),
      held_total: moneyIn ? held.amount : 0,
      open_disputes: seenDisputes.size + supplemented,
    },
    top_unpaid: unpaid.slice(0, 5),
    notes,
  };
}

/** Convenience range: the last `days` days ending now. */
export function trailingRange(days: number, now = new Date()): AnalystRange {
  const end = now;
  const start = new Date(now.getTime() - days * 24 * 3600_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Production readers: every call goes through the single executor path
 * (registration in tools.ts), so Analyst reads are validated + ledgered
 * like every other PayPal call. No side doors.
 */
export function executorReaders(
  executor: GuardianExecutor = getExecutor()
): PayPalReaders {
  registerCoreTools(executor);
  const call = async (tool: string, args: Record<string, unknown>) =>
    (await executor.execute(tool, args, { actor: "analyst" })).data;
  return {
    listTransactions: (args) => call("list_transactions", { ...args }),
    listInvoices: () => call("list_invoices", {}),
    listDisputes: () => call("list_disputes", {}),
    getScopes: async () => (await getTokenInfo()).scopes,
  };
}
