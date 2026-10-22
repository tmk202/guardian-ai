// Beta self-check (PHASES 4D) — Phase 4D.
//
// Before a new merchant runs Guardian against their account, this check
// answers "is the setup actually complete?" with evidence, one line per
// item: credentials present and a token really comes back, which OAuth
// scopes the app actually holds (the token response is the ground
// truth — not what anyone remembers ticking), the webhook registration
// and where it points, whether the store round-trips a write, and
// whether the job secret that guards the watcher endpoints is set.
//
// FAIL = a core capability is broken. WARN = Guardian runs, but a
// feature is limited (the classic case today: Transaction Search not
// ticked, which blinds money_in and the Hold Radar). No check ever
// prints a credential value.
import { DEFAULT_MERCHANT_ID, getStore, type GuardianStore } from "./db";
import { getTokenInfo, listWebhooksRest, TRANSACTION_SEARCH_SCOPE } from "./paypal-rest";

export type SelfCheckStatus = "PASS" | "WARN" | "FAIL";

export interface SelfCheckLine {
  check: string;
  status: SelfCheckStatus;
  detail: string;
}

export interface SelfCheckResult {
  lines: SelfCheckLine[];
  pass: number;
  warn: number;
  fail: number;
  /** true when nothing is FAIL — WARNs are allowed to ship with eyes open */
  ok: boolean;
}

export interface SelfCheckDeps {
  env: Record<string, string | undefined>;
  getTokenInfo: () => Promise<{ token: string; scopes: string[] }>;
  listWebhooks: () => Promise<any>;
  openStore: () => GuardianStore;
}

export const INVOICING_SCOPE_FRAGMENT = "services/invoicing";
export const DISPUTES_SCOPE_FRAGMENT = "services/disputes";
export const SELF_CHECK_JOB = "beta-selfcheck";

export function defaultSelfCheckDeps(): SelfCheckDeps {
  return {
    env: process.env,
    getTokenInfo: () => getTokenInfo(),
    listWebhooks: () => listWebhooksRest(),
    openStore: () => getStore(),
  };
}

const hasScope = (scopes: string[], fragment: string) =>
  scopes.some((s) => s.includes(fragment));

