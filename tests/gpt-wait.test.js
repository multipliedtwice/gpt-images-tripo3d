import test from "node:test";
import assert from "node:assert/strict";
import { waitForGPTImage } from "../gpt.js";

const chat = "https://chatgpt.com/c/test-chat";
const ready = { state: "ready", src: "image", conversationUrl: chat };
const temporary = () => Object.assign(new Error("Temporary status failure"), { code: "GPT_TIMEOUT" });
const clock = () => {
  let time = 0;
  const delays = [];
  return { delays, now: () => time, advance: ms => { time += ms; }, pause: async ms => { delays.push(ms); time += ms; } };
};

test("delayed images keep polling inside one twelve-minute deadline", async () => {
  const timer = clock();
  const budgets = [];
  const found = await waitForGPTImage({ ...timer, readStatus: async budget => { budgets.push(budget); return timer.now() < 11 * 60000 ? { state: "waiting", conversationUrl: chat } : ready; } });
  assert.equal(found, ready);
  assert.equal(timer.now(), 11 * 60000);
  assert.ok(budgets.every(budget => budget <= 20000));
});

test("four transient failures recover on fifth attempt with exponential backoff", async () => {
  const timer = clock();
  let calls = 0;
  const retries = [];
  assert.equal(await waitForGPTImage({ ...timer, readStatus: async () => { if (++calls < 5) throw temporary(); return ready; }, onRetry: value => retries.push(value.attempt) }), ready);
  assert.equal(calls, 5);
  assert.deepEqual(timer.delays, [2000, 4000, 8000, 16000]);
  assert.deepEqual(retries, [2, 3, 4, 5]);
});

test("fifth consecutive failure pauses without a sixth attempt", async () => {
  const timer = clock();
  let calls = 0;
  await assert.rejects(waitForGPTImage({ ...timer, readStatus: async () => { calls++; throw temporary(); } }), { code: "GPT_TIMEOUT" });
  assert.equal(calls, 5);
  assert.deepEqual(timer.delays, [2000, 4000, 8000, 16000]);
});

test("closed message channels and missing receivers get read-only retries", async () => {
  for (const error of [new Error("The message port closed before a response was received."), new Error("Receiving end does not exist."), Object.assign(new Error("Temporary page error"), { code: "GPT_ERROR" })]) {
    const timer = clock();
    let calls = 0;
    assert.equal(await waitForGPTImage({ ...timer, readStatus: async () => { if (++calls === 1) throw error; return ready; } }), ready);
    assert.equal(calls, 2);
    assert.deepEqual(timer.delays, [2000]);
  }
});

test("a successful waiting response resets the transient retry budget", async () => {
  const timer = clock();
  let calls = 0;
  const result = await waitForGPTImage({ ...timer, readStatus: async () => {
    calls++;
    if ([1, 2, 4, 5, 6, 7].includes(calls)) throw temporary();
    return calls === 3 ? { state: "waiting" } : ready;
  } });
  assert.equal(result, ready);
  assert.equal(calls, 8);
  assert.deepEqual(timer.delays, [2000, 4000, 3000, 2000, 4000, 8000, 16000]);
});

test("remaining deadline bounds request budgets and a final retry delay", async () => {
  const timer = clock();
  const budgets = [];
  await assert.rejects(waitForGPTImage({ ...timer, readStatus: async budget => {
    budgets.push(budget);
    if (budgets.length === 1) { timer.advance(12 * 60000 - 1000); throw temporary(); }
    return ready;
  } }), { code: "GPT_IMAGE_TIMEOUT" });
  assert.deepEqual(budgets, [20000]);
  assert.deepEqual(timer.delays, [1000]);
  assert.equal(timer.now(), 12 * 60000);
});

test("a late successful status cannot extend the image deadline", async () => {
  const timer = clock();
  const budgets = [];
  await assert.rejects(waitForGPTImage({ ...timer, readStatus: async budget => {
    budgets.push(budget);
    if (budgets.length === 1) { timer.advance(12 * 60000 - 3500); return { state: "waiting" }; }
    timer.advance(budget);
    return ready;
  } }), { code: "GPT_IMAGE_TIMEOUT" });
  assert.deepEqual(budgets, [20000, 500]);
  assert.equal(timer.now(), 12 * 60000);
});

test("terminal responses and unavailable or changed tabs are never retried", async () => {
  for (const code of ["GPT_SIGNED_OUT", "GPT_LIMIT", "GPT_NO_IMAGE", "GPT_WRONG_TAB", "GPT_TAB_CLOSED", "GPT_CONVERSATION_CHANGED"]) {
    const timer = clock();
    let calls = 0;
    await assert.rejects(waitForGPTImage({ ...timer, readStatus: async () => { calls++; return { state: "failed", code, detail: "Needs attention" }; } }), { code });
    assert.equal(calls, 1);
    assert.deepEqual(timer.delays, []);
  }
});

test("first conversation is recorded once and another chat cannot replace it", async () => {
  const timer = clock();
  const saved = [];
  let calls = 0;
  await assert.rejects(waitForGPTImage({ ...timer, saveConversation: async value => saved.push(value), readStatus: async () => ++calls === 1 ? { state: "waiting", conversationUrl: chat } : { ...ready, conversationUrl: "https://chatgpt.com/c/another" } }), { code: "GPT_CONVERSATION_CHANGED" });
  assert.deepEqual(saved, [chat]);
  assert.equal(calls, 2);
});

test("query, fragment and trailing slash do not change conversation identity", async () => {
  const timer = clock();
  assert.equal(await waitForGPTImage({ ...timer, conversationUrl: chat, readStatus: async () => ({ ...ready, conversationUrl: `${chat}/?x=1#reply` }) }).then(result => result.state), "ready");
});
