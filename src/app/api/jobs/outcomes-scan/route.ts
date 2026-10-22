import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { checkJobSecret } from "@/lib/jobs/shared";
import { runOutcomesScan } from "@/lib/jobs/outcomes-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/jobs/outcomes-scan — Memory Keeper's learning pass (PHASES
// 5.2, §3.6): read back every tracked dispute; for each one PayPal
// reports RESOLVED, record a memory-E outcome (reason, evidence combo,
// result, days open) that feeds the playbook stats. Guarded by
// x-job-secret vs GUARDIAN_JOB_SECRET; without the env var the endpoint
// refuses to run. Open cases are recorded as still open — never guessed.
export async function POST(req: NextRequest) {
  const auth = checkJobSecret(req.headers.get("x-job-secret"));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  try {
    const report = await runOutcomesScan(getStore());
    return NextResponse.json({ ok: true, report });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
