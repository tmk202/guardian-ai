import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { decideApproval } from "@/lib/approvals";
import { getExecutor, ExecutorError } from "@/lib/executor";
import { registerCoreTools } from "@/lib/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/approvals/:id/decide { decision: "approved" | "dismissed" }
//
// - dismissed: PENDING -> DISMISSED, ledgered; nothing runs (spec §1.4).
// - approved:  PENDING -> APPROVED, then the frozen tool+args run through the
//   executor exactly as approved (the executor re-verifies the args hash,
//   applies idempotency, read-back, and flips the approval to EXECUTED).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = (await req.json()) as {
      decision?: string;
      decidedBy?: string;
    };
    if (body.decision !== "approved" && body.decision !== "dismissed") {
      return NextResponse.json(
        { error: 'decision must be "approved" or "dismissed"' },
        { status: 400 }
      );
    }
    const store = getStore();
    const decidedBy = body.decidedBy || "merchant-ui";
    const approval = decideApproval(store, id, body.decision, decidedBy);

    if (body.decision === "dismissed") {
      return NextResponse.json({ approval });
    }

    registerCoreTools();
    const args = JSON.parse(approval.args_json);
    try {
      const result = await getExecutor().execute(approval.tool, args, {
        actor: decidedBy,
        approvalId: id,
        merchantId: approval.merchant_id,
      });
      const updated = store.approvals.get(id);
      return NextResponse.json({
        approval: updated,
        execution: {
          ledgerId: result.ledgerId,
          duplicate: result.duplicate,
          reconcileNeeded: result.reconcileNeeded,
          status:
            (result.data as { status?: string } | null)?.status ?? "executed",
        },
      });
    } catch (e) {
      if (e instanceof ExecutorError) {
        return NextResponse.json(
          { error: e.code, message: e.message, approval: store.approvals.get(id) },
          { status: 409 }
        );
      }
      throw e;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    const status = msg.includes("not found") ? 404 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
