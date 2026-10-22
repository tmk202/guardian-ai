import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { checkJobSecret } from "@/lib/jobs/shared";
import { runHoldRadar } from "@/lib/jobs/hold-radar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/jobs/hold-radar — scan transactions for held payments
// (PHASES 3A, §6 hold scan). Guarded by x-job-secret vs
// GUARDIAN_JOB_SECRET; without the env var the endpoint refuses to run.
// When Transaction Search is unavailable the report says so (status
// "unavailable" + reason) instead of inventing held figures.
export async function POST(req: NextRequest) {
  const auth = checkJobSecret(req.headers.get("x-job-secret"));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  try {
    const report = await runHoldRadar(getStore());
    return NextResponse.json({ ok: true, report });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
