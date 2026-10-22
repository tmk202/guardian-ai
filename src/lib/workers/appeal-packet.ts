// Appeal Packet (PHASES 4B.3, DEVELOPMENT-PLAN pain #2) — Phase 4B.
//
// When a merchant is limited — or a case needs a human-grade response —
// the facts they need are scattered: the dispute record at PayPal, the
// invoice, the tracking number, what evidence was already sent, the
// deadline. This worker gathers everything Guardian can actually read
// (its own case table + case memory + the ledger, plus live read-backs
// of the dispute and the invoice through the executor) and lays it out
// as one structured Markdown packet the merchant can review, complete,
// and submit themselves.
//
// HONESTY CONTRACT: anything Guardian could not find is listed as
// "MISSING: ..." — never filled in, never paraphrased into existence.
// Guardian cannot lift a limitation or decide a case; the packet says
// so on its face.
import { DEFAULT_MERCHANT_ID, type GuardianStore } from "../db";
import { getExecutor, type GuardianExecutor } from "../executor";
import { registerCoreTools } from "../tools";
import { memoryRead } from "../memory";
import { extractDisputeDeadline } from "../triage";
import { playbookFor, type PlaybookBucket } from "./outcomes";

/** The PayPal read-backs the packet needs — injected so tests never touch the network. */
export interface AppealPacketReaders {
  getDispute(disputeId: string): Promise<any>;
  getInvoice(invoiceId: string): Promise<any>;
}

export interface AppealPacketOptions {
  merchantId?: string;
  now?: Date;
  readers?: AppealPacketReaders;
}

export interface AppealPacketResult {
  caseId: string;
  markdown: string;
  /** every gap Guardian found, each already phrased "MISSING: ..." */
  missing: string[];
  sources: { storeCase: boolean; caseMemory: boolean; paypalDispute: boolean; paypalInvoice: boolean };
  /** playbook bucket for this case's (reason × tracking), only when the
   *  recorded sample is large enough to quote (Phase 5A) — else null */
  playbook: PlaybookBucket | null;
}

