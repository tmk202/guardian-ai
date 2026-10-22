// POC step 2a — create + send an invoice to the sandbox BUYER (personal account).
// This creates the real transaction the buyer can pay and then dispute.
// Run: node --env-file=.env.local scripts/poc-invoice-buyer.mjs
const API = "https://api-m.sandbox.paypal.com";
const id = process.env.PAYPAL_CLIENT_ID;
const secret = process.env.PAYPAL_CLIENT_SECRET;
const buyer = process.env.PAYPAL_SANDBOX_PERSONAL_EMAIL;
const seller = process.env.PAYPAL_SANDBOX_BUSINESS_EMAIL;
if (!id || !secret || !buyer || !seller) throw new Error("Missing env values");

const basic = Buffer.from(`${id}:${secret}`).toString("base64");
const tokRes = await fetch(`${API}/v1/oauth2/token`, {
  method: "POST",
  headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
  body: "grant_type=client_credentials",
});
if (!tokRes.ok) throw new Error(`token failed: ${tokRes.status}`);
const { access_token } = await tokRes.json();
const auth = { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" };
console.log("TOKEN OK");

const createRes = await fetch(`${API}/v2/invoicing/invoices`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({
    detail: { invoice_number: "GUARDIAN-POC-002", currency_code: "USD", note: "Guardian AI POC — buyer-side transaction for dispute test" },
    invoicer: { email_address: seller },
    primary_recipients: [{ billing_info: { email_address: buyer } }],
    items: [{ name: "Wireless earbuds — Bluetooth 5.3", quantity: "1", unit_amount: { currency_code: "USD", value: "120.00" } }],
  }),
});
const created = await createRes.json();
const invoiceId = created.id || (created.href ? created.href.split("/").pop() : undefined);
console.log("CREATE status:", createRes.status, "id:", invoiceId);
if (!createRes.ok || !invoiceId) { console.log(JSON.stringify(created).slice(0, 400)); process.exit(1); }

const sendRes = await fetch(`${API}/v2/invoicing/invoices/${invoiceId}/send`, {
  method: "POST", headers: auth, body: JSON.stringify({ send_to_recipient: true }),
});
console.log("SEND status:", sendRes.status);
const after = await (await fetch(`${API}/v2/invoicing/invoices/${invoiceId}`, { headers: auth })).json();
console.log("INVOICE", invoiceId, "| status:", after.status, "| amount:", after.amount?.value, after.amount?.currency_code, "| to:", buyer);
