// PayPal Agent Toolkit wiring (docs: github.com/paypal/agent-toolkit, TypeScript / ai-sdk).
//
// The toolkit is configured with the app's clientId + clientSecret; the SDK
// obtains and refreshes the OAuth access token itself (client-credentials flow),
// so the app never juggles the ~8h sandbox token manually.
//
// `actions` is guardrail layer 1: a tool that is not enabled here does not
// exist for the AI at all. Sensitive money-moving actions additionally pass
// through the approval layer in guardrail.ts before they execute.
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";

export function createPayPalToolkit() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET. Create a sandbox app in the PayPal Developer Dashboard (Apps & Credentials > Sandbox) and fill .env.local — see ../IMPLEMENTATION.md section 3."
    );
  }

  return new PayPalAgentToolkit({
    clientId,
    clientSecret,
    configuration: {
      context: { sandbox: true }, // V1 is sandbox-only; go-live = swap env + this flag
      actions: {
        invoices: {
          create: true,
          list: true,
          send: true,
          sendReminder: true,
          cancel: true,
          generateQRC: true,
          generateInvoiceNumber: true,
        },
        orders: { create: true, get: true },
        payments: { createRefund: true }, // wrapped by approval layer
        disputes: { list: true, get: true, accept: true }, // accept wrapped by approval layer
        shipment: { create: true, show: true },
        products: { list: true },
        transactions: { list: true },
        insights: { getMerchantInsights: true },
      },
    },
  });
}
