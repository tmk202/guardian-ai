// Executor — the single path every PayPal call goes through
// (ARCHITECTURE-DETAIL.md §4.3). Phase 1A.
//
// execute(tool, args, actor):
//   1. validate args against the tool's schema (invalid → error, no PayPal call)
//   2. SENSITIVE tools require a valid approval whose args_hash matches the
//      exact tool+args (spec §5.5); a missing/mismatched approval is blocked
//      AND the block itself is written to the ledger
//   3. idempotency: a WRITE/SENSITIVE call whose key already succeeded inside
//      its window returns the cached result — PayPal never sees a duplicate
//   4. call the handler exactly once (writes are NEVER auto-retried)
//   5. write the ledger row (args redacted)
//   6. WRITE/SENSITIVE with a read-back: verify the real state afterwards;
//      a mismatch flags the ledger row RECONCILE_NEEDED instead of re-running
import { createHash } from "node:crypto";
import {
  getStore,
  DEFAULT_MERCHANT_ID,
  type GuardianStore,
  type ApprovalRow,
} from "./db";
import { getPolicy, type GuardianPolicy } from "./policy";
import { isSensitive } from "./guardrail";
import { canonicalJson, hashToolArgs } from "./hash";
import { createApproval, surfaceApproval, markExecuted } from "./approvals";

export type ToolClass = "READ" | "WRITE" | "SENSITIVE";
export type ToolHandler = (args: any) => Promise<any>;

export interface ToolSpec {
  name: string;
  class: ToolClass;
  /** zod-compatible schema (anything with .parse). Validation only. */
  schema?: { parse: (args: unknown) => unknown };
  entityOf?: (args: any) => string;
  amountOf?: (args: any) => number | null;
  /** seconds; calls with the same key inside the window are deduplicated */
  idempotencyWindowSec?: number;
  handler?: ToolHandler;
  readBack?: (args: any, data: any) => Promise<unknown>;
  expect?: (readBack: unknown, args: any, data: any) => boolean;
}

export interface ExecuteOptions {
  actor: string;
  approvalId?: string;
  merchantId?: string;
  /** per-call handler (e.g. an AI SDK tool's own execute) */
  handler?: ToolHandler;
}

export interface ExecuteResult<T = any> {
  data: T;
  ledgerId: number;
  duplicate: boolean;
  reconcileNeeded: boolean;
  approvalId?: string;
}

export class ExecutorError extends Error {
  code: string;
  approvalId?: string;
  constructor(code: string, message: string, approvalId?: string) {
    super(message);
    this.name = "ExecutorError";
    this.code = code;
    this.approvalId = approvalId;
  }
}

const SECRET_KEY = /secret|password|passwd|token|authorization|credential/i;

