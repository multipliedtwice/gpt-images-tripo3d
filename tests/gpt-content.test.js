import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../content-gpt.js", import.meta.url), "utf8");
const fixture = () => {
  let time = 0;
  let listener;
  const state = { completion: null, response: "Preparing the image", responseExists: true, working: false, images: [] };
  const response = { innerText: state.response };
  const document = { querySelector: () => null, querySelectorAll: selector => {
    if (selector.includes("data-talvt-turn-state")) return state.completion ? [{ getAttribute: () => state.completion }] : [];
    if (selector.includes("stop-button")) return state.working ? [{ isConnected: true, getClientRects: () => [1] }] : [];
    if (selector.includes("data-user-message-bubble")) return [{}];
    if (selector.includes("data-response-body")) { response.innerText = state.response; return state.responseExists ? [response] : []; }
    if (selector.includes("generated-image-gallery")) return state.images;
    return [];
  } };
  vm.runInNewContext(source, { document, location: { pathname: "/c/test-chat", origin: "https://chatgpt.com", href: "https://chatgpt.com/c/test-chat" }, chrome: { runtime: { id: "extension", onMessage: { addListener: value => { listener = value; } } } }, Date: { now: () => time }, getComputedStyle: () => ({ visibility: "visible" }), setTimeout, clearTimeout });
  const status = () => new Promise(resolve => listener({ type: "gpt:status" }, { id: "extension" }, resolve));
  const image = (loaded = true) => ({ complete: loaded, naturalWidth: loaded ? 1024 : 0, naturalHeight: loaded ? 1024 : 0, currentSrc: "generated-image", closest: () => null });
  return { state, status, image, advance: ms => { time += ms; } };
};

test("unknown completion never becomes an early no-image failure", async () => {
  const page = fixture();
  assert.equal((await page.status()).state, "waiting");
  page.advance(11 * 60000);
  assert.equal((await page.status()).state, "waiting");
});

test("explicit completion starts a full sixty-second grace", async () => {
  const page = fixture();
  await page.status(); page.advance(120000);
  page.state.completion = "complete";
  assert.equal((await page.status()).state, "waiting");
  page.advance(59999); assert.equal((await page.status()).state, "waiting");
  page.advance(1); assert.equal((await page.status()).code, "GPT_NO_IMAGE");
});

test("pending images keep waiting and completed assets settle before readiness", async () => {
  const page = fixture(); page.state.completion = "complete";
  page.state.images = [page.image(false)]; await page.status(); page.advance(120000);
  assert.equal((await page.status()).state, "waiting");
  page.state.images = [page.image()]; assert.equal((await page.status()).state, "waiting");
  page.advance(3000); assert.equal((await page.status()).state, "ready");
});

test("losing a pending image starts a new no-image grace", async () => {
  const page = fixture(); page.state.completion = "complete"; page.state.images = [page.image(false)];
  await page.status(); page.advance(120000); page.state.images = [];
  assert.equal((await page.status()).state, "waiting");
  page.advance(60000); assert.equal((await page.status()).code, "GPT_NO_IMAGE");
});

test("same-length response changes and active generation reset completion settling", async () => {
  const page = fixture(); page.state.completion = "complete";
  await page.status(); page.advance(59000); page.state.response = "Changing the image!";
  assert.equal((await page.status()).state, "waiting");
  page.advance(59000); assert.equal((await page.status()).state, "waiting");
  page.state.working = true; page.advance(120000); assert.equal((await page.status()).state, "waiting");
});

const submitFixture = onSend => {
  let time = 0;
  let listener;
  const location = { origin: "https://chatgpt.com", pathname: "/", href: "https://chatgpt.com/" };
  const state = { turns: [], clicks: 0, enters: 0 };
  class Textarea {
    constructor() { this.isConnected = true; this.parentElement = null; this._value = ""; }
    get value() { return this._value; }
    set value(value) { this._value = value; }
    focus() {}
    dispatchEvent(event) { if (event.type === "keydown") state.enters++; }
    getClientRects() { return [1]; }
  }
  const box = new Textarea();
  const button = { isConnected: true, disabled: false, getClientRects: () => [1], getAttribute: () => null, click: () => { state.clicks++; onSend({ state, box, location }); } };
  const document = { body: {}, querySelector: () => null, querySelectorAll: selector => {
    if (selector.includes("data-user-message-bubble")) return state.turns;
    if (selector.includes("prompt-textarea")) return [box];
    if (selector.includes("send-button")) return [button];
    return [];
  } };
  class Event { constructor(type) { this.type = type; } }
  vm.runInNewContext(source, { document, location, HTMLTextAreaElement: Textarea, Event, KeyboardEvent: Event, chrome: { runtime: { id: "extension", onMessage: { addListener: value => { listener = value; } } } }, Date: { now: () => time }, getComputedStyle: () => ({ visibility: "visible" }), setTimeout: (fn, ms) => { time += ms; queueMicrotask(fn); }, clearTimeout: () => {} });
  const send = () => new Promise(resolve => listener({ type: "gpt:submit", jobId: "job", prompt: "A precise prompt" }, { id: "extension" }, resolve));
  const inspect = () => new Promise(resolve => listener({ type: "gpt:inspect" }, { id: "extension" }, resolve));
  return { state, box, location, send, inspect };
};

