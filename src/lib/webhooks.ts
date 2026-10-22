// Webhook intake (ARCHITECTURE-DETAIL.md §6 row 1 + §7) — Phase 1D.
//
// Flow: verify signature → write the event into events_inbox (dedupe by
// event_id) → answer 200 → triage (processEvent). The route handler is a
// thin adapter over handleWebhook so the whole gate is testable without
// Next.js: tests inject a stub verifier and call handleWebhook directly.
//
// Verification modes:
//  - "paypal": PAYPAL_WEBHOOK_ID is configured → every event is checked
//    against PayPal's /v1/notifications/verify-webhook-signature. A failed
//    check rejects the event (401) and the rejection is ledgered.
//  - "unverified-dev": no webhook id configured yet (the endpoint code is
//    not deployed/registered). Events are still accepted so the pipeline
//    can be exercised, but NOTHING pretends they were verified: the mode
//    is written into the ledger rows and surfaced by the route in the
//    `x-guardian-webhook-verification` response header.
import { createHash } from "node:crypto";
import {
  getStore,
  DEFAULT_MERCHANT_ID,
  type GuardianStore,
} from "./db";
import { getAccessToken } from "./disputes";
import { recordAlert } from "./alerts";
import {
  triageEvent,
  type PayPalEventLike,
  type TriageResult,
} from "./triage";

export type VerificationMode = "paypal" | "unverified-dev";

export function webhookVerificationMode(
  env: NodeJS.ProcessEnv = process.env
): VerificationMode {
  return env.PAYPAL_WEBHOOK_ID ? "paypal" : "unverified-dev";
}

export interface WebhookHeaders {
  authAlgo?: string | null;
  certUrl?: string | null;
  transmissionId?: string | null;
  transmissionSig?: string | null;
  transmissionTime?: string | null;
}

export type WebhookVerifier = (
  headers: WebhookHeaders,
  event: PayPalEventLike
) => Promise<boolean>;

const VERIFY_URL = "https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature";

/**
 * Real verifier: POST the transmission data + the raw event to PayPal and
 * trust only an explicit verification_status of SUCCESS.
 */
export function createPaypalSignatureVerifier(deps?: {
  webhookId?: string;
  fetchImpl?: typeof fetch;
  getToken?: () => Promise<string>;
}): WebhookVerifier {
  const webhookId = deps?.webhookId ?? process.env.PAYPAL_WEBHOOK_ID;
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const token = deps?.getToken ?? getAccessToken;
  return async (headers, event) => {
    if (!webhookId) return false;
    if (
      !headers.authAlgo ||
      !headers.certUrl ||
      !headers.transmissionId ||
      !headers.transmissionSig ||
      !headers.transmissionTime
    ) {
      return false;
    }
    try {
      const accessToken = await token();
      const res = await fetchImpl(VERIFY_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          auth_algo: headers.authAlgo,
          cert_url: headers.certUrl,
          transmission_id: headers.transmissionId,
          transmission_sig: headers.transmissionSig,
          transmission_time: headers.transmissionTime,
          webhook_id: webhookId,
          webhook_event: event,
        }),
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { verification_status?: string };
      return json.verification_status === "SUCCESS";
    } catch {
      return false; // cannot verify → do not trust the event (§7)
    }
  };
}

export function eventIdOf(event: PayPalEventLike): string {
  const raw = event.id ?? event.event_id;
  if (typeof raw === "string" && raw.trim()) return raw;
  // PayPal events always carry an id; a payload without one gets a content
  // hash so an identical retry still dedupes instead of double-processing.
  const hash = createHash("sha256")
    .update(JSON.stringify(event))
    .digest("hex")
    .slice(0, 24);
  return `noid-${hash}`;
}

// ---------------------------------------------------------------------------
// Intake + processing. Split in two so a queue worker can call processEvent
// later without re-doing the HTTP gate; the route calls both inline (the
// inbox write + local triage are the "queue" until real queue infra lands).
// ---------------------------------------------------------------------------

export interface IntakeResult {
  eventId: string;
  duplicate: boolean;
}

export function intakeWebhookEvent(
  store: GuardianStore,
  event: PayPalEventLike
): IntakeResult {
  const eventId = eventIdOf(event);
  const added = store.events.add({
    event_id: eventId,
    type: String(event.event_type ?? "UNKNOWN"),
    payload_json: JSON.stringify(event),
    processed_at: null,
  });
  return { eventId, duplicate: !added };
}

