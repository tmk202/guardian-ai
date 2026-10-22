# Guardian AI

A simple AI employee plugged into your PayPal account — built for the PayPal AI Hackathon 2026.

Talk to it in plain language and it does the PayPal work for you:
1. **Invoices by voice of text** — "Create a $450 invoice for this customer" → it creates and sends it via PayPal, and reminds the customer if they don't pay.
2. **Dispute watch** — when a buyer opens a dispute, it reads the case, gathers the order + shipment evidence, and drafts the response. Nothing is submitted until you approve.
3. **Money report** — "What came in today, who hasn't paid, what's on hold?" → it checks your PayPal transactions and answers.

Safety rule: anything that moves serious money, refunds, or answers a dispute must be approved by you first.

## Status
Skeleton — see `../IMPLEMENTATION.md` for the full plan, the docs it is based on, and the POC steps.

## Setup (sandbox)
1. Create a free PayPal Developer account at https://developer.paypal.com (log in with your PayPal account).
2. Developer Dashboard → **Apps & Credentials** → make sure **Sandbox** is selected → **Create App**.
3. Copy `.env.example` to `.env.local` and fill in the sandbox Client ID / Client Secret. Never commit `.env.local`.
4. `npm install` then `npm run dev`.

## License
Apache-2.0
