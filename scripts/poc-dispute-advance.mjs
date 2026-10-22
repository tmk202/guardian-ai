// POC step 2b — advance a simulated dispute through the seller flow:
// try provide-evidence (may be state-blocked) -> sandbox-only require-evidence
// -> provide-evidence again -> sandbox-only adjudicate -> final state.
// Usage: node --env-file=.env.local scripts/poc-dispute-advance.mjs <disputeId>
const API = "https://api-m.sandbox.paypal.com";
const disputeId = process.argv[2];
if (!disputeId) throw new Error("usage: poc-dispute-advance.mjs <disputeId>");
const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
const tokRes = await fetch(`${API}/v1/oauth2/token`, {
  method: "POST",
  headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
  body: "grant_type=client_credentials",
});
const { access_token } = await tokRes.json();
const auth = { Authorization: `Bearer ${access_token}` };
const show = async (label) => {
  const d = await (await fetch(`${API}/v1/customer/disputes/${disputeId}`, { headers: auth })).json();
  console.log(label, "| status:", d.status, "| links:", (d.links || []).map((l) => l.rel).join(","), "| due:", d.seller_response_due_date || "-");
  return d;
};
const provideEvidence = async (label) => {
  const form = new FormData();
  form.append("input", new Blob([JSON.stringify({
    evidences: [{
      evidence_type: "PROOF_OF_FULFILLMENT",
      evidence_info: { tracking_info: [{ carrier_name: "FEDEX", tracking_number: "GUARDIAN-TRACK-001" }] },
      notes: "Order shipped and delivered; tracking GUARDIAN-TRACK-001. Submitted by Guardian AI (sandbox POC).",
    }],
  })], { type: "application/json" }));
  const r = await fetch(`${API}/v1/customer/disputes/${disputeId}/provide-evidence`, { method: "POST", headers: auth, body: form });
  console.log(label, "provide-evidence http:", r.status, r.ok ? "" : (await r.text()).slice(0, 220));
  return r.ok;
};

await show("START");
await provideEvidence("TRY1");
const reqRes = await fetch(`${API}/v1/customer/disputes/${disputeId}/require-evidence`, {
  method: "POST", headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ action: "SELLER_EVIDENCE" }),
});
console.log("REQUIRE-EVIDENCE http:", reqRes.status, reqRes.ok ? "" : (await reqRes.text()).slice(0, 220));
await show("AFTER-REQUIRE");
if (await provideEvidence("TRY2")) await show("AFTER-EVIDENCE");
const adjRes = await fetch(`${API}/v1/customer/disputes/${disputeId}/adjudicate`, {
  method: "POST", headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ adjudication_outcome: "SELLER_FAVOR" }),
});
console.log("ADJUDICATE http:", adjRes.status, adjRes.ok ? "" : (await adjRes.text()).slice(0, 220));
await show("FINAL");
console.log("DONE");
