// POC step 1 — prove the sandbox app works end to end at API level:
// get token -> list invoices -> create a DRAFT invoice -> read it back.
// Run: node --env-file=.env.local scripts/poc-invoice.mjs
const API = "https://api-m.sandbox.paypal.com";
const id = process.env.PAYPAL_CLIENT_ID;
const secret = process.env.PAYPAL_CLIENT_SECRET;
const recipient = process.env.PAYPAL_SANDBOX_BUSINESS_EMAIL;
if (!id || !secret || !recipient) throw new Error("Missing env values");

const basic = Buffer.from(`${id}:${secret}`).toString("base64");
const tokRes = await fetch(`${API}/v1/oauth2/token`, {
  method: "POST",
  headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
  body: "grant_type=client_credentials",
});
if (!tokRes.ok) throw new Error(`token failed: ${tokRes.status}`);
const { access_token } = await tokRes.json();
console.log("TOKEN OK");
const auth = { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" };

const listRes = await fetch(`${API}/v2/invoicing/invoices?page_size=5&total_required=true`, { headers: auth });
const list = await listRes.json();
console.log("LIST invoices total_items:", list.total_items ?? 0);

const createRes = await fetch(`${API}/v2/invoicing/invoices`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({
    detail: { invoice_number: "GUARDIAN-POC-001", currency_code: "USD", note: "Guardian AI POC — sandbox smoke test" },
    invoicer: { email_address: recipient },
    primary_recipients: [{ billing_info: { email_address: recipient } }],
    items: [{ name: "Consulting services", quantity: "1", unit_amount: { currency_code: "USD", value: "450.00" } }],
  }),
});
const created = await createRes.json();
// Create returns 201 with only an HATEOAS href; the invoice id is its last segment.
const invoiceId = created.id || (created.href ? created.href.split("/").pop() : undefined);
console.log("CREATE status:", createRes.status, "id:", invoiceId);
if (!createRes.ok || !invoiceId) { console.log(JSON.stringify(created).slice(0, 400)); process.exit(1); }

const getRes = await fetch(`${API}/v2/invoicing/invoices/${invoiceId}`, { headers: auth });
const got = await getRes.json();
console.log("READBACK amount:", got.amount?.value, got.amount?.currency_code, "| status:", got.status);

// Send it: DRAFT -> UNPAID (PayPal emails the sandbox recipient a payment link).
const sendRes = await fetch(`${API}/v2/invoicing/invoices/${invoiceId}/send`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ send_to_recipient: true }),
});
console.log("SEND status:", sendRes.status);
const after = await (await fetch(`${API}/v2/invoicing/invoices/${invoiceId}`, { headers: auth })).json();
console.log("AFTER SEND status:", after.status);
console.log("POC OK — invoice:", invoiceId);
