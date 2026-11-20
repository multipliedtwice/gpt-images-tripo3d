import test from "node:test";
import assert from "node:assert/strict";
import { setupGPT } from "../gpt.js";

const chat = "https://chatgpt.com/c/saved-chat";
const element = () => ({
  textContent: "", value: "", children: [], listeners: new Map(),
  get childElementCount() { return this.children.length; },
  append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
  setAttribute() {}, addEventListener(type, action) { this.listeners.set(type, action); }, focus() {},
  querySelector() { return element(); }
});
const setup = async (t, { pending = false, unsafeAfterReceiverFailure = false, initialItems, permission = async () => {}, statusRead, noTabs = false, root = { name: "test-output" } } = {}) => {
  const saved = { gptQueue: { tabId: 1, items: [{ id: "prompt", prompt: "Generate a test image", status: pending ? "pending" : "submitted", conversationUrl: pending ? null : chat }] } };
  if (initialItems) saved.gptQueue.items = structuredClone(initialItems);
  let rejectStorage = false;
  let holdStorage = null;
  let holdRead = null;
  const pageHide = [];
  const heldLocks = new Set();
  const nodes = new Map();
  const globals = new Map();
  const put = (key, value) => { globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value }); };
  t.after(() => { for (const [key, descriptor] of globals) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  const tabs = new Map([[1, { id: 1, url: pending ? "https://chatgpt.com/" : chat, status: "complete", title: "ChatGPT" }]]);
  if (noTabs) tabs.clear();
  let nextTabId = 2;
  const perTabStatus = new Map();
  let statusCalls = 0;
  let submits = 0;
  let injections = 0;
  let switched = false;
  put("document", { getElementById: id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }, createElement: element });
  put("addEventListener", (name, callback) => { if (name === "pagehide") pageHide.push(callback); });
  const hide = async () => { for (const callback of pageHide.splice(0)) callback(); await new Promise(resolve => setImmediate(resolve)); };
  t.after(hide);
  put("navigator", { locks: { request: async (name, options, action) => {
    if (heldLocks.has(name)) return action(null);
    heldLocks.add(name);
    try { return await action({ name }); } finally { heldLocks.delete(name); }
  } } });
  put("chrome", {
    storage: { local: { get: async () => { if (holdRead) await holdRead; return structuredClone(saved); }, set: async data => { if (rejectStorage) throw new Error("Storage unavailable"); if (holdStorage) await holdStorage; Object.assign(saved, structuredClone(data)); } } },
    scripting: { executeScript: async () => { injections++; } },
    tabs: {
      query: async () => [...tabs.values()].map(tab => ({ ...tab })),
      create: async data => { const tab = { id: nextTabId++, url: data.url, status: "complete", title: "ChatGPT" }; tabs.set(tab.id, tab); return { ...tab }; },
      remove: async id => { tabs.delete(id); },
      update: async (id, data) => { Object.assign(tabs.get(id), data); },
      get: async id => { if (!tabs.has(id)) throw new Error("No tab found"); return { ...tabs.get(id), ...(switched ? { url: "https://example.com/" } : {}) }; },
      sendMessage: async (id, message) => {
        const tab = tabs.get(id);
        if (message.type === "gpt:inspect") return { ok: true, composer: true, turns: tab.url === "https://chatgpt.com/" ? 0 : 1 };
        if (message.type === "gpt:submit") { submits++; tab.url = id === 1 ? chat : `https://chatgpt.com/c/chat-${id}`; return { ok: true, conversationUrl: tab.url }; }
        if (message.type === "gpt:status") {
          statusCalls++;
          perTabStatus.set(id, (perTabStatus.get(id) || 0) + 1);
          if (statusRead) return statusRead(id, perTabStatus.get(id), tab);
          if (unsafeAfterReceiverFailure) { switched = true; throw new Error("Receiving end does not exist."); }
          if (statusCalls === 1) throw Object.assign(new Error("Temporary status failure"), { code: "GPT_TIMEOUT" });
          return { ok: true, state: "failed", code: "GPT_LIMIT", detail: "Image limit reached", conversationUrl: chat };
        }
        if (message.type === "gpt:image") return { ok: true, base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, id]).toString("base64") };
        throw new Error(`Unexpected action: ${message.type}`);
      }
    }
  });
  let queueCreated = false;
  const createQueue = async ({ close = true } = {}) => {
    if (queueCreated && close) await hide();
    queueCreated = true;
    const queue = setupGPT({ getRoot: () => root, ensurePermission: permission, onSaved: async () => {} });
    await queue.ready;
    return queue;
  };
  const queue = await createQueue();
  const idle = async () => { const deadline = Date.now() + 12000; while (queue.busy()) { if (Date.now() >= deadline) throw new Error("Runner did not pause"); await new Promise(resolve => setTimeout(resolve, 10)); } };
  return { queue, idle, saved, createQueue, nodes, tabs, hide, createBlockedQueue: () => setupGPT({ getRoot: () => root, ensurePermission: permission, onSaved: async () => {} }), holdRead: value => { holdRead = value; }, holdStorage: value => { holdStorage = value; }, failStorage: value => { rejectStorage = value; }, counts: () => ({ submits, statusCalls, injections }) };
};

