// Guardian agent — one simple AI employee, three jobs (see IMPLEMENTATION.md):
// 1) invoices by plain-language request + reminders
// 2) dispute watch: read the case, gather order/shipment evidence, draft a reply
// 3) money report: today's takings, unpaid invoices, held funds
//
// The brain is any chat model via the Vercel AI SDK; the hands are the PayPal
// Agent Toolkit tools. Sensitive tools pass the guardrail approval layer.
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createPayPalToolkit } from "./paypal";

// The brain's key comes from AI_API_KEY (documented in .env.example);
// OPENAI_API_KEY is accepted as a fallback.
const openai = createOpenAI({
  apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY,
});

export const SYSTEM_PROMPT = `You are Guardian, an AI employee that operates the user's PayPal (sandbox) account.

Your three jobs:
1. INVOICES — When asked, create and send PayPal invoices, list unpaid/overdue ones,
   and send polite reminders (reminders are limited to 2 per day per invoice).
2. DISPUTES — When a dispute exists, read it, gather the related order and shipment
   tracking, and draft an evidence-based response for the user to approve.
   Never submit evidence or accept a claim without explicit user approval.
3. MONEY REPORT — Summarize transactions: what came in, what is unpaid, what looks held.

Rules:
- Always use the PayPal tools to get real data. Never invent amounts, IDs, dates or statuses.
- Before any refund, dispute acceptance, or evidence submission, stop and ask the user to approve.
- Answer in the user's language, briefly, with the key numbers first.`;

export async function runGuardian(prompt: string) {
  const toolkit = createPayPalToolkit();
  const modelId = process.env.AI_MODEL || "gpt-4o-mini";
  const result = await generateText({
    model: openai(modelId),
    system: SYSTEM_PROMPT,
    prompt,
    tools: toolkit.getTools(),
    maxSteps: 10, // AI SDK v4 (the Agent Toolkit 1.x line targets v4)
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
