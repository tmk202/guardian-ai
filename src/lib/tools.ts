// Tool registry + wiring (ARCHITECTURE-DETAIL.md §4) — Phase 1A.
//
// Every PayPal capability the agent can touch is described once here: its
// class (READ / WRITE / SENSITIVE per §5.1), its entity key for idempotency,
// and — for the custom REST tool the toolkit lacks — its handler and
// read-back. The agent's toolkit tools are wrapped so their execute() goes
// through the executor like everything else: no side doors.
import { z } from "zod";
import {
  getExecutor,
  ExecutorError,
  defaultEntityOf,
  type GuardianExecutor,
  type ToolClass,
} from "./executor";
import { provideEvidence, getDispute, type EvidenceInput } from "./disputes";
import {
  listInvoicesRest,
  listDisputesRest,
  listTransactionsRest,
  getInvoiceRest,
  sendInvoiceReminderRest,
} from "./paypal-rest";

// --- Class map (§5.1). SENSITIVE is anchored in guardrail.SENSITIVE_TOOLS;
// anything money-moving or legally final is listed here explicitly too.
export const TOOL_CLASSES: Record<string, ToolClass> = {
  // SENSITIVE — money leaves the account or a legal position is finalised
  create_refund: "SENSITIVE",
  accept_dispute_claim: "SENSITIVE",
  provide_evidence: "SENSITIVE",
  pay_order: "SENSITIVE",
  // SENSITIVE since Phase 3B — no money moves, but a reminder is outbound
  // communication to a customer in the merchant's name; the exact text
  // rides inside the approved args, so nothing unapproved can be sent.
  send_invoice_reminder: "SENSITIVE",
  // WRITE — changes state, reversible, no money out
  create_invoice: "WRITE",
  send_invoice: "WRITE",
  cancel_sent_invoice: "WRITE",
  create_order: "WRITE",
  create_shipment_tracking: "WRITE",
  create_product: "WRITE",
  record_payment_for_invoice: "WRITE",
  record_refund_for_invoice: "WRITE",
  generate_invoice_number: "WRITE",
  generate_invoice_qr_code: "WRITE",
  update_invoicing: "WRITE",
  delete_invoice: "WRITE",
  create_conditional_rules_for_invoice: "WRITE",
  setup_invoice_auto_reminders: "WRITE",
  cancel_invoice_auto_reminder: "WRITE",
  update_invoice_auto_reminder: "WRITE",
  // READ — everything else (list_*, get_*, search_*, show_*, insights)
};

export function classOfTool(name: string): ToolClass {
  return TOOL_CLASSES[name] ?? "READ";
}

// Reminder pacing is a PayPal rule (max 2/day/invoice): dedupe window = 1 day.
const IDEMPOTENCY_WINDOWS: Record<string, number> = {
  send_invoice_reminder: 24 * 3600,
};

const evidenceSchema = z.object({
  dispute_id: z.string().min(1),
  evidences: z
    .array(
      z.object({
        evidence_type: z.enum(["PROOF_OF_FULFILLMENT", "PROOF_OF_REFUND", "OTHER"]),
        evidence_info: z
          .object({
            tracking_info: z
              .array(
                z.object({
                  carrier_name: z.string().min(1),
                  tracking_number: z.string().min(1),
                })
              )
              .optional(),
            refund_ids: z.array(z.string()).optional(),
          })
          .optional(),
        notes: z.string().optional(),
      })
    )
    .min(1),
});

export function evidenceMatches(existing: any, wanted: EvidenceInput): boolean {
  if (!existing || existing.evidence_type !== wanted.evidence_type) return false;
  const wantedTracking = wanted.evidence_info?.tracking_info?.[0]?.tracking_number;
  if (!wantedTracking) return true;
  const existingTracking: any[] = existing.evidence_info?.tracking_info ?? [];
  return existingTracking.some((t) => t?.tracking_number === wantedTracking);
}

