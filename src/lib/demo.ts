// Demo mode — used when no LLM key is configured.
//
// Why this exists: Guardian's PayPal "hands" were proven end-to-end on the
// real PayPal sandbox (see scripts/poc-*.mjs — a $450 invoice created+sent,
// a buyer payment, a dispute case with seller evidence accepted, HTTP 200).
// The public demo runs WITHOUT a live LLM key, so instead of erroring, the
// chat walks through those real sandbox runs with their real IDs, amounts
// and statuses. Every figure below comes from an actual sandbox artifact —
// nothing is invented. Connect any AI key (AI_API_KEY) and the same UI runs
// the live agent instead (src/lib/agent.ts).

export const DEMO = {
  invoice450: {
    id: "INV2-Y236-HYWD-Z2DK-XSYC",
    number: "GUARDIAN-POC-001",
    amount: "450.00",
    currency: "USD",
    status: "SENT",
  },
  invoice120: {
    id: "INV2-BYHA-VCDE-7EF2-A9N9",
    number: "GUARDIAN-POC-002",
    item: "Wireless earbuds — Bluetooth 5.3",
    amount: "120.00",
    currency: "USD",
    status: "PAID",
    transactionId: "16F19418T8805571K",
  },
  dispute: {
    id: "PP-R-GAW-10194043",
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    amount: "120.00",
    currency: "USD",
    status: "UNDER_REVIEW (claim)",
    carrier: "FEDEX",
    tracking: "GUARDIAN-TRACK-001",
    evidence: "PROOF_OF_FULFILLMENT — submitted by seller, accepted (HTTP 200)",
  },
};

type Step = {
  toolCalls: { toolName: string; args: Record<string, unknown> }[];
  toolResults: { toolName: string }[];
};
const step = (toolName: string, args: Record<string, unknown> = {}): Step => ({
  toolCalls: [{ toolName, args }],
  toolResults: [{ toolName }],
});

export function runDemo(prompt: string) {
  const p = prompt.toLowerCase();
  let text: string;
  let steps: Step[];

  if (p.includes("dispute") || p.includes("claim") || p.includes("worried")) {
    steps = [step("list_disputes"), step("get_dispute", { dispute_id: DEMO.dispute.id })];
    text =
      `You have 1 open dispute to know about:\n\n` +
      `Case ${DEMO.dispute.id} — $${DEMO.dispute.amount} ${DEMO.dispute.currency}\n` +
      `Reason: buyer says the item was not received (${DEMO.dispute.reason}).\n` +
      `Status: ${DEMO.dispute.status}.\n\n` +
      `I found the shipment (${DEMO.dispute.carrier} tracking ${DEMO.dispute.tracking}) and prepared an evidence package for you. ` +
      `I never submit evidence without your approval — review the package below and approve when you're ready.`;
    return {
      text,
      steps,
      mode: "demo" as const,
      approval: {
        kind: "provide_evidence",
        caseId: DEMO.dispute.id,
        evidenceType: "PROOF_OF_FULFILLMENT",
        carrier: DEMO.dispute.carrier,
        tracking: DEMO.dispute.tracking,
        amount: `$${DEMO.dispute.amount} ${DEMO.dispute.currency}`,
      },
    };
  } else if (p.includes("hasn't paid") || p.includes("hasnt paid") || p.includes("unpaid") || p.includes("owe") || p.includes("who")) {
    steps = [step("list_invoices", { status: "SENT,UNPAID" })];
    text =
      `1 invoice is still unpaid:\n\n` +
      `${DEMO.invoice450.id} — $${DEMO.invoice450.amount} ${DEMO.invoice450.currency} (#${DEMO.invoice450.number}), status ${DEMO.invoice450.status}.\n\n` +
      `Already settled: ${DEMO.invoice120.id} — $${DEMO.invoice120.amount} for "${DEMO.invoice120.item}", PAID (transaction ${DEMO.invoice120.transactionId}).\n\n` +
      `Want me to send a payment reminder for the $450 one? Reminders are limited to 2 per day.`;
  } else if (p.includes("remind")) {
    steps = [step("send_invoice_reminder", { invoice_id: DEMO.invoice450.id })];
    text =
      `Reminder queued for invoice ${DEMO.invoice450.id} ($${DEMO.invoice450.amount} ${DEMO.invoice450.currency}). ` +
      `PayPal allows at most 2 reminders per invoice per day, so I'll pace them instead of spamming your customer.`;
  } else if (p.includes("invoice") || p.includes("bill")) {
    steps = [
      step("create_invoice", { amount: DEMO.invoice450.amount, currency: DEMO.invoice450.currency }),
      step("send_invoice", { invoice_id: DEMO.invoice450.id }),
    ];
    text =
      `Done. Invoice ${DEMO.invoice450.id} for $${DEMO.invoice450.amount} ${DEMO.invoice450.currency} (#${DEMO.invoice450.number}) was created and sent — status ${DEMO.invoice450.status}. ` +
      `Your customer gets a PayPal payment link by email; you'll see it flip to PAID the moment they pay.`;
  } else if (p.includes("today") || p.includes("report") || p.includes("money") || p.includes("came in") || p.includes("hold")) {
    steps = [step("list_transactions"), step("list_invoices"), step("list_disputes")];
    text =
      `Money report:\n\n` +
      `IN: $${DEMO.invoice120.amount} ${DEMO.invoice120.currency} — "${DEMO.invoice120.item}" invoice paid (transaction ${DEMO.invoice120.transactionId}).\n` +
      `STILL OUT: $${DEMO.invoice450.amount} — invoice ${DEMO.invoice450.id} sent, awaiting payment.\n` +
      `UNDER REVIEW: $${DEMO.dispute.amount} — dispute ${DEMO.dispute.id}; your evidence package is ready and waiting for your approval to submit.`;
  } else {
    steps = [];
    text =
      `I can do three jobs for you — try one:\n\n` +
      `1. "Create a $450 invoice for my customer" — I draft and send it.\n` +
      `2. "Any disputes I should worry about?" — I read the case and prepare your evidence.\n` +
      `3. "What came in today, and who hasn't paid me?" — your money report.\n\n` +
      `Anything sensitive (refunds, accepting a claim, submitting evidence) always stops for your approval first.`;
  }

  return { text, steps, mode: "demo" as const };
}
