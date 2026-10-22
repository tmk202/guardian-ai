# Billing — status & connection plan

**Status: NOT CONNECTED.** Guardian charges nobody anything today. No
payment product exists at any provider, no checkout exists in this app,
and no price has been set. This document is the record of that state and
the checklist for the day the project owner connects a rail.

## What exists now (Phase 5D framework)

- `config/plans.yaml` — plan definitions (Free / Pro): merchant limit,
  tracked-case limit, and the feature list each plan unlocks. Prices are
  deliberately absent (see below).
- `src/lib/plans.ts` — `checkEntitlement(planId, feature)` (pure) and
  `getMerchantPlan(store, merchantId)`, which reads the merchant's plan
  from their profile (memory kind A, field `plan`, default `"free"`).
  Profiles written before plans existed have no `plan` field and are
  treated as Free — nothing breaks.
- Jobs/workers are NOT yet gated at runtime; entitlement checks are the
  seam the rail integration (and per-job gating) plugs into.

## Pricing

Not set, on purpose. PHASES.md 5.1: price is decided from beta
evidence (interviews + willingness-to-pay), and Phase 5's entry
criteria (≥3 merchants saying they would pay) have not been evaluated
yet. Any number written here before that would be a guess dressed as a
price.

## Rail decision — owner's call, not made here

Candidates, in the order the project has historically preferred:

1. **A merchant-of-record** (e.g. Lemon Squeezy or Paddle) — the rail
   is the legal seller, handles global VAT/sales tax, cards, and
   dunning. Least compliance surface for a small team.
2. **PayPal Subscriptions** — on-theme for this product (the agent that
   lives inside PayPal, billed through PayPal), but the merchant of
   record is us: tax, invoices, and failed-payment handling are ours.

## Checklist for the day a rail is connected

- [ ] Owner picks the rail and creates the account (owner-only step —
      credentials never go in chat or in this repo).
- [ ] Create the Free/Pro products + prices AT THE RAIL; record only
      the product/price IDs as env vars (`BILLING_*`), never secrets in
      `config/`.
- [ ] Checkout link/flow for upgrade; the app itself never sees or
      stores card data.
- [ ] Rail webhook → entitlement sync: on subscription
      created/updated/cancelled, write the merchant profile's `plan`
      field (memory kind A, through `memoryWrite` with a source naming
      the rail event id) so `getMerchantPlan` reflects reality.
- [ ] Grace period policy: a lapsed subscription downgrades to Free at
      period end, never mid-period; digest/radar (Free features) keep
      running so a lapsed merchant still sees their money.
- [ ] End-to-end test on the rail's sandbox/test mode: subscribe →
      webhook → plan flips to Pro → cancel → plan returns to Free at
      period end.
- [ ] Only then: gate the Pro jobs/workers with `checkEntitlement` at
      the job routes, and update Devpost/README pricing claims to match
      what is actually charged.