/**
 * provide_evidence handler. Business-level idempotency: if the exact
 * evidence is already on file at PayPal (e.g. the POC submission), the call
 * is satisfied without re-posting — verified against the real dispute.
 */
async function provideEvidenceHandler(args: {
  dispute_id: string;
  evidences: EvidenceInput[];
}) {
  const dispute: any = await getDispute(args.dispute_id);
  const onFile: any[] = Array.isArray(dispute?.evidences) ? dispute.evidences : [];
  const missing = args.evidences.filter(
    (ev) => !onFile.some((e) => evidenceMatches(e, ev))
  );
  if (missing.length === 0) {
    return {
      status: "already_submitted",
      dispute_id: args.dispute_id,
      note: "Evidence already on file at PayPal (verified via get_dispute); not re-submitted.",
    };
  }
  const response = await provideEvidence(args.dispute_id, missing);
  return { status: "submitted", dispute_id: args.dispute_id, response };
}

async function provideEvidenceReadBack(args: { dispute_id: string }) {
  return getDispute(args.dispute_id);
}

function provideEvidenceExpect(
  readBack: any,
  args: { dispute_id: string; evidences: EvidenceInput[] }
): boolean {
  const onFile: any[] = Array.isArray(readBack?.evidences) ? readBack.evidences : [];
  return args.evidences.every((ev) => onFile.some((e) => evidenceMatches(e, ev)));
}

const coreRegisteredFor = new WeakSet<GuardianExecutor>();

const disputeIdSchema = z.object({ dispute_id: z.string().min(1) });

/** Register the custom REST tool(s) on an executor (idempotent per executor). */
export function registerCoreTools(executor: GuardianExecutor = getExecutor()): void {
  if (coreRegisteredFor.has(executor)) return;
  coreRegisteredFor.add(executor);
  // get_dispute (READ) — the watchers' read path (deadline radar, reconcile
  // sweep, §6). The toolkit exposes the same call inside the agent loop;
  // this registration gives non-agent callers the executor path: ledgered,
  // validated, never a side door.
  executor.register({
    name: "get_dispute",
    class: "READ",
    schema: disputeIdSchema,
    entityOf: (args) => String(args.dispute_id),
    handler: async (args) => getDispute(args.dispute_id),
  });
  executor.register({
    name: "provide_evidence",
    class: "SENSITIVE",
    schema: evidenceSchema,
    entityOf: (args) => String(args.dispute_id),
    handler: provideEvidenceHandler,
    readBack: provideEvidenceReadBack,
    expect: provideEvidenceExpect,
  });
  // Phase 2B — REST list readers for the Analyst worker / digest. These
  // give non-agent callers the same executor path (validation, ledger)
  // for list_invoices / list_disputes / list_transactions. Inside the
  // agent loop the toolkit's own tools keep precedence: wrapTools passes
  // its per-call handler, which the executor prefers over spec.handler.
  executor.register({
    name: "list_invoices",
    class: "READ",
    entityOf: () => "account",
    handler: async () => listInvoicesRest(),
  });
  executor.register({
    name: "list_disputes",
    class: "READ",
    entityOf: () => "account",
    handler: async () => listDisputesRest(),
  });
  executor.register({
    name: "list_transactions",
    class: "READ",
    schema: z.object({
      start_date: z.string().min(1),
      end_date: z.string().min(1),
    }),
    entityOf: () => "account",
    handler: async (args) => listTransactionsRest(args),
  });
  // Phase 3B — invoice read-back pair + the Collections reminder tool.
  executor.register({
    name: "get_invoice",
    class: "READ",
    schema: z.object({ invoice_id: z.string().min(1) }),
    entityOf: (args) => String(args.invoice_id),
    handler: async (args) => getInvoiceRest(args.invoice_id),
  });
  executor.register({
    name: "send_invoice_reminder",
    class: "SENSITIVE",
    schema: z.object({
      invoice_id: z.string().min(1),
      subject: z.string().min(1).optional(),
      note: z.string().optional(),
      send_to_invoicer: z.boolean().optional(),
    }),
    entityOf: (args) => String(args.invoice_id),
    // PayPal caps reminders at 2/day/invoice; a 24h dedupe window keeps
    // Guardian at one approved send per invoice per day at most.
    idempotencyWindowSec: IDEMPOTENCY_WINDOWS.send_invoice_reminder,
    handler: async (args) => sendInvoiceReminderRest(args),
    readBack: async (args) => getInvoiceRest(args.invoice_id),
    // A reminder leaves no dedicated marker on the invoice record, so the
    // read-back is existence-level (same standard as the toolkit pairs in
    // READBACK_FOR): the invoice is still there, in a readable state.
    expect: (rb: any) => !!rb && typeof rb.status === "string",
  });
}