test("status retries and usage-limit resume preserve one submitted prompt", async t => {
  const fixture = await setup(t, { pending: true });
  await fixture.queue.startRemote(); await fixture.idle();
  assert.equal(fixture.counts().submits, 1);
  assert.equal(fixture.counts().statusCalls, 2);
  assert.equal(fixture.saved.gptQueue.items[0].status, "submitted");
  assert.equal(fixture.saved.gptQueue.items[0].conversationUrl, chat);
  assert.equal(fixture.saved.gptQueue.items[0].code, "GPT_LIMIT");
  await fixture.queue.startRemote(); await fixture.idle();
  assert.equal(fixture.counts().submits, 1);
  assert.equal(fixture.counts().statusCalls, 3);
  assert.equal(fixture.saved.gptQueue.items[0].status, "submitted");
});

test("missing-receiver recovery never injects after the tab leaves ChatGPT", async t => {
  const fixture = await setup(t, { unsafeAfterReceiverFailure: true });
  await fixture.queue.startRemote(); await fixture.idle();
  assert.deepEqual(fixture.counts(), { submits: 0, statusCalls: 1, injections: 0 });
  assert.equal(fixture.saved.gptQueue.items[0].code, "GPT_WRONG_TAB");
  assert.equal(fixture.saved.gptQueue.items[0].conversationUrl, chat);
  assert.equal(fixture.saved.gptQueue.items[0].status, "submitted");
});


test("concurrent request batches keep stable identities and isolated status", async t => {
  const fixture = await setup(t, { initialItems: [] });
  const [first, second, replay] = await Promise.all([
    fixture.queue.addPrompts(["Bird", "Tree"], "chat-a"),
    fixture.queue.addPrompts(["House"], "chat-b"),
    fixture.queue.addPrompts(["Bird", "Tree"], "chat-a")
  ]);
  assert.deepEqual(replay.added, first.added);
  assert.equal(replay.reused, true);
  assert.equal(first.reused, false);
  assert.equal(new Set([...first.added, ...second.added]).size, 3);
  const own = fixture.queue.snapshot(1, 1, "chat-a");
  assert.equal(own.itemCount, 2);
  assert.equal(own.totalItemCount, 3);
  assert.equal(own.items[0].id, first.added[1]);
  assert.equal(own.items[0].requestId, "chat-a");
  assert.equal(own.request.known, true);
  assert.equal(fixture.queue.snapshot(0, 25, "missing").request.known, false);
  await assert.rejects(fixture.queue.addPrompts(["Bird", "Tree "], "chat-a"), /different prompts/);
  assert.equal(fixture.saved.gptQueue.items.length, 3);
  assert.equal(fixture.saved.gptQueue.requests.length, 2);
  assert.equal(fixture.counts().submits, 0);
});

