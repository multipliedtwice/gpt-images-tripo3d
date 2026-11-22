import test from "node:test";
import assert from "node:assert/strict";
import { waitForGPTImage, waitForGPTReady } from "../gpt.js";

const chat = "https://chatgpt.com/c/test-chat";
const ready = { state: "ready", src: "image", conversationUrl: chat };
const temporary = () => Object.assign(new Error("Temporary status failure"), { code: "GPT_TIMEOUT" });
const clock = () => {
  let time = 0;
  const delays = [];
  return { delays, now: () => time, advance: ms => { time += ms; }, pause: async ms => { delays.push(ms); time += ms; } };
};

test("a loading tab is ready when the requested home composer is present", async () => {
  const info = { url: "https://chatgpt.com/", conversationUrl: null, composer: true, turns: 0 };
  assert.equal(await waitForGPTReady({ ...clock(), url: info.url, readTab: async () => ({ url: info.url, status: "loading" }), inspect: async () => info }), info);
});

test("same-home navigation waits for the pending document to commit before inspection", async () => {
  const url = "https://chatgpt.com/";
  const info = { url, conversationUrl: null, composer: true, turns: 0 };
  let reads = 0;
  let inspections = 0;
  assert.equal(await waitForGPTReady({ ...clock(), url, readTab: async () => ({ url, status: "loading", pendingUrl: ++reads === 1 ? url : undefined }), inspect: async () => { inspections++; return info; } }), info);
  assert.equal(reads, 2);
  assert.equal(inspections, 1);
});

test("stale documents cannot satisfy home or saved conversation readiness", async () => {
  for (const url of ["https://chatgpt.com/", chat]) {
    const home = url.endsWith(".com/");
    const expected = { url, conversationUrl: home ? null : chat, composer: true, turns: home ? 0 : 1 };
    const stale = { url: home ? chat : "https://chatgpt.com/", conversationUrl: home ? chat : null, composer: true, turns: home ? 1 : 0 };
    let calls = 0;
    assert.equal(await waitForGPTReady({ ...clock(), url, readTab: async () => ({ url, status: "loading" }), inspect: async () => ++calls === 1 ? stale : expected }), expected);
    assert.equal(calls, 2);
  }
});

test("home waits for the composer and an absent conversation identity", async () => {
  const url = "https://chatgpt.com/";
  const states = [{ url, turns: 0, composer: false }, { url, turns: 0, composer: true, conversationUrl: chat }, { url, turns: 0, composer: true, conversationUrl: null }];
  let calls = 0;
  assert.equal(await waitForGPTReady({ ...clock(), url, readTab: async () => ({ url }), inspect: async () => states[calls++] }), states[2]);
  assert.equal(calls, 3);
});

test("readiness stops on a signed-out destination", async () => {
  const url = "https://chatgpt.com/";
  await assert.rejects(waitForGPTReady({ ...clock(), url, readTab: async () => ({ url }), inspect: async () => ({ url, loggedOut: true }) }), { code: "GPT_SIGNED_OUT" });
});

test("readiness retries transient inspect failures until its deadline", async () => {
  const timer = clock();
  const url = "https://chatgpt.com/";
  let calls = 0;
  await assert.rejects(waitForGPTReady({ ...timer, url, readTab: async () => ({ url }), inspect: async () => { calls++; throw calls % 2 ? temporary() : new Error("Could not establish connection. Receiving end does not exist."); } }), { code: "GPT_LOAD_TIMEOUT" });
  assert.equal(timer.now(), 45000);
  assert.ok(calls > 1);
});

test("readiness surfaces terminal inspect errors", async () => {
  const url = "https://chatgpt.com/";
  const error = Object.assign(new Error("Inspection failed"), { code: "GPT_ERROR" });
  await assert.rejects(waitForGPTReady({ ...clock(), url, readTab: async () => ({ url }), inspect: async () => { throw error; } }), error);
});

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
