import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { checkJobSecret } from "@/lib/jobs/shared";
import { runCollectionsScan } from "@/lib/jobs/collections-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/jobs/collections-scan — scan unpaid invoices and propose
// reminder approvals on the §3.3 ladder (PHASES 3B, §6 overdue scan).
// Guarded by x-job-secret vs GUARDIAN_JOB_SECRET; without the env var
// the endpoint refuses to run. The scan only PROPOSES — a reminder is
// sent solely after the merchant approves it.
export async function POST(req: NextRequest) {
  const auth = checkJobSecret(req.headers.get("x-job-secret"));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  try {
    const report = await runCollectionsScan(getStore());
    return NextResponse.json({ ok: true, report });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