test("request receipts survive removal, scoped clear and reload without recreating work", async t => {
  const fixture = await setup(t, { initialItems: [] });
  const first = await fixture.queue.addPrompts(["Bird"], "chat-a");
  const second = await fixture.queue.addPrompts(["Tree"], "chat-b");
  await assert.rejects(fixture.queue.promptAction(second.added[0], "remove", "chat-a"), /not found in this request/);
  await fixture.queue.promptAction(first.added[0], "remove", "chat-a");
  const absent = fixture.queue.snapshot(0, 25, "chat-a");
  assert.equal(absent.request.known, true);
  assert.deepEqual(absent.request.missingItemIds, first.added);
  assert.equal(absent.itemCount, 0);
  const replay = await fixture.queue.addPrompts(["Bird"], "chat-a");
  assert.equal(replay.reused, true);
  assert.equal(fixture.queue.snapshot().itemCount, 1);
  fixture.saved.gptQueue.items[0] = { ...fixture.saved.gptQueue.items[0], status: "saved", fileName: "tree.png", conversationUrl: chat };
  fixture.saved.gptQueue.items.push({ id: "other", requestId: "chat-c", prompt: "Other", status: "failed" });
  const reloaded = await fixture.createQueue();
  assert.equal(reloaded.snapshot(0, 25, "chat-b").items[0].fileName, "tree.png");
  assert.equal(reloaded.snapshot(0, 25, "chat-b").items[0].conversationUrl, chat);
  await reloaded.clearFinished("chat-b");
  assert.deepEqual(reloaded.snapshot().items.map(item => item.id), ["other"]);
  const again = await fixture.createQueue();
  assert.deepEqual((await again.addPrompts(["Tree"], "chat-b")).added, second.added);
  assert.deepEqual(again.snapshot(0, 25, "chat-b").request.missingItemIds, second.added);
  assert.equal(again.snapshot().itemCount, 1);
  assert.equal(fixture.counts().submits, 0);
});

test("failed durable changes leave memory and storage consistent and allow safe retry", async t => {
  const fixture = await setup(t, { initialItems: [] });
  fixture.failStorage(true);
  await assert.rejects(fixture.queue.addPrompts(["Bird"], "chat-a"), /Storage unavailable/);
  assert.equal(fixture.queue.snapshot().itemCount, 0);
  assert.equal(fixture.queue.snapshot(0, 25, "chat-a").request.known, false);
  assert.equal(fixture.saved.gptQueue.items.length, 0);
  fixture.failStorage(false);
  const added = await fixture.queue.addPrompts(["Bird"], "chat-a");
  fixture.failStorage(true);
  await assert.rejects(fixture.queue.promptAction(added.added[0], "remove", "chat-a"), /Storage unavailable/);
  assert.equal(fixture.queue.snapshot().itemCount, 1);
  assert.equal(fixture.saved.gptQueue.items.length, 1);
  fixture.failStorage(false);
  assert.equal((await fixture.queue.addPrompts(["Bird"], "chat-a")).reused, true);
  assert.equal(fixture.queue.snapshot().itemCount, 1);
});

test("simultaneous starts share startup and report active stop state without duplicate submission", async t => {
  let releasePermission;
  const permission = new Promise(resolve => { releasePermission = resolve; });
  const fixture = await setup(t, { pending: true, permission: () => permission });
  const first = fixture.queue.startRemote();
  const second = fixture.queue.startRemote();
  assert.equal(first, second);
  releasePermission();
  assert.equal((await first).accepted, true);
  assert.equal((await second).alreadyRunning, false);
  assert.equal((await fixture.queue.startRemote()).alreadyRunning, true);
  fixture.queue.stop();
  const stopping = await fixture.queue.startRemote();
  assert.equal(stopping.alreadyRunning, true);
  assert.equal(stopping.stopRequested, true);
  await fixture.idle();
  assert.equal(fixture.counts().submits, 1);
});


