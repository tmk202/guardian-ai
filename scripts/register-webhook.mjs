#!/usr/bin/env node
// Register Guardian's webhook on the PayPal sandbox app (Phase 1D.4).
//
// ⚠️ DO NOT RUN YET: the new endpoint code (/api/webhooks/paypal) is not
// deployed to the live demo, so a registered webhook would fire into an
// endpoint that does not exist there yet. Run this only after the Phase 1
// code is deployed, then put the printed id into PAYPAL_WEBHOOK_ID.
//
// Usage:
//   node scripts/register-webhook.mjs https://<your-host>/api/webhooks/paypal
//
// Credentials come from .env.local (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET).
// Prints the webhook id returned by PayPal.
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(path.join(root, ".env.local"));
} catch {
  console.error("Missing .env.local — cannot read sandbox credentials.");
  process.exit(1);
}

const url = process.argv[2];
if (!url || !url.startsWith("https://")) {
  console.error("Usage: node scripts/register-webhook.mjs https://<host>/api/webhooks/paypal");
  process.exit(1);
}

const API = "https://api-m.sandbox.paypal.com";
const EVENT_TYPES = [
  "CUSTOMER.DISPUTE.CREATED",
  "CUSTOMER.DISPUTE.UPDATED",
  "CUSTOMER.DISPUTE.RESOLVED",
  "INVOICING.INVOICE.CREATED",
  "INVOICING.INVOICE.UPDATED",
  "INVOICING.INVOICE.PAID",
  "INVOICING.INVOICE.REFUNDED",
  "INVOICING.INVOICE.CANCELLED",
  "INVOICING.INVOICE.SCHEDULED",
].map((name) => ({ name }));

const id = process.env.PAYPAL_CLIENT_ID;
const secret = process.env.PAYPAL_CLIENT_SECRET;
if (!id || !secret) {
  console.error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing in .env.local");
  process.exit(1);
}

const tokenRes = await fetch(`${API}/v1/oauth2/token`, {
  method: "POST",
  headers: {
    Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: "grant_type=client_credentials",
});
if (!tokenRes.ok) {
  console.error(`Token request failed: ${tokenRes.status}`);
  process.exit(1);
}
const { access_token } = await tokenRes.json();

const res = await fetch(`${API}/v1/notifications/webhooks`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${access_token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ url, event_types: EVENT_TYPES }),
});
const text = await res.text();
if (!res.ok) {
  console.error(`Create webhook failed: ${res.status} ${text}`);
  process.exit(1);
}
const webhook = JSON.parse(text);
console.log(`Webhook created: id=${webhook.id} url=${webhook.url}`);
console.log(`Next step: set PAYPAL_WEBHOOK_ID=${webhook.id} in the deployment env.`);
