import { NextRequest, NextResponse } from "next/server";
import { getStore, DEFAULT_MERCHANT_ID, type ApprovalStatus } from "@/lib/db";
import {
  createApproval,
  surfaceApproval,
  expireStaleApprovals,
} from "@/lib/approvals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/approvals?status=PENDING — list durable approvals for the merchant.
export async function GET(req: NextRequest) {
  try {
    const store = getStore();
    expireStaleApprovals(store, DEFAULT_MERCHANT_ID);
    const status = req.nextUrl.searchParams.get("status") as ApprovalStatus | null;
    const rows = store.approvals.list(
      DEFAULT_MERCHANT_ID,
      status ?? undefined
    );
    return NextResponse.json({
      approvals: rows.map((a) => ({
        ...a,
        args: JSON.parse(a.args_json),
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// POST /api/approvals { tool, args, reason?, amountUsd? } -> create + surface
// a durable approval (PROPOSED -> PENDING). The executor creates these itself
// when a sensitive call is blocked; this endpoint serves UI/agent flows that
// prepare an action explicitly.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      tool?: string;
      args?: unknown;
      reason?: string;
      amountUsd?: number;
    };
    if (!body.tool || body.args === undefined) {
      return NextResponse.json(
        { error: "tool and args are required" },
        { status: 400 }
      );
    }
    const store = getStore();
    const created = createApproval(store, {
      merchantId: DEFAULT_MERCHANT_ID,
      tool: body.tool,
      args: body.args,
      reason: body.reason ?? null,
      amountUsd: body.amountUsd ?? null,
      createdBy: "coordinator",
    });
    const surfaced = surfaceApproval(store, created.id);
    return NextResponse.json(
      { approval: { ...surfaced, args: JSON.parse(surfaced.args_json) } },
      { status: 201 }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
