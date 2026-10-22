// Reconciliation report (DEVELOPMENT-PLAN pain #10, PHASES 5.4) —
// Phase 5C.
//
// Sellers' books go messy because holds and reversals make money appear
// to move twice. The ledger is Guardian's side of the story; this
// report checks it against PayPal's CURRENT state: every write the
// executor recorded as successful is read back (invoice status, dispute
// evidence) and lands in exactly one bucket —
//   matched      the read-back confirms the write took effect;
//   mismatched   the read-back contradicts it → the ledger row is
//                flagged RECONCILE_NEEDED, the same flag the Phase 1
//                sweep works from (nothing new invented here);
//   unverifiable no read-back can settle this write (e.g. a reminder
//                leaves no marker on the invoice) — said out loud,
//                never silently counted as matched.
// Failed/blocked ledger rows are not writes and are ignored; reads are
// counted as skipped so the report's coverage is explicit.
import { DEFAULT_MERCHANT_ID, type GuardianStore, type LedgerRow } from "../db";
import { getExecutor, type GuardianExecutor } from "../executor";
import { registerCoreTools, evidenceMatches } from "../tools";

/** The read-backs the report needs — injected so tests never touch the network. */
export interface ReconcileReportReaders {
  getDispute(disputeId: string): Promise<any>;
  getInvoice(invoiceId: string): Promise<any>;
}

export type ReconcileVerdict = "matched" | "mismatched" | "unverifiable";

export interface ReconcileCheckLine {
  ledgerId: number;
  tool: string;
  entity: string | null;
  verdict: ReconcileVerdict;
  detail: string;
}

export interface ReconcileReportResult {
  merchantId: string;
  ranAt: string;
  /** write rows actually checked */
  checked: number;
  matched: ReconcileCheckLine[];
  mismatched: ReconcileCheckLine[];
  unverifiable: ReconcileCheckLine[];
  /** successful non-write (READ) rows, counted for coverage honesty */
  skippedReads: number;
  text: string;
}

const WRITE_TOOLS = new Set([
  "provide_evidence",
  "send_invoice",
  "cancel_sent_invoice",
  "create_invoice",
  "send_invoice_reminder",
  "accept_dispute_claim",
  "create_refund",
  "pay_order",
]);

function parseJson(s: string | null): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function verify(
  row: LedgerRow,
  readers: ReconcileReportReaders
): Promise<{ entity: string | null; verdict: ReconcileVerdict; detail: string }> {
  const args = parseJson(row.args_redacted_json) ?? {};
  const result = parseJson(row.result_json) ?? {};
  const entity: string | null =
    (typeof args.invoice_id === "string" && args.invoice_id) ||
    (typeof args.dispute_id === "string" && args.dispute_id) ||
    (typeof result?.data?.id === "string" && result.data.id) ||
    (typeof result?.data?.invoice_id === "string" && result.data.invoice_id) ||
    (typeof result?.data?.dispute_id === "string" && result.data.dispute_id) ||
    null;

  switch (row.tool) {
    case "provide_evidence": {
      if (!entity || !Array.isArray(args.evidences)) {
        return { entity, verdict: "unverifiable", detail: "ledger row does not carry the dispute id + evidence args needed to re-check it" };
      }
      try {
        const dispute = await readers.getDispute(entity);
        const onFile: any[] = Array.isArray(dispute?.evidences) ? dispute.evidences : [];
        const ok = args.evidences.every((ev: any) => onFile.some((e) => evidenceMatches(e, ev)));
        return ok
          ? { entity, verdict: "matched", detail: "all submitted evidence is on file in the live dispute record" }
          : { entity, verdict: "mismatched", detail: "evidence recorded as submitted is NOT all present in the live dispute record" };
      } catch (e) {
        return { entity, verdict: "unverifiable", detail: `dispute read-back failed (${e instanceof Error ? e.message.slice(0, 160) : String(e)})` };
      }
    }
    case "send_invoice": {
      if (!entity) return { entity, verdict: "unverifiable", detail: "no invoice id on the ledger row" };
      try {
        const inv = await readers.getInvoice(entity);
        const status = typeof inv?.status === "string" ? inv.status : null;
        if (!status) return { entity, verdict: "unverifiable", detail: "invoice read-back carried no status" };
        return status === "DRAFT"
          ? { entity, verdict: "mismatched", detail: "invoice is still DRAFT — the recorded send did not take effect" }
          : { entity, verdict: "matched", detail: `invoice status is ${status} (sent state confirmed)` };
      } catch (e) {
        return { entity, verdict: "unverifiable", detail: `invoice read-back failed (${e instanceof Error ? e.message.slice(0, 160) : String(e)})` };
      }
    }
    case "cancel_sent_invoice": {
      if (!entity) return { entity, verdict: "unverifiable", detail: "no invoice id on the ledger row" };
      try {
        const inv = await readers.getInvoice(entity);
        const status = typeof inv?.status === "string" ? inv.status : null;
        if (!status) return { entity, verdict: "unverifiable", detail: "invoice read-back carried no status" };
        return status === "CANCELLED"
          ? { entity, verdict: "matched", detail: "invoice status is CANCELLED as recorded" }
          : { entity, verdict: "mismatched", detail: `invoice status is ${status}, not CANCELLED as the ledger records` };
      } catch (e) {
        return { entity, verdict: "unverifiable", detail: `invoice read-back failed (${e instanceof Error ? e.message.slice(0, 160) : String(e)})` };
      }
    }
    case "create_invoice": {
      if (!entity) return { entity, verdict: "unverifiable", detail: "no invoice id on the ledger row or its result" };
      try {
        const inv = await readers.getInvoice(entity);
        return typeof inv?.status === "string"
          ? { entity, verdict: "matched", detail: `invoice exists at PayPal (status ${inv.status})` }
          : { entity, verdict: "unverifiable", detail: "invoice read-back carried no status" };
      } catch (e) {
        return { entity, verdict: "unverifiable", detail: `invoice read-back failed (${e instanceof Error ? e.message.slice(0, 160) : String(e)})` };
      }
    }
    case "send_invoice_reminder":
      // Same standard the executor documents for this tool: a reminder
      // leaves no marker on the invoice record, so no read-back can
      // confirm or deny it after the fact.
      return {
        entity,
        verdict: "unverifiable",
        detail: "a reminder leaves no marker on the invoice record, so no read-back can confirm it after the fact",
      };
    default:
      return {
        entity,
        verdict: "unverifiable",
        detail: `no read-back is registered for ${row.tool} in the reconciliation report`,
      };
  }
}