export interface ProcessResult {
  eventId: string;
  duplicate: boolean;
  triage?: TriageResult;
  alertLedgerId?: number;
}

export function processEvent(
  store: GuardianStore,
  event: PayPalEventLike,
  opts?: { merchantId?: string; verification?: VerificationMode; now?: Date }
): ProcessResult {
  const merchantId = opts?.merchantId ?? DEFAULT_MERCHANT_ID;
  const { eventId, duplicate } = intakeWebhookEvent(store, event);
  if (duplicate) return { eventId, duplicate: true }; // §7: processed once

  const triage = triageEvent(event, { now: opts?.now });
  store.ledger.append({
    merchant_id: merchantId,
    actor: "triage",
    kind: "job",
    tool: "webhook_triage",
    result_json: JSON.stringify({
      ok: true,
      event_id: eventId,
      event_type: event.event_type ?? null,
      verification: opts?.verification ?? "unknown",
      triage,
    }),
  });

  let alertLedgerId: number | undefined;
  if (triage.urgency === "instant") {
    alertLedgerId = recordAlert(store, {
      merchantId,
      actor: "triage",
      name: triage.kind,
      payload: {
        event_id: eventId,
        event_type: event.event_type ?? null,
        entity_ids: triage.entity_ids,
        one_line: triage.one_line,
      },
    });
  }

  store.events.markProcessed(eventId);
  return { eventId, duplicate: false, triage, alertLedgerId };
}

// ---------------------------------------------------------------------------
// The full gate the route adapts: verify → (reject + ledger) | process.
// ---------------------------------------------------------------------------

export interface HandleWebhookDeps {
  verifier?: WebhookVerifier;
  mode?: VerificationMode;
  merchantId?: string;
  now?: Date;
}

export interface HandleWebhookResult {
  status: number;
  verification: VerificationMode | "failed";
  duplicate: boolean;
  eventId?: string;
  triage?: TriageResult;
  error?: string;
}

export async function handleWebhook(
  store: GuardianStore,
  input: { headers: WebhookHeaders; event: PayPalEventLike },
  deps?: HandleWebhookDeps
): Promise<HandleWebhookResult> {
  const merchantId = deps?.merchantId ?? DEFAULT_MERCHANT_ID;
  const mode = deps?.mode ?? webhookVerificationMode();
  const eventId = eventIdOf(input.event);

  if (mode === "paypal") {
    const verifier = deps?.verifier ?? createPaypalSignatureVerifier();
    let ok = false;
    try {
      ok = await verifier(input.headers, input.event);
    } catch {
      ok = false;
    }
    if (!ok) {
      // §6: verify fail → drop the event, and the drop itself is recorded.
      store.ledger.append({
        merchant_id: merchantId,
        actor: "webhook-intake",
        kind: "system",
        tool: "webhook_verify",
        result_json: JSON.stringify({
          ok: false,
          blocked: "SIGNATURE_INVALID",
          event_id: eventId,
          event_type: input.event.event_type ?? null,
        }),
      });
      return {
        status: 401,
        verification: "failed",
        duplicate: false,
        eventId,
        error: "SIGNATURE_INVALID",
      };
    }
  } else {
    // unverified-dev: say so in the ledger, loudly (§ task requirement).
    store.ledger.append({
      merchant_id: merchantId,
      actor: "webhook-intake",
      kind: "system",
      tool: "webhook_intake",
      result_json: JSON.stringify({
        ok: true,
        verification: "unverified-dev",
        note: "PAYPAL_WEBHOOK_ID not configured — event accepted WITHOUT signature verification (dev mode only)",
        event_id: eventId,
        event_type: input.event.event_type ?? null,
      }),
    });
  }

  const processed = processEvent(store, input.event, {
    merchantId,
    verification: mode,
    now: deps?.now,
  });
  return {
    status: 200,
    verification: mode,
    duplicate: processed.duplicate,
    eventId: processed.eventId,
    triage: processed.triage,
  };
}

/** Convenience for the route: the shared store instance. */
export function handleWebhookWithDefaultStore(
  input: { headers: WebhookHeaders; event: PayPalEventLike },
  deps?: HandleWebhookDeps
): Promise<HandleWebhookResult> {
  return handleWebhook(getStore(), input, deps);
}