test("parallel startup callers share a permission failure without reporting acceptance", async t => {
  let rejectPermission;
  const permission = new Promise((resolve, reject) => { rejectPermission = reject; });
  const fixture = await setup(t, { pending: true, permission: () => permission });
  const first = fixture.queue.startRemote();
  const second = fixture.queue.startRemote();
  assert.equal(first, second);
  const results = Promise.allSettled([first, second]);
  rejectPermission(new Error("Folder permission denied"));
  assert.ok((await results).every(result => result.status === "rejected" && /permission denied/.test(result.reason.message)));
  assert.equal(fixture.queue.busy(), false);
  assert.equal(fixture.counts().submits, 0);
});


const waitUntil = async predicate => {
  const deadline = Date.now() + 12000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Expected queue state did not arrive");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const memoryFolder = () => {
  const files = new Map();
  return {
    name: "test-output", files,
    async *entries() { for (const [name] of files) yield [name, { kind: "file" }]; },
    async getDirectoryHandle() { throw Object.assign(new Error("Missing"), { name: "NotFoundError" }); },
    async getFileHandle(name, options = {}) {
      if (!files.has(name) && !options.create) throw Object.assign(new Error("Missing"), { name: "NotFoundError" });
      return {
        getFile: async () => ({ size: files.get(name)?.size || 0 }),
        createWritable: async () => {
          let bytes;
          return { write: async blob => { bytes = blob; }, close: async () => { files.set(name, bytes); }, abort: async () => {} };
        }
      };
    }
  };
};

test("separate request tabs submit concurrently, stop independently and reserve distinct image files", async t => {
  const gate = deferred();
  const waitingTabs = new Set();
  const root = memoryFolder();
  const permissionModes = [];
  const fixture = await setup(t, { initialItems: [], root, permission: async remote => { permissionModes.push(remote); }, statusRead: async (id, count, tab) => {
    waitingTabs.add(id);
    await gate.promise;
    return { ok: true, state: "ready", src: `image-${id}`, conversationUrl: tab.url };
  } });
  await fixture.queue.addPrompts(["Same bird", "Later bird"], "chat-a");
  await fixture.queue.addPrompts(["Same bird"], "chat-b");
  const [first, second] = await Promise.all([fixture.queue.startRemote("chat-a"), fixture.queue.startRemote("chat-b")]);
  assert.notEqual(first.tabId, second.tabId);
  assert.deepEqual(permissionModes, [true, true]);
  await waitUntil(() => waitingTabs.size === 2);
  assert.equal(fixture.counts().submits, 2);
  assert.equal(root.files.size, 0);
  assert.equal(fixture.queue.snapshot(0, 25, "chat-a").running, true);
  assert.equal(fixture.queue.snapshot(0, 25, "chat-b").running, true);
  assert.match(fixture.nodes.get("gpt-title").textContent, /2 requests running/);
  fixture.queue.stop("chat-a");
  assert.equal(fixture.queue.snapshot(0, 25, "chat-a").stopRequested, true);
  assert.equal(fixture.queue.snapshot(0, 25, "chat-b").stopRequested, false);
  assert.equal((await fixture.queue.startRemote("chat-a")).alreadyRunning, true);
  gate.resolve();
  await fixture.idle();
  const ownA = fixture.queue.snapshot(0, 25, "chat-a");
  const ownB = fixture.queue.snapshot(0, 25, "chat-b");
  assert.equal(ownA.items[0].status, "saved");
  assert.equal(ownA.items[1].status, "pending");
  assert.equal(ownB.items[0].status, "saved");
  assert.notEqual(ownA.items[0].fileName, ownB.items[0].fileName);
  assert.equal(root.files.size, 2);
  assert.equal(new Uint8Array(await root.files.get(ownA.items[0].fileName).arrayBuffer())[4], first.tabId);
  assert.equal(new Uint8Array(await root.files.get(ownB.items[0].fileName).arrayBuffer())[4], second.tabId);
  assert.equal(ownA.items[0].conversationUrl, `https://chatgpt.com/c/chat-${first.tabId}`);
  assert.equal(ownB.items[0].conversationUrl, `https://chatgpt.com/c/chat-${second.tabId}`);
  assert.equal(fixture.counts().submits, 2);
  assert.ok(fixture.saved.gptQueue.requests.every(request => /^[0-9a-f]{64}$/.test(request.digest) && !Object.hasOwn(request, "prompts")));
});

