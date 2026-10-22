import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { checkJobSecret } from "@/lib/jobs/shared";
import { runReconcileSweep } from "@/lib/jobs/reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/jobs/reconcile — run the RECONCILE_NEEDED sweep (§6, Phase 1A.4).
// Same job-secret guard as the deadline radar.
export async function POST(req: NextRequest) {
  const auth = checkJobSecret(req.headers.get("x-job-secret"));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  try {
    const report = await runReconcileSweep(getStore());
    return NextResponse.json({ ok: true, report });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
