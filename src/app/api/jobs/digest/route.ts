import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { checkJobSecret } from "@/lib/jobs/shared";
import { runDigest } from "@/lib/jobs/digest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/jobs/digest — build today's morning digest (PHASES 2.3).
// Guarded by x-job-secret vs GUARDIAN_JOB_SECRET; without the env var the
// endpoint refuses to run at all. Idempotent per merchant-local day.
export async function POST(req: NextRequest) {
  const auth = checkJobSecret(req.headers.get("x-job-secret"));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  try {
    const report = await runDigest(getStore());
    return NextResponse.json({ ok: true, report });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
