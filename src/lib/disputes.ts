// Dispute evidence — the gap in the official Agent Toolkit.
//
// The toolkit exposes list_disputes / get_dispute / accept_dispute_claim but has
// NO tool to submit evidence. This module fills the gap with the raw Disputes
// REST API (docs: developer.paypal.com/api/customer-disputes/v1 +
// "Dispute reasons and evidence").
//
// Endpoint: POST /v1/customer/disputes/{id}/provide-evidence
// Content: multipart/form-data — an `input` JSON part describing evidences[],
// plus optional file parts referenced from the evidences' documents.
//
// Evidence types by reason (from the docs):
// - MERCHANDISE_OR_SERVICE_NOT_RECEIVED -> PROOF_OF_FULFILLMENT
//   (evidence_info.tracking_info: { carrier_name, tracking_number })
//   or PROOF_OF_REFUND (evidence_info.refund_ids: string[])
// - NOT_AS_DESCRIBED / DEFECTIVE -> OTHER (notes / documents) or PROOF_OF_REFUND
// Sandbox test scenarios use evidence_type OTHER.

const SANDBOX_API = "https://api-m.sandbox.paypal.com";

export type EvidenceInput = {
  evidence_type: "PROOF_OF_FULFILLMENT" | "PROOF_OF_REFUND" | "OTHER";
  evidence_info?: {
    tracking_info?: { carrier_name: string; tracking_number: string }[];
    refund_ids?: string[];
  };
  notes?: string;
};

export async function getAccessToken(): Promise<string> {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error("Missing PayPal sandbox credentials in env");
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await fetch(`${SANDBOX_API}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal token request failed: ${res.status}`);
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

/**
 * Read one dispute by id (GET /v1/customer/disputes/{id}).
 * Used as the executor read-back for provide_evidence and by the evidence
 * handler to check what is already on file before submitting.
 */
export async function getDispute(disputeId: string, accessToken?: string) {
  const token = accessToken ?? (await getAccessToken());
  const res = await fetch(
    `${SANDBOX_API}/v1/customer/disputes/${encodeURIComponent(disputeId)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`get dispute failed: ${res.status} ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

/**
 * Submit evidence for a dispute. Must pass the approval layer before calling.
 * Returns the raw PayPal response (200 + HATEOAS links on success).
 */
export async function provideEvidence(
  disputeId: string,
  evidences: EvidenceInput[],
  accessToken?: string
) {
  const token = accessToken ?? (await getAccessToken());
  const form = new FormData();
  form.append(
    "input",
    new Blob([JSON.stringify({ evidences })], { type: "application/json" })
  );
  const res = await fetch(
    `${SANDBOX_API}/v1/customer/disputes/${encodeURIComponent(disputeId)}/provide-evidence`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    }
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`provide-evidence failed: ${res.status} ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

// Sandbox-only helpers for the demo/test flow (docs: "Simulate test scenarios").
// POST /v1/customer/disputes/{id}/adjudicate settles a simulated dispute;
// POST /v1/customer/disputes/{id}/require-evidence moves it to evidence-required.
// These endpoints do not exist in production.