export async function runBetaSelfCheck(
  deps: SelfCheckDeps = defaultSelfCheckDeps()
): Promise<SelfCheckResult> {
  const lines: SelfCheckLine[] = [];
  const push = (check: string, status: SelfCheckStatus, detail: string) =>
    lines.push({ check, status, detail });
  const { env } = deps;

  // ---- credentials ---------------------------------------------------------
  const hasCreds = Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
  push(
    "credentials_configured",
    hasCreds ? "PASS" : "FAIL",
    hasCreds
      ? "PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are set (values never printed)"
      : "PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing from the environment — Guardian cannot call PayPal at all"
  );

  // ---- token + scopes ---------------------------------------------------------
  let scopes: string[] | null = null;
  if (hasCreds) {
    try {
      const info = await deps.getTokenInfo();
      scopes = info.scopes;
      push(
        "token_fetch",
        "PASS",
        `OAuth token acquired from PayPal; ${scopes.length} scope(s) granted`
      );
    } catch (e) {
      push(
        "token_fetch",
        "FAIL",
        `Token request failed (${e instanceof Error ? e.message.slice(0, 160) : String(e)}) — credentials may be wrong or the app inactive`
      );
    }
  } else {
    push("token_fetch", "FAIL", "Skipped — no credentials configured");
  }

  if (scopes) {
    push(
      "scope_invoicing",
      hasScope(scopes, INVOICING_SCOPE_FRAGMENT) ? "PASS" : "FAIL",
      hasScope(scopes, INVOICING_SCOPE_FRAGMENT)
        ? "Invoicing scope granted — invoices can be created, read and reminded"
        : "Invoicing scope NOT granted — tick 'Invoicing' on the app and Save changes"
    );
    push(
      "scope_transaction_search",
      scopes.includes(TRANSACTION_SEARCH_SCOPE) ? "PASS" : "WARN",
      scopes.includes(TRANSACTION_SEARCH_SCOPE)
        ? "Transaction Search scope granted — money_in and Hold Radar have real data"
        : "Transaction Search scope NOT granted — money_in stays null and the Hold Radar reports 'unavailable'. Tick 'Transaction Search' on the app in Developer Dashboard > Apps & Credentials, then Save changes"
    );
    push(
      "scope_disputes",
      hasScope(scopes, DISPUTES_SCOPE_FRAGMENT) ? "PASS" : "WARN",
      hasScope(scopes, DISPUTES_SCOPE_FRAGMENT)
        ? "Disputes scope granted — cases can be read and evidence submitted"
        : "Disputes scope NOT found in the token — dispute reads may be limited"
    );
  } else {
    push("scope_invoicing", "FAIL", "Unknown — no token, so no scope list");
    push("scope_transaction_search", "FAIL", "Unknown — no token, so no scope list");
    push("scope_disputes", "FAIL", "Unknown — no token, so no scope list");
  }

  // ---- webhook ------------------------------------------------------------------
  const webhookId = env.PAYPAL_WEBHOOK_ID;
  const expectedUrl =
    env.GUARDIAN_WEBHOOK_URL ??
    "https://guardian-ai-ruby.vercel.app/api/webhooks/paypal";
  if (!webhookId) {
    push(
      "webhook_registered",
      "WARN",
      "PAYPAL_WEBHOOK_ID is not set — incoming events cannot be signature-verified against a registered webhook"
    );
  } else if (!hasCreds) {
    push("webhook_registered", "WARN", "Webhook id is set but cannot be verified without a token");
  } else {
    try {
      const list = await deps.listWebhooks();
      const hooks: any[] = Array.isArray(list?.webhooks) ? list.webhooks : [];
      const mine = hooks.find((h) => h?.id === webhookId);
      if (!mine) {
        push(
          "webhook_registered",
          "FAIL",
          `PAYPAL_WEBHOOK_ID is set but no webhook with that id exists on the app (${hooks.length} registered)`
        );
      } else if (mine.url !== expectedUrl) {
        push(
          "webhook_registered",
          "WARN",
          `Webhook ${webhookId} points at ${mine.url} — expected ${expectedUrl}`
        );
      } else {
        push(
          "webhook_registered",
          "PASS",
          `Webhook ${webhookId} registered and pointing at ${mine.url}`
        );
      }
    } catch (e) {
      push(
        "webhook_registered",
        "WARN",
        `Could not list webhooks to verify the registration (${e instanceof Error ? e.message.slice(0, 120) : String(e)})`
      );
    }
  }

  // ---- store -----------------------------------------------------------------------
  try {
    const store = deps.openStore();
    const probe = `probe-${Date.now()}`;
    store.jobState.set({
      job_name: SELF_CHECK_JOB,
      merchant_id: DEFAULT_MERCHANT_ID,
      cursor_json: JSON.stringify({ probe }),
      last_run_at: new Date().toISOString(),
      last_status: "selfcheck",
    });
    const back = store.jobState.get(SELF_CHECK_JOB, DEFAULT_MERCHANT_ID);
    const roundTrips = Boolean(back?.cursor_json?.includes(probe));
    const merchantKnown = Boolean(store.merchants.get(DEFAULT_MERCHANT_ID));
    push(
      "store_roundtrip",
      roundTrips ? "PASS" : "FAIL",
      roundTrips
        ? `Store write/read round-trip works (${process.env.DATABASE_URL ? "Postgres via DATABASE_URL" : "SQLite file store"}); merchant row ${merchantKnown ? "present" : "absent"}`
        : "Store accepted a write but the read-back did not match"
    );
  } catch (e) {
    push(
      "store_roundtrip",
      "FAIL",
      `Store could not be opened (${e instanceof Error ? e.message.slice(0, 160) : String(e)})`
    );
  }

  // ---- job secret ---------------------------------------------------------------------
  push(
    "job_secret_configured",
    env.GUARDIAN_JOB_SECRET ? "PASS" : "WARN",
    env.GUARDIAN_JOB_SECRET
      ? "GUARDIAN_JOB_SECRET is set — watcher endpoints will run when called with it"
      : "GUARDIAN_JOB_SECRET is not set — every /api/jobs/* endpoint refuses to run (503) until it is configured"
  );

  const pass = lines.filter((l) => l.status === "PASS").length;
  const warn = lines.filter((l) => l.status === "WARN").length;
  const fail = lines.filter((l) => l.status === "FAIL").length;
  return { lines, pass, warn, fail, ok: fail === 0 };
}

/** Plain-text table for the CLI runner. */
export function formatSelfCheck(result: SelfCheckResult): string {
  const width = Math.max(...result.lines.map((l) => l.check.length));
  const rows = result.lines.map(
    (l) => `${l.status.padEnd(4)}  ${l.check.padEnd(width)}  ${l.detail}`
  );
  return [
    ...rows,
    "",
    `Summary: ${result.pass} PASS, ${result.warn} WARN, ${result.fail} FAIL — ${result.ok ? "setup usable (warnings = limited features)" : "setup NOT usable, fix the FAIL lines first"}`,
  ].join("\n");
}