test("paused requests resume their own saved conversations after reload without another submission", async t => {
  let ready = false;
  const seen = [];
  const fixture = await setup(t, { initialItems: [], root: memoryFolder(), statusRead: async (id, count, tab) => {
    seen.push({ id, url: tab.url });
    return ready ? { ok: true, state: "ready", src: `image-${id}`, conversationUrl: tab.url } : { ok: true, state: "failed", code: "GPT_LIMIT", detail: "Image limit reached", conversationUrl: tab.url };
  } });
  await fixture.queue.addPrompts(["Bird A"], "chat-a");
  await fixture.queue.addPrompts(["Bird B"], "chat-b");
  const [first, second] = await Promise.all([fixture.queue.startRemote("chat-a"), fixture.queue.startRemote("chat-b")]);
  await fixture.idle();
  assert.equal(fixture.counts().submits, 2);
  const firstURL = fixture.queue.snapshot(0, 25, "chat-a").items[0].conversationUrl;
  const secondURL = fixture.queue.snapshot(0, 25, "chat-b").items[0].conversationUrl;
  const reloaded = await fixture.createQueue();
  assert.equal(reloaded.snapshot(0, 25, "chat-a").tabId, first.tabId);
  assert.equal(reloaded.snapshot(0, 25, "chat-b").tabId, second.tabId);
  fixture.tabs.get(first.tabId).url = "https://chatgpt.com/";
  fixture.tabs.delete(second.tabId);
  ready = true;
  const resumed = await Promise.all([reloaded.startRemote("chat-a"), reloaded.startRemote("chat-b")]);
  await waitUntil(() => !reloaded.busy());
  assert.equal(fixture.counts().submits, 2);
  assert.equal(resumed[0].tabId, first.tabId);
  assert.notEqual(resumed[1].tabId, second.tabId);
  assert.equal(reloaded.snapshot(0, 25, "chat-a").items[0].conversationUrl, firstURL);
  assert.equal(reloaded.snapshot(0, 25, "chat-b").items[0].conversationUrl, secondURL);
  assert.ok(seen.some(entry => entry.id === resumed[0].tabId && entry.url === firstURL));
  assert.ok(seen.some(entry => entry.id === resumed[1].tabId && entry.url === secondURL));
  assert.equal(reloaded.snapshot().items.filter(item => item.status === "saved").length, 2);
});

test("a paused request does not stop another worker or allow cross-request mutation", async t => {
  const gate = deferred();
  let secondTab;
  const fixture = await setup(t, { initialItems: [], statusRead: async (id, count, tab) => {
    if (id === secondTab) await gate.promise;
    return { ok: true, state: "failed", code: "GPT_LIMIT", detail: `Limit in ${id}`, conversationUrl: tab.url };
  } });
  const firstItems = await fixture.queue.addPrompts(["Bird A"], "chat-a");
  const secondItems = await fixture.queue.addPrompts(["Bird B"], "chat-b");
  await fixture.queue.startRemote("chat-a");
  secondTab = (await fixture.queue.startRemote("chat-b")).tabId;
  await waitUntil(() => !fixture.queue.snapshot(0, 25, "chat-a").running && fixture.queue.snapshot(0, 25, "chat-b").running);
  assert.equal(fixture.queue.busy(), true);
  assert.equal(fixture.nodes.get("gpt-badge").textContent, "RUNNING");
  assert.match(fixture.queue.snapshot(0, 25, "chat-a").detail, /Limit in/);
  await fixture.queue.promptAction(firstItems.added[0], "remove", "chat-a");
  await assert.rejects(fixture.queue.promptAction(secondItems.added[0], "remove", "chat-a"), /not found/);
  await assert.rejects(fixture.queue.clearFinished("chat-b"), /busy/);
  gate.resolve();
  await fixture.idle();
  assert.equal(fixture.queue.snapshot(0, 25, "chat-b").items[0].code, "GPT_LIMIT");
});

