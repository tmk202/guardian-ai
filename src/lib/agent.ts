// Guardian agent — one simple AI employee, three jobs (see IMPLEMENTATION.md):
// 1) invoices by plain-language request + reminders
// 2) dispute watch: read the case, gather order/shipment evidence, draft a reply
// 3) money report: today's takings, unpaid invoices, held funds
//
// The brain is any chat model via the Vercel AI SDK; the hands are the PayPal
// Agent Toolkit tools. Sensitive tools pass the guardrail approval layer.
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createPayPalToolkit } from "./paypal";
import { runDemo } from "./demo";
import { registerCoreTools, wrapToolsWithExecutor } from "./tools";
import {
  buildCoordinatorPrompt,
  COORDINATOR_PROMPT_VERSION,
} from "./prompts/coordinator";

export { COORDINATOR_PROMPT_VERSION };

// The brain is provider-agnostic (Vercel AI SDK). Pick with AI_PROVIDER:
// - "openai": key from AI_API_KEY or OPENAI_API_KEY, model default gpt-4o-mini
// - "google": key from AI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY,
//   model default gemini-2.0-flash (free-tier AI Studio keys work)
function pickModel() {
  const provider =
    process.env.AI_PROVIDER ||
    (process.env.GOOGLE_GENERATIVE_AI_API_KEY ? "google" : "openai");
  if (provider === "google") {
    const google = createGoogleGenerativeAI({
      apiKey: process.env.AI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    });
    return google(process.env.AI_MODEL || "gemini-2.0-flash");
  }
  const openai = createOpenAI({
    apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY,
  });
  return openai(process.env.AI_MODEL || "gpt-4o-mini");
}

// Coordinator system prompt v1 (ARCHITECTURE-DETAIL.md §3.1 + charter §3.0)
// lives in lib/prompts/coordinator.ts as a versioned asset. SYSTEM_PROMPT
// keeps the old export name, built with the sandbox shop's defaults; the
// live path rebuilds it per call so the date is always current.
const MERCHANT_TIMEZONE = "Asia/Saigon";

function coordinatorVars() {
  return {
    merchantName: "Test Store",
    paypalEmail:
      process.env.PAYPAL_SANDBOX_BUSINESS_EMAIL || "sandbox business account",
    date: new Date().toLocaleDateString("en-CA", { timeZone: MERCHANT_TIMEZONE }),
    timezone: MERCHANT_TIMEZONE,
  };
}

export const SYSTEM_PROMPT = buildCoordinatorPrompt(coordinatorVars());

export async function runGuardian(prompt: string) {
  // No LLM key configured -> demo mode: a scripted walkthrough built from
  // our real PayPal sandbox runs (src/lib/demo.ts). With any key present,
  // the live agent below runs instead.
  const hasKey =
    process.env.AI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!hasKey) return runDemo(prompt);

  const toolkit = createPayPalToolkit();
  registerCoreTools();
  const result = await generateText({
    model: pickModel(),
    system: buildCoordinatorPrompt(coordinatorVars()),
    prompt,
    // Every tool call passes the executor (validation, approval gate for
    // SENSITIVE tools, idempotency, ledger, read-back) — see lib/executor.ts.
    tools: wrapToolsWithExecutor(toolkit.getTools()),
    maxSteps: 12, // spec §1.2 Coordinator cap (AI SDK v4 — Toolkit 1.x targets v4)
  });
  return {
    text: result.text,
    // Tool-call trail powers the activity log panel in the UI.
    steps: result.steps.map((s) => ({
      toolCalls: s.toolCalls.map((c) => ({ toolName: c.toolName, args: c.args })),
      toolResults: (s.toolResults as any[]).map((r: any) => ({ toolName: r.toolName })),
    })),
  };
}
