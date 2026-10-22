import { NextRequest, NextResponse } from "next/server";
import { runGuardian } from "@/lib/agent";
import { getStore, DEFAULT_MERCHANT_ID } from "@/lib/db";
import {
  createApproval,
  surfaceApproval,
  findPendingByHash,
} from "@/lib/approvals";

export const runtime = "nodejs";

// POST /api/chat { message: string } -> { text, steps, approval? }
// V1: single-turn per request; conversation state lives in the client.
//
// When the agent surfaces a sensitive action (demo mode: provide_evidence
// for the POC dispute), it is persisted here as a durable approval
// (PROPOSED -> PENDING, spec §5.5) and the response carries its id, so the
// UI card decides against the store — not against client state. If the
// store is unavailable the card falls back to the previous client-only
// behaviour instead of breaking the demo.
export async function POST(req: NextRequest) {
  try {
    const { message } = (await req.json()) as { message?: string };
    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }
    const result: any = await runGuardian(message);

    if (result?.approval?.kind === "provide_evidence") {
      try {
        const a = result.approval;
        const args = {
          dispute_id: a.caseId,
          evidences: [
            {
              evidence_type: a.evidenceType,
              evidence_info: {
                tracking_info: [
                  { carrier_name: a.carrier, tracking_number: a.tracking },
                ],
              },
            },
          ],
        };
        const store = getStore();
        const existing = findPendingByHash(
          store,
          DEFAULT_MERCHANT_ID,
          "provide_evidence",
          args
        );
        let approvalId: string;
        if (existing) {
          approvalId = existing.id;
        } else {
          const amount = Number.parseFloat(
            String(a.amount).replace(/[^0-9.]/g, "")
          );
          const created = createApproval(store, {
            merchantId: DEFAULT_MERCHANT_ID,
            tool: "provide_evidence",
            args,
            reason: `Submit ${a.evidenceType} evidence for dispute ${a.caseId}`,
            amountUsd: Number.isFinite(amount) ? amount : null,
            createdBy: "coordinator",
          });
          surfaceApproval(store, created.id);
          approvalId = created.id;
        }
        result.approval = { ...a, id: approvalId, status: "pending" };
      } catch {
        // Store unavailable (e.g. read-only FS): keep the client-only card.
      }
    }
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    // Most common first-run failure: missing sandbox credentials in .env.local.
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
