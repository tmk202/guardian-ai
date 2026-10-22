// POC step 2 — dispute handling at API level (the part the Agent Toolkit lacks):
// list disputes -> show one -> provide evidence (PROOF_OF_FULFILLMENT) -> show again.
// Optional: node --env-file=.env.local scripts/poc-dispute.mjs <disputeId> adjudicate
// Run without args to just list current disputes.
const API = "https://api-m.sandbox.paypal.com";
const id = process.env.PAYPAL_CLIENT_ID;
const secret = process.env.PAYPAL_CLIENT_SECRET;
if (!id || !secret) throw new Error("Missing env values");

const basic = Buffer.from(`${id}:${secret}`).toString("base64");
const tokRes = await fetch(`${API}/v1/oauth2/token`, {
  method: "POST",
  headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
  body: "grant_type=client_credentials",
});
if (!tokRes.ok) throw new Error(`token failed: ${tokRes.status}`);
const { access_token } = await tokRes.json();
const auth = { Authorization: `Bearer ${access_token}` };
console.log("TOKEN OK");

const listRes = await fetch(`${API}/v1/customer/disputes?page_size=10`, { headers: auth });
const list = await listRes.json();
const items = list.items || [];
console.log("DISPUTES total:", list.total_items ?? items.length);
for (const d of items) console.log(" -", d.dispute_id, "| status:", d.status, "| reason:", d.reason, "| amount:", d.amount?.value, d.amount?.currency_code);

const targetId = process.argv[2] || items[0]?.dispute_id;
if (!targetId) { console.log("No dispute to process yet."); process.exit(0); }

const show = async () => {
  const r = await fetch(`${API}/v1/customer/disputes/${targetId}`, { headers: auth });
  return r.json();
};
const before = await show();
console.log("TARGET", targetId, "| status:", before.status, "| outcome:", before.dispute_outcome?.outcome_code || "-");

// Provide evidence as the seller: proof of fulfillment with tracking info.
const form = new FormData();
form.append("input", new Blob([JSON.stringify({
  evidences: [{
    evidence_type: "PROOF_OF_FULFILLMENT",
    evidence_info: { tracking_info: [{ carrier_name: "OTHER", tracking_number: "GUARDIAN-TRACK-001" }] },
    notes: "Order was shipped and delivered. Tracking GUARDIAN-TRACK-001. Submitted by Guardian AI (sandbox POC).",
  }],
})], { type: "application/json" }));
const evRes = await fetch(`${API}/v1/customer/disputes/${targetId}/provide-evidence`, {
  method: "POST", headers: auth, body: form,
});
console.log("PROVIDE-EVIDENCE http:", evRes.status);
if (!evRes.ok) console.log((await evRes.text()).slice(0, 400));

const after = await show();
console.log("AFTER status:", after.status, "| outcome:", after.dispute_outcome?.outcome_code || "-");

if (process.argv[3] === "adjudicate") {
  // Sandbox-only endpoint: settle the simulated dispute (merchant wins scenario).
  const adjRes = await fetch(`${API}/v1/customer/disputes/${targetId}/adjudicate`, {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ outcome: "RESOLVED_SELLER_FAVOUR" }),
  });
  console.log("ADJUDICATE http:", adjRes.status);
  if (!adjRes.ok) console.log((await adjRes.text()).slice(0, 400));
  const final = await show();
  console.log("FINAL status:", final.status, "| outcome:", final.dispute_outcome?.outcome_code || "-");
}
console.log("POC-DISPUTE DONE");