test("a second controller cannot overwrite persisted queues or change browser tabs", async t => {
  const fixture = await setup(t, { initialItems: [] });
  await fixture.queue.addPrompts(["Bird"], "chat-a");
  const original = structuredClone(fixture.saved);
  const blocked = fixture.createBlockedQueue();
  await assert.rejects(blocked.ready, /Another control tab owns/);
  await assert.rejects(blocked.addPrompts(["Other"], "chat-b"), /Another control tab owns/);
  await assert.rejects(blocked.clearFinished(), /Another control tab owns/);
  await assert.rejects(blocked.openTab(), /Another control tab owns/);
  await assert.rejects(blocked.selectTab(1), /Another control tab owns/);
  assert.deepEqual(fixture.saved, original);
  assert.equal(fixture.tabs.size, 1);
});

test("startup drains a pending durable removal before choosing work", async t => {
  const fixture = await setup(t, { initialItems: [] });
  const added = await fixture.queue.addPrompts(["Bird"], "chat-a");
  const gate = deferred();
  fixture.holdStorage(gate.promise);
  const removal = fixture.queue.promptAction(added.added[0], "remove", "chat-a");
  await new Promise(resolve => setImmediate(resolve));
  const starting = fixture.queue.startRemote("chat-a");
  const rejected = assert.rejects(starting, /No GPT prompts/);
  gate.resolve();
  await removal;
  await rejected;
  assert.equal(fixture.queue.snapshot(0, 25, "chat-a").itemCount, 0);
  assert.equal(fixture.counts().submits, 0);
});


test("early enqueue waits for stored state instead of overwriting existing batches", async t => {
  const fixture = await setup(t, { initialItems: [] });
  const first = await fixture.queue.addPrompts(["Bird"], "chat-a");
  await fixture.hide();
  const gate = deferred();
  fixture.holdRead(gate.promise);
  const reloaded = fixture.createBlockedQueue();
  const pending = reloaded.addPrompts(["Tree"], "chat-b");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.saved.gptQueue.items.length, 1);
  gate.resolve();
  await reloaded.ready;
  await pending;
  assert.equal(reloaded.snapshot().itemCount, 2);
  assert.equal(reloaded.snapshot(0, 25, "chat-a").items[0].id, first.added[0]);
  assert.equal(fixture.saved.gptQueue.requests.length, 2);
});

test("Start prompts in the dashboard starts scoped requests without a manual selected tab", async t => {
  const permissionModes = [];
  const fixture = await setup(t, { initialItems: [], noTabs: true, permission: async remote => { permissionModes.push(remote); }, statusRead: async (id, count, tab) => ({ ok: true, state: "failed", code: "GPT_LIMIT", detail: "Image limit", conversationUrl: tab.url }) });
  await fixture.queue.addPrompts(["Bird"], "chat-a");
  await fixture.queue.addPrompts(["Tree"], "chat-b");
  assert.equal(fixture.nodes.get("gpt-start").disabled, false);
  await fixture.nodes.get("gpt-start").listeners.get("click")();
  assert.deepEqual(permissionModes, [false, false]);
  await fixture.idle();
  assert.equal(fixture.counts().submits, 2);
  assert.notEqual(fixture.queue.snapshot(0, 25, "chat-a").tabId, fixture.queue.snapshot(0, 25, "chat-b").tabId);
});
