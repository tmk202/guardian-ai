// Guardian agent — one simple AI employee, three jobs (see IMPLEMENTATION.md):
// 1) invoices by plain-language request + reminders
// 2) dispute watch: read the case, gather order/shipment evidence, draft a reply
// 3) money report: today's takings, unpaid invoices, held funds
//
// The brain is any chat model via the Vercel AI SDK; the hands are the PayPal
// Agent Toolkit tools. Sensitive tools pass the guardrail approval layer.
import { generateText, type LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createPayPalToolkit } from "./paypal";
import { runDemo } from "./demo";
import { registerCoreTools, wrapToolsWithExecutor } from "./tools";
import type { GuardianExecutor } from "./executor";
import {
  buildCoordinatorPrompt,
  COORDINATOR_PROMPT_VERSION,
} from "./prompts/coordinator";

export { COORDINATOR_PROMPT_VERSION };

// The brain is provider-agnostic (Vercel AI SDK). Pick with AI_PROVIDER:
// - "openai": key from AI_API_KEY or OPENAI_API_KEY, model default gpt-4o-mini
// - "google": key from AI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY,
//   model default gemini-2.0-flash (free-tier AI Studio keys work)
// - "ollama": a local model served by Ollama's OpenAI-compatible endpoint
//   (Phase 2, the user's own machine path). No API key exists to lose —
//   selecting the provider IS the opt-in. Base URL from OLLAMA_BASE_URL,
//   model default llama3.1.
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
  if (provider === "ollama") {
    const ollama = createOpenAI({
      baseURL: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1",
      apiKey: "ollama", // local server ignores it; the SDK requires a value
    });
    return ollama(process.env.AI_MODEL || "llama3.1");
  }
  const openai = createOpenAI({
    apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY,
  });
  return openai(process.env.AI_MODEL || "gpt-4o-mini");
}

/** Is a live brain configured? Ollama counts: it is a deliberate opt-in. */
export function hasBrain(): boolean {
  return Boolean(
    process.env.AI_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
      process.env.AI_PROVIDER === "ollama"
  );
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

/**
 * The live agent loop, split out of runGuardian so tests can drive it
 * with a mock language model and a test toolset — proving prompt v1 →
 * tool (through the executor) → answer without any real LLM key (Phase 2D).
 */
export async function runLiveAgent(
  prompt: string,
  model: LanguageModel,
  opts?: { tools?: Record<string, any>; executor?: GuardianExecutor }
) {
  registerCoreTools(opts?.executor);
  const tools =
    opts?.tools ??
    wrapToolsWithExecutor(createPayPalToolkit().getTools(), {
      executor: opts?.executor,
    });
  const result = await generateText({
    model,
    system: buildCoordinatorPrompt(coordinatorVars()),
    prompt,
    // Every tool call passes the executor (validation, approval gate for
    // SENSITIVE tools, idempotency, ledger, read-back) — see lib/executor.ts.
    tools,
    maxSteps: 12, // spec §1.2 Coordinator cap (AI SDK v4 — Toolkit 1.x targets v4)
  });
  return {
    text: result.text,
    // Tool-call trail powers the activity log panel in the UI.
    steps: result.steps.map((s) => ({
      toolCalls: s.toolCalls.map((c) => ({ toolName: c.toolName, args: c.args })),
      toolResults: (s.toolResults as any[]).map((r: any) => ({
        toolName: r.toolName,
        result: r.result,
      })),
    })),
  };
}

export async function runGuardian(prompt: string) {
  // No brain configured -> demo mode: a scripted walkthrough built from
  // our real PayPal sandbox runs (src/lib/demo.ts). With a key (or the
  // ollama provider) present, the live agent runs instead.
  if (!hasBrain()) return runDemo(prompt);
  return runLiveAgent(prompt, pickModel());
}
