import test from "node:test";
import assert from "node:assert/strict";
import { queueGroup, queueCounts } from "../queue-status.js";
import { validateTool } from "../mcp-tools.js";

test("queue groups keep waiting, active, attention and completed distinct", () => {
  assert.equal(queueGroup(null), "waiting");
  assert.equal(queueGroup({ status: "pending" }), "waiting");
  for (const status of ["prepared", "uploaded", "submitting", "generating", "exporting", "staging", "committing", "submitted", "saving"]) assert.equal(queueGroup({ status }), "active");
  assert.equal(queueGroup({ status: "submitted", error: "Paused" }), "attention");
  assert.equal(queueGroup({ status: "failed" }), "attention");
  assert.equal(queueGroup({ status: "completed", error: "Old error" }), "completed");
  assert.equal(queueGroup({ status: "saved" }), "completed");
});
test("counts include entire history beyond display cap", () => {
  assert.deepEqual(queueCounts([null, { status: "generating" }, { status: "failed" }, ...Array.from({ length: 90 }, () => ({ status: "completed" }))]), { all: 93, waiting: 1, active: 1, attention: 1, completed: 90 });
});
test("tool validation rejects unknown fields, invalid ranges and empty prompts", () => {
  assert.throws(() => validateTool("runner_settings", {}));
  assert.throws(() => validateTool("runner_start", { queue: "gpt", regenerate: true }));
  assert.throws(() => validateTool("runner_settings", { maxCredits: 0 }));
  assert.throws(() => validateTool("runner_add_prompts", { prompts: ["  "] }));
  assert.throws(() => validateTool("not_a_tool", {}));
  assert.throws(() => validateTool("runner_start", null));
  validateTool("runner_settings", { maxCredits: 55, limit: 0, watch: true });
  validateTool("runner_add_prompts", { prompts: ["Generate a crate"] });
});


test("request-scoped tools accept stable labels and reject empty or oversized labels", () => {
  for (const name of ["runner_status", "runner_clear_finished", "runner_add_prompts", "runner_prompt_action"]) {
    const args = name === "runner_add_prompts" ? { prompts: ["Bird"] } : name === "runner_prompt_action" ? { id: "prompt", action: "remove" } : {};
    validateTool(name, { ...args, requestId: "chat-a" });
    assert.throws(() => validateTool(name, { ...args, requestId: " " }));
    assert.throws(() => validateTool(name, { ...args, requestId: "a".repeat(101) }));
  }
});


test("parallel GPT start and stop use requestId; Tripo rejects that scope", () => {
  for (const name of ["runner_start", "runner_stop"]) {
    validateTool(name, { queue: "gpt", requestId: "chat-a" });
    assert.throws(() => validateTool(name, { queue: "tripo", requestId: "chat-a" }), /only to GPT/);
  }
});
