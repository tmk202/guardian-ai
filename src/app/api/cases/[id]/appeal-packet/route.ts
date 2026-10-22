import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { buildAppealPacket } from "@/lib/workers/appeal-packet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/cases/:id/appeal-packet — the merchant's appeal packet for one
// dispute (PHASES 4B.3): case summary, timeline, evidence + tracking,
// invoice facts, and an explicit "What's missing" list, assembled from
// Guardian's records + live PayPal read-backs. A read-only route, so it
// follows the approvals read pattern (no job secret). 404 when neither
// Guardian nor PayPal knows the case.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const packet = await buildAppealPacket(getStore(), id);
    return new NextResponse(packet.markdown, {
      status: 200,
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    const status = /not found/.test(msg) ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
