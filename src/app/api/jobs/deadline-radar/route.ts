import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { checkJobSecret } from "@/lib/jobs/shared";
import { runDeadlineRadar } from "@/lib/jobs/deadline-radar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/jobs/deadline-radar — run the dispute deadline radar (§6).
// Guarded by x-job-secret vs GUARDIAN_JOB_SECRET; without the env var the
// endpoint refuses to run at all.
export async function POST(req: NextRequest) {
  const auth = checkJobSecret(req.headers.get("x-job-secret"));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  try {
    const report = await runDeadlineRadar(getStore());
    return NextResponse.json({ ok: true, report });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