/** Deep-redact anything that looks like a credential before it hits the ledger. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[…]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? "***" : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 500) return value.slice(0, 500) + "…";
  return value;
}

export function defaultEntityOf(args: any): string {
  if (!args || typeof args !== "object") return "account";
  return String(
    args.invoice_id ??
      args.dispute_id ??
      args.order_id ??
      args.transaction_id ??
      args.id ??
      "account"
  );
}

const DEFAULT_WRITE_WINDOW_SEC = 3600;

export class GuardianExecutor {
  private specs = new Map<string, ToolSpec>();
  private store: GuardianStore;
  private policy: GuardianPolicy;

  constructor(deps?: { store?: GuardianStore; policy?: GuardianPolicy }) {
    this.store = deps?.store ?? getStore();
    this.policy = deps?.policy ?? getPolicy();
  }

  register(spec: ToolSpec): void {
    this.specs.set(spec.name, spec);
  }

  has(name: string): boolean {
    return this.specs.has(name);
  }

  classOf(name: string): ToolClass {
    return this.specs.get(name)?.class ?? (isSensitive(name) ? "SENSITIVE" : "READ");
  }

  private ledgerBlocked(
    merchantId: string,
    actor: string,
    tool: string,
    args: unknown,
    code: string,
    extra?: Record<string, unknown>
  ): number {
    return this.store.ledger.append({
      merchant_id: merchantId,
      actor,
      kind: "tool_call",
      tool,
      args_redacted_json: JSON.stringify(redact(args)),
      result_json: JSON.stringify({ ok: false, blocked: code, ...extra }),
    });
  }

  /**
   * Approval validation for SENSITIVE execution (spec §5.5). Throws
   * ExecutorError with a stable code on any problem; returns the approval
   * row when execution may proceed.
   */
  checkApproval(
    approvalId: string,
    tool: string,
    args: unknown,
    merchantId: string
  ): ApprovalRow {
    const approval = this.store.approvals.get(approvalId);
    if (!approval) {
      throw new ExecutorError("APPROVAL_NOT_FOUND", `Approval ${approvalId} not found`, approvalId);
    }
    if (approval.merchant_id !== merchantId) {
      throw new ExecutorError("APPROVAL_MISMATCH", "Approval belongs to another merchant", approvalId);
    }
    // Hash binding first: an approval simply does not cover a call whose
    // tool+args differ from what was approved, whatever its status.
    if (approval.tool !== tool || approval.args_hash !== hashToolArgs(tool, args)) {
      throw new ExecutorError(
        "APPROVAL_MISMATCH",
        "Approval does not match this tool + args (args changed after approval)",
        approvalId
      );
    }
    if (approval.status === "EXECUTED") {
      throw new ExecutorError("APPROVAL_ALREADY_EXECUTED", "This approval was already executed", approvalId);
    }
    if (approval.status !== "APPROVED") {
      throw new ExecutorError(
        "APPROVAL_NOT_APPROVED",
        `Approval is ${approval.status}, not APPROVED`,
        approvalId
      );
    }
    return approval;
  }

  async execute<T = any>(
    tool: string,
    args: any,
    opts: ExecuteOptions
  ): Promise<ExecuteResult<T>> {
    const merchantId = opts.merchantId ?? DEFAULT_MERCHANT_ID;
    const actor = opts.actor;
    const spec = this.specs.get(tool);
    const toolClass: ToolClass = spec?.class ?? this.classOf(tool);
    const handler = opts.handler ?? spec?.handler;

    // 1 — validate (no PayPal call, no silent guessing)
    if (spec?.schema) {
      try {
        spec.schema.parse(args);
      } catch (e) {
        this.ledgerBlocked(merchantId, actor, tool, args, "INVALID_ARGS", {
          error: e instanceof Error ? e.message.slice(0, 300) : String(e),
        });
        throw new ExecutorError("INVALID_ARGS", `Invalid args for ${tool}`);
      }
    }

    // 2 — SENSITIVE gate
    let approval: ApprovalRow | undefined;
    if (toolClass === "SENSITIVE") {
      const amount = spec?.amountOf?.(args) ?? null;
      const autoBelow = this.policy.approvals.auto_below_usd;
      const autoApprovable =
        autoBelow > 0 && amount !== null && amount <= autoBelow;
      if (!opts.approvalId && !autoApprovable) {
        // No approval: freeze the action as a PENDING approval (spec §1.4)
        // and block. The block is ledgered.
        const created = createApproval(this.store, {
          merchantId,
          tool,
          args,
          reason: `Sensitive action ${tool} requested by ${actor}`,
          amountUsd: amount,
          createdBy: actor,
        });
        surfaceApproval(this.store, created.id);
        this.ledgerBlocked(merchantId, actor, tool, args, "APPROVAL_REQUIRED", {
          approval_id: created.id,
        });
        throw new ExecutorError(
          "APPROVAL_REQUIRED",
          `${tool} is sensitive and needs human approval first`,
          created.id
        );
      }
      if (opts.approvalId) {
        try {
          approval = this.checkApproval(opts.approvalId, tool, args, merchantId);
        } catch (e) {
          if (e instanceof ExecutorError) {
            this.ledgerBlocked(merchantId, actor, tool, args, e.code, {
              approval_id: opts.approvalId,
            });
          }
          throw e;
        }
      }
      // autoApprovable path: proceeds without a human approval (policy §5.3);
      // the execution ledger row records that it ran under the threshold.
    }

    // 3 — idempotency (writes only)
    let idemKey: string | null = null;
    if (toolClass === "WRITE" || toolClass === "SENSITIVE") {
      const windowSec = spec?.idempotencyWindowSec ?? DEFAULT_WRITE_WINDOW_SEC;
      const entity = spec?.entityOf ? spec.entityOf(args) : defaultEntityOf(args);
      const bucket = Math.floor(Date.now() / (windowSec * 1000));
      idemKey = createHash("sha256")
        .update(canonicalJson({ merchantId, tool, entity, args, bucket }))
        .digest("hex");
      const prior = this.store.ledger.findSuccessByIdempotencyKey(idemKey);
      if (prior) {
        if (approval) markExecuted(this.store, approval.id, prior.id);
        const priorResult = JSON.parse(prior.result_json ?? "{}");
        this.store.ledger.append({
          merchant_id: merchantId,
          actor,
          kind: "system",
          tool,
          result_json: JSON.stringify({
            ok: true,
            duplicate_suppressed: true,
            original_ledger_id: prior.id,
          }),
        });
        return {
          data: priorResult.data as T,
          ledgerId: prior.id,
          duplicate: true,
          reconcileNeeded: prior.reconcile_flag === 1,
          approvalId: approval?.id,
        };
      }
    }

    if (!handler) {
      throw new ExecutorError("NO_HANDLER", `No handler registered for ${tool}`);
    }

    // 4 — call PayPal exactly once; a failed write is never retried blind
    let data: T;
    try {
      data = (await handler(args)) as T;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.store.ledger.append({
        merchant_id: merchantId,
        actor,
        kind: "tool_call",
        tool,
        args_redacted_json: JSON.stringify(redact(args)),
        result_json: JSON.stringify({ ok: false, error: msg.slice(0, 1000) }),
        idempotency_key: idemKey,
      });
      throw new ExecutorError("TOOL_FAILED", `${tool} failed: ${msg.slice(0, 300)}`);
    }

    // 5+6 — read-back for writes, then the ledger row (written once, final)
    let reconcileNeeded = false;
    let readBackSummary: unknown;
    if ((toolClass === "WRITE" || toolClass === "SENSITIVE") && spec?.readBack) {
      try {
        const rb = await spec.readBack(args, data);
        readBackSummary = redact(rb);
        if (spec.expect && !spec.expect(rb, args, data)) reconcileNeeded = true;
      } catch {
        reconcileNeeded = true; // cannot verify → flag, never re-run the write
      }
    }

    const ledgerId = this.store.ledger.append({
      merchant_id: merchantId,
      actor,
      kind: "tool_call",
      tool,
      args_redacted_json: JSON.stringify(redact(args)),
      result_json: JSON.stringify({
        ok: true,
        data: redact(data),
        ...(readBackSummary !== undefined ? { read_back: readBackSummary } : {}),
        ...(approval ? { approval_id: approval.id } : {}),
      }),
      idempotency_key: idemKey,
      reconcile_flag: reconcileNeeded,
    });

    // Approval consumed: APPROVED → EXECUTED (spec §5.5)
    if (approval) {
      markExecuted(this.store, approval.id, ledgerId);
    }

    return { data, ledgerId, duplicate: false, reconcileNeeded, approvalId: approval?.id };
  }
}

let singleton: GuardianExecutor | null = null;
export function getExecutor(): GuardianExecutor {
  if (!singleton) singleton = new GuardianExecutor();
  return singleton;
}