// Getters used to read back toolkit writes where a natural pair exists.
const READBACK_FOR: Record<string, { tool: string; argsOf: (args: any, data: any) => any }> = {
  send_invoice: { tool: "get_invoice", argsOf: (args) => ({ invoice_id: args.invoice_id }) },
  cancel_sent_invoice: { tool: "get_invoice", argsOf: (args) => ({ invoice_id: args.invoice_id }) },
  send_invoice_reminder: { tool: "get_invoice", argsOf: (args) => ({ invoice_id: args.invoice_id }) },
  create_invoice: {
    tool: "get_invoice",
    argsOf: (_args, data) => {
      const id =
        (typeof data === "object" && data && (data.id ?? data.invoice_id)) ||
        (typeof data === "string" ? (data.match(/INV2-[A-Z0-9-]+/) ?? [])[0] : undefined);
      return id ? { invoice_id: id } : null;
    },
  },
};

/**
 * Wrap an AI SDK ToolSet so every tool execute() passes the executor:
 * validation → SENSITIVE approval gate → idempotency → ledger → read-back.
 * A blocked SENSITIVE call does not throw into the model loop; it returns a
 * structured result telling the model an approval card was created.
 */
export function wrapToolsWithExecutor<T extends Record<string, any>>(
  tools: T,
  opts?: { actor?: string; executor?: GuardianExecutor }
): T {
  const executor = opts?.executor ?? getExecutor();
  const actor = opts?.actor ?? "coordinator";
  const wrapped: Record<string, any> = {};

  for (const [name, tool] of Object.entries(tools)) {
    if (!tool || typeof tool.execute !== "function") {
      wrapped[name] = tool;
      continue;
    }
    const original = tool.execute.bind(tool);
    if (!executor.has(name)) {
      const rb = READBACK_FOR[name];
      executor.register({
        name,
        class: classOfTool(name),
        entityOf: defaultEntityOf,
        idempotencyWindowSec: IDEMPOTENCY_WINDOWS[name],
        readBack: rb
          ? async (args, data) => {
              const getter = tools[rb.tool];
              if (!getter?.execute) return undefined;
              const rbArgs = rb.argsOf(args, data);
              if (!rbArgs) return undefined;
              return getter.execute(rbArgs, {});
            }
          : undefined,
        // Existence-level check for toolkit pairs: the getter returned the
        // entity. Strict content expectations live on provide_evidence.
        expect: rb ? (readBack) => readBack !== undefined && readBack !== null : undefined,
      });
    }
    wrapped[name] = {
      ...tool,
      execute: async (args: any, ctx: any) => {
        try {
          const result = await executor.execute(name, args, {
            actor,
            handler: (a: any) => original(a, ctx),
          });
          return result.data;
        } catch (e) {
          if (e instanceof ExecutorError) {
            if (e.code === "APPROVAL_REQUIRED") {
              return {
                approval_required: true,
                approval_id: e.approvalId,
                message:
                  "This action is sensitive. I created an approval request for the merchant; it will only run after they approve it.",
              };
            }
            return { error: e.code, message: e.message };
          }
          throw e;
        }
      },
    };
  }
  return wrapped as T;
}
