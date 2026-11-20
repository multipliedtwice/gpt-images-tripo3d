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
