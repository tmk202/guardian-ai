# Guardian AI

A simple AI employee plugged into your PayPal account — built for the PayPal AI Hackathon 2026.

Talk to it in plain language and it does the PayPal work for you:
1. **Invoices by voice of text** — "Create a $450 invoice for this customer" → it creates and sends it via PayPal, and reminds the customer if they don't pay.
2. **Dispute watch** — when a buyer opens a dispute, it reads the case, gathers the order + shipment evidence, and drafts the response. Nothing is submitted until you approve.
3. **Money report** — "What came in today, who hasn't paid, what's on hold?" → it checks your PayPal transactions and answers.

Safety rule: anything that moves serious money, refunds, or answers a dispute must be approved by you first.

## Status
Working prototype — live demo: https://guardian-ai-ruby.vercel.app

Proven on the real PayPal sandbox (scripts in `scripts/`):
- Invoice INV2-Y236-HYWD-Z2DK-XSYC ($450) created + sent via the Invoicing API.
- A sandbox buyer paid invoice INV2-BYHA-VCDE-7EF2-A9N9 ($120, transaction 16F19418T8805571K).
- Dispute case PP-R-GAW-10194043: seller evidence (PROOF_OF_FULFILLMENT) submitted via our own Disputes REST client and accepted by PayPal (HTTP 200) — the Agent Toolkit doesn't ship evidence submission, so we built it.

## Demo mode vs live agent
The hosted demo runs in **demo mode**: with no LLM key configured, the chat walks through the real sandbox runs above with their real IDs, amounts and statuses (clearly labeled in the UI). Set `AI_API_KEY` (OpenAI or Google Gemini; `AI_PROVIDER` picks the provider) plus the PayPal sandbox credentials, and the same UI runs the **live agent**: the model drives the PayPal Agent Toolkit tools itself, with the guardrail approval layer for sensitive actions.

## Setup (sandbox)
1. Create a free PayPal Developer account at https://developer.paypal.com (log in with your PayPal account).
2. Developer Dashboard → **Apps & Credentials** → make sure **Sandbox** is selected → **Create App**.
3. Copy `.env.example` to `.env.local` and fill in the sandbox Client ID / Client Secret. Never commit `.env.local`.
4. `npm install` then `npm run dev`.

## License
Apache-2.0
