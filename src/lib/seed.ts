// Seed of verified facts (Phase 1C) — everything below comes from real
// PayPal sandbox POC runs on 2026-10-22 (see src/lib/demo.ts and the POC
// scripts): a $450 invoice created+sent, a $120 invoice paid by the buyer,
// and dispute case PP-R-GAW-10194043 where seller evidence was submitted
// after claim escalation and accepted by PayPal (HTTP 200). Nothing here is
// invented; unknown facts (e.g. the case deadline) are stored as null.
//
// The seed is idempotent: it goes through memoryWrite, so re-running it
// finds the identical active facts and creates nothing new.
import { DEFAULT_MERCHANT_ID, type GuardianStore } from "./db";
import { memoryWrite, type MemoryWriteResult } from "./memory";
import { DEMO } from "./demo";

export const POC_MERCHANT_PAYPAL_ID = "PYUCYBFVNBQ6W";
export const POC_DATE = "2026-10-22";

export function pocMerchantProfile(): Record<string, unknown> {
  return {
    merchant_id: POC_MERCHANT_PAYPAL_ID,
    business_name: "Test Store",
    paypal_email: process.env.PAYPAL_SANDBOX_BUSINESS_EMAIL ?? null,
    environment: "SANDBOX",
    timezone: "Asia/Saigon",
    currency: "USD",
    approval_threshold_usd: 0,
    reminder_tone: "polite-firm",
    quiet_hours: "22:00-07:00",
    daily_digest_time: "08:00",
    notes:
      "Sandbox shop behind the Guardian POC runs (invoice + dispute evidence, 2026-10-22).",
  };
}

export function pocCaseMemory(): Record<string, unknown> {
  return {
    case_id: DEMO.dispute.id,
    reason: DEMO.dispute.reason,
    amount_usd: Number(DEMO.dispute.amount),
    currency: DEMO.dispute.currency,
    stage: "CLAIM",
    status: "UNDER_REVIEW",
    // PayPal does not expose a seller deadline we verified in the POC —
    // store null instead of inventing one (§2.4 rule 1/charter rule 1).
    deadline_at: null,
    evidence_submitted: [
      {
        type: "PROOF_OF_FULFILLMENT",
        carrier: DEMO.dispute.carrier,
        tracking: DEMO.dispute.tracking,
        result: "submitted by seller, accepted by PayPal (HTTP 200)",
        at: POC_DATE,
      },
    ],
    related_invoice: DEMO.invoice120.id,
    transaction_id: DEMO.invoice120.transactionId,
    outcome: null,
    lessons: [],
  };
}

export function pocEpisodicNote(): Record<string, unknown> {
  return {
    date: POC_DATE,
    kind: "dispute_evidence_submitted",
    summary:
      `Seller evidence (PROOF_OF_FULFILLMENT, ${DEMO.dispute.carrier} tracking ` +
      `${DEMO.dispute.tracking}) submitted for case ${DEMO.dispute.id} after the ` +
      `buyer escalated to a claim; PayPal accepted it (HTTP 200). Case remains ` +
      `under review.`,
    refs: [DEMO.dispute.id, DEMO.invoice120.id],
  };
}

export interface SeedResult {
  profile: MemoryWriteResult;
  caseMemory: MemoryWriteResult;
  episodic: MemoryWriteResult;
  createdAny: boolean;
}

export function seedGuardianMemory(
  store: GuardianStore,
  merchantId: string = DEFAULT_MERCHANT_ID
): SeedResult {
  const profile = memoryWrite(store, {
    merchantId,
    kind: "A",
    entityKey: POC_MERCHANT_PAYPAL_ID,
    body: pocMerchantProfile(),
    source: "seed:poc-2026-10-22",
    confidence: 1,
  });

  const caseBody = pocCaseMemory();
  const caseMemory = memoryWrite(store, {
    merchantId,
    kind: "C",
    entityKey: DEMO.dispute.id,
    body: caseBody,
    source: "seed:poc-dispute-2026-10-22 (scripts/poc-dispute.mjs)",
    confidence: 1,
  });

  // Keep the cases table in sync — it is the deadline radar's home (§8).
  store.cases.upsert({
    id: DEMO.dispute.id,
    merchant_id: merchantId,
    body_json: JSON.stringify(caseBody),
    deadline_at: null,
    status: "UNDER_REVIEW",
  });

  const episodic = memoryWrite(store, {
    merchantId,
    kind: "D",
    entityKey: DEMO.dispute.id,
    body: pocEpisodicNote(),
    source: "seed:poc-dispute-2026-10-22",
    confidence: 1,
  });

  return {
    profile,
    caseMemory,
    episodic,
    createdAny: profile.created || caseMemory.created || episodic.created,
  };
}
