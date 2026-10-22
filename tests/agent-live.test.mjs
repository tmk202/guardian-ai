// Live-brain wiring proof (Phase 2D) — NO real LLM key, NO network.
// A MockLanguageModelV1 scripts the model's turns; the tools are fake
// AI SDK tools wrapped by wrapToolsWithExecutor around a test executor,
// so the chain proven end-to-end is the production one:
//   Coordinator prompt v1 → model tool call → executor (validation,
//   SENSITIVE approval gate, ledger) → tool result → final answer.
// Case 1: a READ tool (list_disputes) flows through and is ledgered.
// Case 2: a SENSITIVE tool (create_refund) with no approval is BLOCKED
// by the executor — the merchant's handler never runs, an approval is
// created PENDING, and the model receives the approval_required result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV1 } from "ai/test";
import { tool } from "ai";
import { z } from "zod";
import { createStore } from "../tests-dist/lib/db.js";
import { GuardianExecutor } from "../tests-dist/lib/executor.js";
import { wrapToolsWithExecutor } from "../tests-dist/lib/tools.js";
import { runLiveAgent } from "../tests-dist/lib/agent.js";

const MERCHANT = "sandbox-merchant";

function setup() {
  const store = createStore(":memory:");
  store.merchants.upsert({
    id: MERCHANT, profile_json: "{}", policy_yaml: "",
    created_at: new Date().toISOString(),
  });
  return { store, executor: new GuardianExecutor({ store }) };
}

const usage = { promptTokens: 10, completionTokens: 10 };
const rawCall = { rawPrompt: "", rawSettings: {} };
const toolCallResponse = (toolName, args) => ({
  finishReason: "tool-calls",
  usage,
  rawCall,
  toolCalls: [
    { toolCallType: "function", toolCallId: "call-1", toolName, args: JSON.stringify(args) },
  ],
});
const textResponse = (text) => ({ finishReason: "stop", usage, rawCall, text });

function scriptedModel(responses) {
  let i = 0;
  return new MockLanguageModelV1({
    doGenerate: async () => responses[Math.min(i++, responses.length - 1)],
  });
}

test("live chain: model → list_disputes through executor → answer, ledgered", async () => {
  const { store, executor } = setup();
  const tools = wrapToolsWithExecutor(
    {
      list_disputes: tool({
        description: "List disputes",
        parameters: z.object({}),
        execute: async () => ({
          items: [{ dispute_id: "PP-R-FAKE-1", status: "UNDER_REVIEW" }],
        }),
      }),
    },
    { executor }
  );
  const model = scriptedModel([
    toolCallResponse("list_disputes", {}),
    textResponse("You have 1 open dispute: PP-R-FAKE-1."),
  ]);
  const result = await runLiveAgent("Any disputes I should worry about?", model, {
    tools,
    executor,
  });
  assert.ok(result.text.includes("PP-R-FAKE-1"));
  assert.equal(result.steps[0].toolCalls[0].toolName, "list_disputes");
  const calls = store.ledger
    .list(MERCHANT, 100)
    .filter((r) => r.kind === "tool_call" && r.tool === "list_disputes");
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].result_json).ok, true);
  store.close();
});

test("live chain: SENSITIVE create_refund without approval is blocked by the executor", async () => {
  const { store, executor } = setup();
  let refundExecutions = 0;
  const tools = wrapToolsWithExecutor(
    {
      create_refund: tool({
        description: "Create a refund",
        parameters: z.object({ transaction_id: z.string() }),
        execute: async () => {
          refundExecutions++;
          return { status: "refunded" };
        },
      }),
    },
    { executor }
  );
  const model = scriptedModel([
    toolCallResponse("create_refund", { transaction_id: "TXN-1" }),
    textResponse("That refund is sensitive — I created an approval request for you first."),
  ]);
  const result = await runLiveAgent("Refund transaction TXN-1 please", model, {
    tools,
    executor,
  });
  // The merchant's money never moved: the underlying handler ran 0 times.
  assert.equal(refundExecutions, 0);
  // The model was told an approval is required (structured result, not a crash).
  const toolResult = result.steps[0].toolResults[0].result;
  assert.equal(toolResult.approval_required, true);
  assert.ok(toolResult.approval_id);
  // A PENDING approval for exactly this call exists, and the block is ledgered.
  const pending = store.approvals.list(MERCHANT, "PENDING");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].tool, "create_refund");
  const blocks = store.ledger
    .list(MERCHANT, 100)
    .filter((r) => r.tool === "create_refund" && (r.result_json ?? "").includes("APPROVAL_REQUIRED"));
  assert.equal(blocks.length, 1);
  store.close();
});
