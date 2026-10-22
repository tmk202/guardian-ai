import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import {
  handleWebhook,
  type WebhookHeaders,
} from "@/lib/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/webhooks/paypal — PayPal webhook intake (Phase 1D, §6).
// Thin adapter: all logic (verify → inbox dedupe → triage → alerts) lives
// in lib/webhooks.handleWebhook so it is testable without Next.js.
// The verification mode is always disclosed in a response header: in
// unverified-dev mode (no PAYPAL_WEBHOOK_ID yet) nothing pretends the
// signature was checked.
export async function POST(req: NextRequest) {
  const raw = await req.text();
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const headers: WebhookHeaders = {
    authAlgo: req.headers.get("paypal-auth-algo"),
    certUrl: req.headers.get("paypal-cert-url"),
    transmissionId: req.headers.get("paypal-transmission-id"),
    transmissionSig: req.headers.get("paypal-transmission-sig"),
    transmissionTime: req.headers.get("paypal-transmission-time"),
  };

  try {
    const result = await handleWebhook(getStore(), { headers, event });
    const res = NextResponse.json(
      {
        ok: result.status === 200,
        duplicate: result.duplicate,
        verification: result.verification,
        ...(result.triage ? { triage: result.triage } : {}),
        ...(result.error ? { error: result.error } : {}),
      },
      { status: result.status }
    );
    res.headers.set(
      "x-guardian-webhook-verification",
      result.verification === "paypal"
        ? "verified"
        : result.verification === "failed"
          ? "failed"
          : "unverified-dev"
    );
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