export async function buildReconcileReport(
  store: GuardianStore,
  readers: ReconcileReportReaders,
  opts?: { merchantId?: string; now?: Date; limit?: number }
): Promise<ReconcileReportResult> {
  const merchantId = opts?.merchantId ?? DEFAULT_MERCHANT_ID;
  const now = opts?.now ?? new Date();
  const rows = store.ledger.list(merchantId, opts?.limit ?? 500);

  const matched: ReconcileCheckLine[] = [];
  const mismatched: ReconcileCheckLine[] = [];
  const unverifiable: ReconcileCheckLine[] = [];
  let skippedReads = 0;

  for (const row of rows) {
    if (row.kind !== "tool_call" || !row.tool) continue;
    const result = parseJson(row.result_json);
    if (!result || result.ok !== true) continue; // not an executed write
    if (!WRITE_TOOLS.has(row.tool)) {
      skippedReads++;
      continue;
    }
    const v = await verify(row, readers);
    let detail = v.detail;
    // The flag is the Phase 1 mechanism (§4.3 step 6): a mismatch joins
    // the sweep's worklist; a match that was flagged is cleared.
    if (v.verdict === "mismatched" && !row.reconcile_flag) {
      store.ledger.setReconcileFlag(row.id, true);
      detail += " Flagged RECONCILE_NEEDED for the reconcile sweep.";
    } else if (v.verdict === "matched" && row.reconcile_flag) {
      store.ledger.setReconcileFlag(row.id, false);
      detail += " Cleared a stale RECONCILE_NEEDED flag.";
    }
    const line: ReconcileCheckLine = {
      ledgerId: row.id,
      tool: row.tool,
      entity: v.entity,
      verdict: v.verdict,
      detail,
    };
    if (v.verdict === "matched") matched.push(line);
    else if (v.verdict === "mismatched") mismatched.push(line);
    else unverifiable.push(line);
  }

  const checked = matched.length + mismatched.length + unverifiable.length;
  const lines: string[] = [
    `Reconciliation report — ${now.toISOString()}`,
    `Checked ${checked} executed write(s): ${matched.length} matched, ${mismatched.length} mismatched, ${unverifiable.length} unverifiable.`,
  ];
  for (const m of mismatched) lines.push(`MISMATCH ledger #${m.ledgerId} ${m.tool} ${m.entity ?? ""} — ${m.detail}`);
  for (const u of unverifiable) lines.push(`UNVERIFIABLE ledger #${u.ledgerId} ${u.tool} ${u.entity ?? ""} — ${u.detail}`);

  return {
    merchantId,
    ranAt: now.toISOString(),
    checked,
    matched,
    mismatched,
    unverifiable,
    skippedReads,
    text: lines.join("\n"),
  };
}

/** Production readers: invoice + dispute read-backs through the executor. */
export function executorReconcileReaders(
  executor: GuardianExecutor = getExecutor()
): ReconcileReportReaders {
  registerCoreTools(executor);
  return {
    getDispute: async (disputeId) =>
      (await executor.execute("get_dispute", { dispute_id: disputeId }, { actor: "reconcile-report" })).data,
    getInvoice: async (invoiceId) =>
      (await executor.execute("get_invoice", { invoice_id: invoiceId }, { actor: "reconcile-report" })).data,
  };
}
