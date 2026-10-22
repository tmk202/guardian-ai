// Direct PayPal REST readers (Phase 2B) — the read side the Analyst
// worker and the morning digest need as plain functions.
//
// disputes.ts already covers the token + dispute reads for the evidence
// flow; this module adds the three list reads (invoices, disputes,
// transactions) plus token-scope introspection. The scope string in the
// OAuth token response is the ground truth for feature availability
// (e.g. Transaction Search) — the Analyst checks it BEFORE calling the
// reporting API so a missing scope becomes a declared gap in the report,
// not a mysterious 403 (§3.4: say which numbers you could NOT produce).
import { getAccessToken } from "./disputes";

const SANDBOX_API = "https://api-m.sandbox.paypal.com";

/** Scope that gates GET /v1/reporting/transactions. */
export const TRANSACTION_SEARCH_SCOPE =
  "https://uri.paypal.com/services/reporting/search/read";

export class PayPalRestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PayPalRestError";
    this.status = status;
  }
}

async function apiGet(pathname: string): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(`${SANDBOX_API}${pathname}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new PayPalRestError(
      res.status,
      `GET ${pathname.split("?")[0]} failed: ${res.status} ${text.slice(0, 300)}`
    );
  }
  return text ? JSON.parse(text) : {};
}

/** Token + the full scope list granted to the app (ground truth for §3.4). */
export async function getTokenInfo(): Promise<{ token: string; scopes: string[] }> {
  const id = process.env.PAYPAL_CLIENT_ID;
  const sec = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !sec) throw new Error("Missing PayPal sandbox credentials in env");
  const basic = Buffer.from(`${id}:${sec}`).toString("base64");
  const res = await fetch(`${SANDBOX_API}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal token request failed: ${res.status}`);
  const json = (await res.json()) as { access_token: string; scope?: string };
  return {
    token: json.access_token,
    scopes: (json.scope ?? "").split(" ").filter(Boolean),
  };
}

/** GET /v2/invoicing/invoices — one page (100) is ample at sandbox scale. */
export async function listInvoicesRest(): Promise<any> {
  return apiGet("/v2/invoicing/invoices?page=1&page_size=100&total_required=true");
}

/** GET /v1/customer/disputes — the seller's dispute list. */
export async function listDisputesRest(): Promise<any> {
  return apiGet("/v1/customer/disputes?page_size=50");
}

/** GET /v1/reporting/transactions — requires the Transaction Search scope. */
export async function listTransactionsRest(args: {
  start_date: string;
  end_date: string;
}): Promise<any> {
  const qs = new URLSearchParams({
    start_date: args.start_date,
    end_date: args.end_date,
    fields: "transaction_info,payer_info",
    page_size: "500",
  });
  return apiGet(`/v1/reporting/transactions?${qs.toString()}`);
}
