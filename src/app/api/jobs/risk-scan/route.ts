import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { checkJobSecret } from "@/lib/jobs/shared";
import { runRiskScan } from "@/lib/jobs/risk-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/jobs/risk-scan — grade the account-risk signals (dispute
// rate, case deadlines, money at risk, holds) against policy thresholds
// (PHASES 4B, §6). Guarded by x-job-secret vs GUARDIAN_JOB_SECRET;
// without the env var the endpoint refuses to run. A HIGH level raises
// one instant alert per merchant-local day; unmeasurable signals are
// reported in signals_missing, never guessed.
export async function POST(req: NextRequest) {
  const auth = checkJobSecret(req.headers.get("x-job-secret"));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  try {
    const report = await runRiskScan(getStore());
    return NextResponse.json({ ok: true, report });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