interface EvidenceLine {
  type: string;
  carrier?: string;
  tracking?: string;
  notes?: string;
  at?: string;
  result?: string;
  source: string;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v : null;
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

function normalizeStoreEvidence(body: Record<string, any>): EvidenceLine[] {
  const out: EvidenceLine[] = [];
  for (const e of Array.isArray(body.evidence_submitted) ? body.evidence_submitted : []) {
    out.push({
      type: String(e?.type ?? e?.evidence_type ?? "UNKNOWN"),
      carrier: str(e?.carrier) ?? undefined,
      tracking: str(e?.tracking) ?? str(e?.tracking_number) ?? undefined,
      notes: str(e?.notes) ?? undefined,
      at: str(e?.at) ?? undefined,
      result: str(e?.result) ?? undefined,
      source: "Guardian case memory",
    });
  }
  return out;
}

function normalizeRestEvidence(dispute: any): EvidenceLine[] {
  const out: EvidenceLine[] = [];
  for (const e of Array.isArray(dispute?.evidences) ? dispute.evidences : []) {
    const infos = Array.isArray(e?.evidence_info?.tracking_info)
      ? e.evidence_info.tracking_info
      : [];
    if (infos.length) {
      for (const ti of infos) {
        out.push({
          type: String(e?.evidence_type ?? "UNKNOWN"),
          carrier: str(ti?.carrier_name) ?? undefined,
          tracking: str(ti?.tracking_number) ?? undefined,
          notes: str(e?.notes) ?? undefined,
          source: "PayPal dispute record",
        });
      }
    } else {
      out.push({
        type: String(e?.evidence_type ?? "UNKNOWN"),
        notes: str(e?.notes) ?? undefined,
        source: "PayPal dispute record",
      });
    }
  }
  return out;
}

function mergeEvidence(a: EvidenceLine[], b: EvidenceLine[]): EvidenceLine[] {
  const seen = new Set<string>();
  const out: EvidenceLine[] = [];
  for (const e of [...a, ...b]) {
    const key = `${e.type}|${e.tracking ?? ""}|${e.carrier ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

export async function buildAppealPacket(
  store: GuardianStore,
  caseId: string,
  opts?: AppealPacketOptions
): Promise<AppealPacketResult> {
  const merchantId = opts?.merchantId ?? DEFAULT_MERCHANT_ID;
  const now = opts?.now ?? new Date();
  const readers = opts?.readers ?? executorPacketReaders();

  // ---- gather ----------------------------------------------------------------
  const caseRow = store.cases.get(caseId);
  const caseMem = memoryRead(store, merchantId, { kind: "C", entity: caseId })[0];
  let rowBody: Record<string, any> = {};
  if (caseRow) {
    try {
      rowBody = JSON.parse(caseRow.body_json) as Record<string, any>;
    } catch {
      /* body stays empty */
    }
  }
  const body: Record<string, any> = { ...rowBody, ...(caseMem?.body ?? {}) };

  const dispute = await readers.getDispute(caseId).catch(() => null);
  if (!caseRow && !caseMem && !dispute) {
    throw new Error(
      `Appeal packet: case ${caseId} not found — no case row, no case memory, and PayPal returned no dispute for this id`
    );
  }

  const reason = str(dispute?.reason) ?? str(body.reason);
  const amount =
    num(dispute?.dispute_amount?.value) ?? num(body.amount_usd) ?? num(body.amount?.value);
  const currency =
    str(dispute?.dispute_amount?.currency_code) ?? str(body.currency) ?? "USD";
  const status = str(dispute?.status) ?? str(caseRow?.status) ?? str(body.status) ?? str(body.stage);
  const stage = str(dispute?.dispute_state) ?? str(body.stage);
  const deadline =
    caseRow?.deadline_at ??
    extractDisputeDeadline(dispute) ??
    str(body.deadline_at);
  const relatedInvoiceId =
    str(body.related_invoice) ??
    str(body.invoice_id) ??
    str(dispute?.disputed_transactions?.[0]?.invoice_id);
  const transactionId =
    str(dispute?.disputed_transactions?.[0]?.seller_transaction_id) ??
    str(body.transaction_id);
  const buyerEmail =
    str(dispute?.disputed_transactions?.[0]?.buyer_email) ?? null;

  const invoice = relatedInvoiceId
    ? await readers.getInvoice(relatedInvoiceId).catch(() => null)
    : null;

  const evidences = mergeEvidence(
    normalizeStoreEvidence(body),
    dispute ? normalizeRestEvidence(dispute) : []
  );
  const trackingLine = evidences.find((e) => e.tracking);

  // Ledger history that mentions this case — Guardian's own audit trail.
  const ledgerLines = store
    .ledger.list(merchantId, 500)
    .filter((row) =>
      `${row.args_redacted_json ?? ""} ${row.result_json ?? ""} ${row.tool ?? ""}`.includes(caseId)
    )
    .sort((a, b) => a.at.localeCompare(b.at));

  const notes = memoryRead(store, merchantId, { kind: "D" }).filter(
    (e) =>
      e.entityKey === caseId ||
      (Array.isArray(e.body.refs) && (e.body.refs as unknown[]).includes(caseId))
  );

  // ---- what's missing -----------------------------------------------------------
  const missing: string[] = [];
  if (!trackingLine) {
    missing.push(
      "MISSING: tracking number / proof of fulfillment — no shipment tracking was found in the case memory or the PayPal dispute record. Add the carrier tracking for this order before submitting."
    );
  }
  const hasDeliveryProof = evidences.some((e) =>
    /DELIVERY/i.test(e.type) || /delivered/i.test(e.notes ?? "")
  );
  if (!hasDeliveryProof) {
    missing.push(
      "MISSING: proof of delivery — no carrier delivery confirmation is on file. Download the delivery record from the carrier and attach it; proof of shipment alone is weaker."
    );
  }
  if (!relatedInvoiceId || !invoice) {
    missing.push(
      relatedInvoiceId
        ? `MISSING: related invoice — invoice ${relatedInvoiceId} is linked to the case but could not be read back from PayPal.`
        : "MISSING: related invoice — no invoice is linked to this case in Guardian's records or the PayPal dispute."
    );
  }
  if (!deadline) {
    missing.push(
      "MISSING: response deadline — neither Guardian's case record nor the PayPal dispute exposed one. Check the Resolution Center for the exact date; missing it loses the case automatically."
    );
  }
  if (!dispute) {
    missing.push(
      "MISSING: live PayPal dispute read-back — the packet was assembled from Guardian's stored records only; verify the current case status in the Resolution Center."
    );
  }

  // ---- render ---------------------------------------------------------------------
  const L: string[] = [];
  L.push(`# Appeal packet — case ${caseId}`);
  L.push("");
  L.push(
    `Prepared by Guardian on ${now.toISOString()} from the merchant's own records ` +
      `and PayPal read-backs. Guardian cannot lift a limitation, release a hold, or ` +
      `decide a case — this packet organises the verified facts so the merchant can ` +
      `submit a complete appeal themselves. Anything Guardian could not find is ` +
      `listed under "What's missing" instead of being filled in.`
  );
  L.push("");
  L.push("## Case summary");
  L.push(`- Case: ${caseId}`);
  L.push(`- Reason: ${reason ?? "not recorded"}`);
  L.push(
    `- Amount: ${amount !== null ? `$${amount.toFixed(2)} ${currency}` : "not recorded"}`
  );
  L.push(`- Status: ${status ?? "not recorded"}${stage ? ` (stage: ${stage})` : ""}`);
  L.push(`- Response deadline: ${deadline ?? "MISSING — see below"}`);
  if (str(dispute?.create_time)) L.push(`- Opened (PayPal): ${dispute.create_time}`);
  if (transactionId) L.push(`- Seller transaction: ${transactionId}`);
  if (buyerEmail) L.push(`- Buyer email (PayPal record): ${buyerEmail}`);
  L.push("");
  L.push("## Timeline");
  const tl: { at: string; text: string }[] = [];
  if (str(dispute?.create_time)) tl.push({ at: dispute.create_time, text: `Case opened at PayPal (${reason ?? "reason not recorded"}).` });
  for (const e of evidences) {
    if (e.at) tl.push({ at: e.at, text: `Evidence ${e.type}${e.tracking ? ` (tracking ${e.tracking})` : ""} — recorded by ${e.source}.` });
  }
  for (const n of notes) {
    if (typeof n.body.date === "string" && typeof n.body.summary === "string") {
      tl.push({ at: n.body.date, text: n.body.summary });
    }
  }
  for (const row of ledgerLines) {
    tl.push({ at: row.at, text: `Guardian ledger #${row.id}: ${row.actor} · ${row.kind}${row.tool ? ` · ${row.tool}` : ""}.` });
  }
  if (str(dispute?.update_time)) tl.push({ at: dispute.update_time, text: "Case last updated at PayPal." });
  tl.sort((a, b) => a.at.localeCompare(b.at));
  if (tl.length) for (const t of tl) L.push(`- ${t.at} — ${t.text}`);
  else L.push("- No dated events were recorded for this case.");
  L.push("");
  L.push("## Evidence on file");
  if (evidences.length) {
    for (const e of evidences) {
      const bits = [e.type];
      if (e.carrier) bits.push(`carrier ${e.carrier}`);
      if (e.tracking) bits.push(`tracking ${e.tracking}`);
      if (e.notes) bits.push(`notes: ${e.notes}`);
      if (e.result) bits.push(`result: ${e.result}`);
      L.push(`- ${bits.join(" · ")} (source: ${e.source})`);
    }
  } else {
    L.push("- None found — see \"What's missing\".");
  }
  L.push("");
  // Playbook (Phase 5A): what happened in similar decided cases. Shown
  // ONLY when the recorded sample for this (reason × tracking) bucket is
  // large enough (playbookFor returns null below the threshold) — and
  // always with n attached, so a small sample can never pose as a law.
  const playbook = reason ? playbookFor(store, merchantId, reason, !!trackingLine) : null;
  if (playbook) {
    L.push("## Similar cases (Guardian playbook)");
    L.push(
      `- Recorded outcomes for reason ${playbook.reason} with ${playbook.hasTracking ? "tracking submitted" : "no tracking submitted"}: n=${playbook.n} — won ${playbook.won}, lost ${playbook.lost}, other ${playbook.other + playbook.unknown}.`
    );
    L.push(
      `- Win rate over the ${playbook.decided} decided case(s): ${Math.round((playbook.winRate ?? 0) * 100)}%. A hint for which evidence to prioritise first — not a promise about this case.`
    );
    L.push("");
  }
  L.push("## Order & invoice");
  if (invoice) {
    const items = Array.isArray(invoice.items) ? invoice.items : [];
    L.push(`- Invoice: ${relatedInvoiceId} — status ${invoice.status ?? "unknown"}`);
    if (str(invoice.detail?.invoice_number)) L.push(`- Invoice number: ${invoice.detail.invoice_number}`);
    const amt = num(invoice.amount?.value);
    if (amt !== null) L.push(`- Invoice amount: $${amt.toFixed(2)} ${invoice.amount?.currency_code ?? currency}`);
    const payer = invoice.primary_recipients?.[0]?.billing_info;
    if (payer?.email_address) L.push(`- Billed to: ${payer.email_address}`);
    for (const it of items) {
      L.push(`- Item: ${it?.name ?? "item"} × ${it?.quantity ?? "?"} — $${num(it?.unit_amount?.value)?.toFixed(2) ?? "?"} ${it?.unit_amount?.currency_code ?? ""}`);
    }
    const payments = Array.isArray(invoice.payments) ? invoice.payments : [];
    for (const p of payments) {
      if (p?.transaction_id) L.push(`- Payment transaction: ${p.transaction_id} (${p?.method ?? "PAYPAL"})`);
    }
  } else if (relatedInvoiceId) {
    L.push(`- Invoice ${relatedInvoiceId} is linked to the case but could not be read back (see "What's missing").`);
  } else {
    L.push("- No invoice is linked to this case (see \"What's missing\").");
  }
  L.push("");
  L.push("## What's missing");
  if (missing.length) for (const m of missing) L.push(`- ${m}`);
  else L.push("- Nothing Guardian checks for is missing.");
  L.push("");
  L.push(
    "_Sources: Guardian case table + case memory + audit ledger; PayPal Disputes API " +
      "and Invoicing API read-backs. No figure in this packet was estimated or invented._"
  );

  return {
    caseId,
    markdown: L.join("\n") + "\n",
    missing,
    sources: {
      storeCase: !!caseRow,
      caseMemory: !!caseMem,
      paypalDispute: !!dispute,
      paypalInvoice: !!invoice,
    },
    playbook,
  };
}

/** Production readers: dispute + invoice read-backs through the executor. */
export function executorPacketReaders(
  executor: GuardianExecutor = getExecutor()
): AppealPacketReaders {
  registerCoreTools(executor);
  return {
    getDispute: async (disputeId) =>
      (await executor.execute("get_dispute", { dispute_id: disputeId }, { actor: "appeal-packet" })).data,
    getInvoice: async (invoiceId) =>
      (await executor.execute("get_invoice", { invoice_id: invoiceId }, { actor: "appeal-packet" })).data,
  };
}