const turn = value => ({ innerText: value, isConnected: true, getClientRects: () => [1] });

const route = (location, pathname) => { location.pathname = pathname; location.href = location.origin + pathname; };

test("a local draft route with a filled composer cannot confirm submission", async () => {
  const page = submitFixture(({ location }) => route(location, "/c/local-chatgpt%3Adraft"));
  const result = await page.send();
  assert.equal(result.code, "GPT_SEND_UNCONFIRMED");
  assert.equal(result.submitted, true);
  assert.equal((await page.inspect()).conversationUrl, null);
  assert.equal(page.state.enters, 0);
});

test("an unchanged composer or durable route alone leaves submission uncertain", async () => {
  for (const change of [() => {}, ({ location }) => route(location, "/c/real-chat")]) {
    const page = submitFixture(change);
    const result = await page.send();
    assert.equal(result.code, "GPT_SEND_UNCONFIRMED");
    assert.equal(result.submitted, true);
    assert.equal(page.state.clicks, 1);
    assert.equal(page.state.enters, 0);
    assert.equal((await page.send()).code, "GPT_ALREADY_SUBMITTED");
  }
});

test("a matching turn without a durable route confirms submission without saving the draft link", async () => {
  const page = submitFixture(({ state, location }) => { state.turns.push(turn("A precise prompt")); route(location, "/c/local-chatgpt%3Adraft"); });
  const result = await page.send();
  assert.equal(result.submitted, true);
  assert.equal(result.conversationUrl, null);
  assert.equal(page.state.clicks, 1);
  assert.equal(page.state.enters, 0);
});

test("empty or detached composers and unrelated new turns cannot confirm submission", async () => {
  for (const change of [({ box }) => { box.value = ""; }, ({ box }) => { box.isConnected = false; }, ({ state }) => { state.turns.push(turn("A different prompt")); }]) {
    const page = submitFixture(change);
    const result = await page.send();
    assert.equal(result.code, "GPT_SEND_UNCONFIRMED");
    assert.equal(result.submitted, true);
    assert.equal(page.state.enters, 0);
  }
});

test("a matching new turn confirms submission and returns the durable route", async () => {
  const page = submitFixture(({ state, location }) => { state.turns.push(turn("A precise   prompt")); route(location, "/c/real-chat"); });
  const result = await page.send();
  assert.equal(result.submitted, true);
  assert.equal(result.conversationUrl, "https://chatgpt.com/c/real-chat");
  assert.equal(page.state.clicks, 1);
  assert.equal(page.state.enters, 0);
});

test("a local route can become durable after the matching turn", async () => {
  const page = submitFixture(({ state, location }) => { state.turns.push(turn("A precise prompt")); route(location, "/c/local-chatgpt%3Adraft"); queueMicrotask(() => route(location, "/c/real-chat")); });
  const result = await page.send();
  assert.equal(result.conversationUrl, "https://chatgpt.com/c/real-chat");
  assert.equal(page.state.clicks, 1);
});

test("inspect rejects malformed, ephemeral, extra-segment and foreign conversation routes", async () => {
  const page = submitFixture(() => {});
  for (const path of ["/c/local-chatgpt%3Adraft", "/c/%XX", "/c/id/extra", "/c/a%2Fb"]) {
    route(page.location, path);
    assert.equal((await page.inspect()).conversationUrl, null);
  }
  route(page.location, "/c/valid-id");
  assert.equal((await page.inspect()).conversationUrl, "https://chatgpt.com/c/valid-id");
  page.location.origin = "https://example.com";
  assert.equal((await page.inspect()).conversationUrl, null);
});

test("collapsed visible bubble confirms its semantic prompt without Show more or hidden clones", async () => {
  const page = submitFixture(({ state, location }) => {
    const bubble = { ...turn("A precise prompt… Show more"), matches: () => true, querySelector: selector => selector === '[data-thread-reading-passage]' ? { innerText: "A precise prompt" } : null };
    const hidden = { ...bubble, isConnected: true, getClientRects: () => [] };
    const title = { ...turn("You said:"), matches: () => false };
    state.turns.push(bubble, hidden, title);
    route(location, "/c/real-chat");
  });
  const result = await page.send();
  assert.equal(result.conversationUrl, "https://chatgpt.com/c/real-chat");
  assert.equal((await page.inspect()).lastUserPrompt, "A precise prompt");
  assert.equal(page.state.clicks, 1);
  assert.equal(page.state.enters, 0);
});

test("older bubble markup uses the whitespace pre-wrap prompt", async () => {
  const page = submitFixture(({ state, location }) => {
    state.turns.push({ ...turn("A precise prompt… Show more"), matches: () => true, querySelector: selector => selector === '.whitespace-pre-wrap' ? { innerText: "A precise prompt" } : null });
    route(location, "/c/real-chat");
  });
  assert.equal((await page.send()).conversationUrl, "https://chatgpt.com/c/real-chat");
});

test("inspecting an empty home reports no visible prompt", async () => {
  const page = submitFixture(() => {});
  const info = await page.inspect();
  assert.equal(info.ok, true);
  assert.equal(info.userPromptCount, 0);
  assert.equal(info.lastUserPrompt, "");
});
