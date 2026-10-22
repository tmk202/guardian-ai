import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { checkJobSecret } from "@/lib/jobs/shared";
import { runReconcileReport } from "@/lib/jobs/reconcile-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/jobs/reconcile-report — books check (PHASES 5.4, pain #10):
// every write the executor recorded as successful is read back against
// PayPal's current state and reported matched / mismatched /
// unverifiable; mismatches are flagged RECONCILE_NEEDED for the Phase 1
// sweep. Separate route from /api/jobs/reconcile so the sweep's
// contract is unchanged. Guarded by x-job-secret vs GUARDIAN_JOB_SECRET.
export async function POST(req: NextRequest) {
  const auth = checkJobSecret(req.headers.get("x-job-secret"));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  try {
    const report = await runReconcileReport(getStore());
    return NextResponse.json({ ok: true, report });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
