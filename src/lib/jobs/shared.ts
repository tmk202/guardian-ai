// Shared guard for the job HTTP endpoints (Phase 1D).
//
// Job routes run watchers with real side effects (alerts, case updates),
// so they require the `x-job-secret` header to match GUARDIAN_JOB_SECRET.
// If the env var is not configured the endpoint REFUSES to run (503) —
// a watcher must never be triggerable by accident (§6: silent/unsafe job
// behaviour is a failure mode, not a default).
import { timingSafeEqual } from "node:crypto";

export type JobSecretCheck =
  | { ok: true }
  | { ok: false; status: number; error: string };

export function checkJobSecret(headerValue: string | null): JobSecretCheck {
  const secret = process.env.GUARDIAN_JOB_SECRET;
  if (!secret) {
    return {
      ok: false,
      status: 503,
      error: "GUARDIAN_JOB_SECRET is not configured; job endpoints refuse to run",
    };
  }
  if (!headerValue) {
    return { ok: false, status: 401, error: "missing x-job-secret header" };
  }
  const a = Buffer.from(headerValue);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: "invalid job secret" };
  }
  return { ok: true };
}
