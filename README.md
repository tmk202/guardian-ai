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

## What it does (built in phases, all live)

**Core loop (Phase 1)**
- **Approval gate + audit ledger** — every sensitive action (refund, accept a dispute claim, submit evidence, payouts, payment reminders) is proposed first and executes only against a human approval bound to a hash of its exact arguments; every attempt is written to an append-only ledger, and every write is verified by a read-back.
- **Merchant memory** — structured, sourced memory (merchant profile, per-customer records, case files, episodic notes) with confidence caps on inferred facts and supersede-instead-of-delete updates.
- **Signed webhooks** — PayPal webhook intake with signature verification, event deduplication, and rule-based triage (new disputes and suspected scam invoices are flagged instantly).
- **Deadline radar** — a scheduled job that watches open dispute deadlines and raises milestone alerts before a case can be lost by silence.

**Money visibility (Phase 2)**
- **Analyst worker** — money-in / outstanding / at-risk reporting from real PayPal reads. If a figure depends on Transaction Search and that feature is not enabled on the app, it reports `null` plus an explicit note instead of substituting another number.
- **Morning briefing** — a daily digest job (money in yesterday, overdue invoices, cases near deadline, pending approvals) plus a `/briefing` page that renders it.
- **Live brain over API** — the agent loop (coordinator prompt, tool-calling through the executor) is provider-agnostic (OpenAI or Google Gemini via API; no self-hosted models).

**Getting paid & not losing money (Phases 3–4)**
- **Hold Radar** — detects payments PayPal is holding, classifies the likely reason with transparent rules, and labels any release date as an estimate with its basis. No release date is invented for dispute-related holds.
- **Collections worker** — a 3-step reminder ladder (gentle → firm → final) by overdue age. Every reminder is a pending approval carrying the exact text that will be sent; payers with an open dispute are never chased.
- **Risk Warning** — a LOW/WATCH/HIGH account-risk grade from dispute rate, at-risk money and approaching deadlines; signals that cannot be measured are declared missing, not guessed.
- **Appeal Packet** — one command assembles a dispute's case file (summary, timeline, evidence, tracking, linked invoice, ledger history) into a submission-ready document, with missing items explicitly marked `MISSING:`.
- **ScamShield** — scores incoming payment requests/invoices for the classic fake-invoice pattern (phone number or "call to cancel" lure in the note, unknown sender, urgency language, brand impersonation) and tells the merchant not to pay likely scams.

**Learning & books (Phase 5)**
- **Outcome learning** — closed dispute outcomes are recorded per case; evidence-type win rates are computed only from real recorded outcomes (no fabricated benchmarks) and feed the coordinator's context.
- **FX report** — cross-currency receipts grouped by currency with amounts kept in the original currency (never converted at invented rates); the conversion-cost figure appears only when Transaction Search data exists.
- **Reconciliation** — a job that pairs successful PayPal writes in the ledger against the internal books and flags anything unmatched for human review.

**Storage** — one `GuardianStore` interface with two interchangeable backends: SQLite (zero-infra default) and Postgres (selected by `DATABASE_URL`), verified by a shared contract test suite that runs the same behaviour tests against both.

**Tests** — an automated suite of 80+ tests (81 passing, 1 environment-dependent skip at last run) covering the executor/approval gate, memory rules, both store backends, every worker and job, and the live-agent tool loop with a mock model — including proof that a sensitive tool call without approval never executes.

## Architecture (short)

- **Coordinator** — the only component that talks to the user. It plans, delegates, and is the sole holder of the merchant's standing instructions. It never calls a money-moving tool directly.
- **Workers** — deterministic specialists (Analyst, Collections, Hold Radar, Risk Scan, ScamShield, Evidence/Appeal, Outcome Learning). Most are pure functions over store + PayPal reads: same input, same output, fully testable without an LLM.
- **Executor** — the single path to PayPal. It validates arguments, enforces the approval gate for sensitive tools, applies idempotency keys, writes the audit ledger, and read-backs every write (a mismatch becomes `RECONCILE_NEEDED`, never a blind retry).
- **Policy** — a YAML policy file sets the guardrails: what may run automatically (default: nothing above $0), reminder cadence and caps, risk and scam thresholds. Approvals expire in 24 hours and are bound to the exact action they approved.

## Demo mode vs live agent
The hosted demo runs in **demo mode**: with no LLM key configured, the chat walks through the real sandbox runs above with their real IDs, amounts and statuses (clearly labeled in the UI). Set `AI_API_KEY` (OpenAI or Google Gemini; `AI_PROVIDER` picks the provider) plus the PayPal sandbox credentials, and the same UI runs the **live agent**: the model drives the PayPal Agent Toolkit tools itself, with the guardrail approval layer for sensitive actions.

Two honest caveats: reports that depend on **Transaction Search** (total money-in, hold amounts, FX conversion cost) show "unavailable" until that feature is enabled on the PayPal app — Guardian declares missing data rather than estimating it. And on serverless hosting without `DATABASE_URL`, the store is per-instance ephemeral; set a Postgres `DATABASE_URL` for durable memory.

## Setup (sandbox)
1. Create a free PayPal Developer account at https://developer.paypal.com (log in with your PayPal account).
2. Developer Dashboard → **Apps & Credentials** → make sure **Sandbox** is selected → **Create App**.
3. Copy `.env.example` to `.env.local` and fill in the sandbox Client ID / Client Secret. Never commit `.env.local`.
4. `npm install` then `npm run dev`.
5. Optional: set `AI_API_KEY` (+ `AI_PROVIDER=openai|google`) for the live agent, `DATABASE_URL` for the Postgres store, and `GUARDIAN_JOB_SECRET` to enable the scheduled job routes.

## License
Apache-2.0
