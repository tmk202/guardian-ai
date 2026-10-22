import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { checkJobSecret } from "@/lib/jobs/shared";
import { runScanInbound } from "@/lib/jobs/scan-inbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/jobs/scan-inbound — ScamShield scan of invoices addressed TO
// the merchant (PHASES 4C, §6). Guarded by x-job-secret vs
// GUARDIAN_JOB_SECRET; without the env var the endpoint refuses to run.
// A likely_scam verdict raises one instant alert per invoice. When the
// account's invoice list holds no inbound invoices the report says so —
// an empty inbound set is a finding, not an error.
export async function POST(req: NextRequest) {
  const auth = checkJobSecret(req.headers.get("x-job-secret"));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  try {
    const report = await runScanInbound(getStore());
    return NextResponse.json({ ok: true, report });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
