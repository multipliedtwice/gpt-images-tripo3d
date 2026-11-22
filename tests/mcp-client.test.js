import test from "node:test";
import assert from "node:assert/strict";
import { setupMCP } from "../mcp-client.js";

const eventSource = () => {
  const listeners = [];
  return { addListener: listener => listeners.push(listener), emit: (...args) => listeners.map(listener => listener(...args)) };
};
const element = () => ({
  checked: true, hidden: true, value: "", textContent: "", title: "", open: false, listeners: new Map(),
  addEventListener(type, listener) { this.listeners.set(type, listener); },
  async emit(type, event = {}) { return this.listeners.get(type)?.(event); },
  focus() { this.focused = true; }, select() { this.selected = true; }, contains() { return false; }
});
const flush = () => new Promise(resolve => setImmediate(resolve));
const setup = (t, saved = {}) => {
  const previous = new Map();
  const put = (key, value) => { if (!previous.has(key)) previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  t.after(async () => { await window.emit("pagehide"); for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  const elements = Object.fromEntries(["mcp-enabled", "mcp-status", "mcp-copy-claude", "mcp-copy-codex", "mcp-config"].map(id => [id, element()]));
  const menu = element(); menu.querySelector = () => element();
  const document = { getElementById: id => elements[id], querySelector: () => menu, addEventListener() {} };
  const window = element();
  const changed = eventSource();
  const storage = { ...saved };
  const chrome = {
    runtime: { id: "a".repeat(32), onInstalled: eventSource(), onStartup: eventSource(), getURL: path => `chrome-extension://${"a".repeat(32)}/${path}`, sendMessage: async () => {} },
    storage: { onChanged: changed, local: { get: async () => ({ ...storage }), set: async data => { const changes = {}; for (const [key, value] of Object.entries(data)) { changes[key] = { oldValue: storage[key], newValue: value }; storage[key] = value; } changed.emit(changes, "local"); } } },
    action: { onClicked: eventSource() }, alarms: { create() {}, onAlarm: eventSource() },
    tabs: { query: async () => [], create: async () => {}, update: async () => {} }
  };
  const calls = [];
  let online = true;
  const fetch = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, options });
    if (!online) throw new Error("Helper not running");
    if (path === "/poll") return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    return { ok: true, status: 200, json: async () => path === "/bootstrap" ? { token: "automatic-process-token", folder: null } : path === "/connect" ? { session: "session" } : {} };
  };
  const copied = [];
  put("document", document); put("window", window); put("chrome", chrome); put("fetch", fetch);
  put("navigator", { clipboard: { writeText: async value => copied.push(value) } });
  return { elements, storage, chrome, calls, copied, window, put, setOnline: value => { online = value; } };
};

test("automatic token exchange, persisted off, and immediate re-enable need no manual fields", async t => {
  const env = setup(t);
  const client = setupMCP({ execute: async () => {}, setFolder: async () => {} });
  await client.connect();
  assert.equal(env.elements["mcp-status"].textContent, "Local helper connected");
  assert.equal(env.calls.find(call => call.path === "/connect").options.headers.Authorization, "Bearer automatic-process-token");
  env.elements["mcp-enabled"].checked = false;
  await env.elements["mcp-enabled"].emit("change");
  assert.equal(env.storage.mcpEnabled, false);
  assert.equal(env.elements["mcp-status"].textContent, "Agent control off");
  const before = env.calls.length;
  await client.connect();
  assert.equal(env.calls.length, before);
  env.elements["mcp-enabled"].checked = true;
  await env.elements["mcp-enabled"].emit("change");
  await flush();
  assert.equal(env.elements["mcp-status"].textContent, "Local helper connected");
  const paths = env.calls.map(call => call.path);
  assert.ok(paths.indexOf("/disconnect") < paths.lastIndexOf("/connect"));
});

test("saved off prevents startup and failed discovery can retry", async t => {
  const env = setup(t, { mcpEnabled: false });
  const client = setupMCP({ execute: async () => {}, setFolder: async () => {} });
  await client.connect();
  assert.equal(env.calls.length, 0);
  env.setOnline(false);
  await env.chrome.storage.local.set({ mcpEnabled: true });
  await flush();
  assert.equal(env.elements["mcp-status"].textContent, "Waiting for local helper");
  env.setOnline(true);
  await client.connect();
  assert.equal(env.elements["mcp-status"].textContent, "Local helper connected");
});

test("client-specific copy templates include current extension ID and readable fallback", async t => {
  const env = setup(t);
  setupMCP({ execute: async () => {}, setFolder: async () => {} });
  await env.elements["mcp-copy-claude"].emit("click");
  const config = JSON.parse(env.copied[0]);
  assert.equal(config.mcpServers["image-runner"].env.RUNNER_EXTENSION_ID, env.chrome.runtime.id);
  assert.equal(Object.keys(config.mcpServers["image-runner"].env).length, 2);
  assert.match(config.mcpServers["image-runner"].args[0], /absolute\/path/);
  await env.elements["mcp-copy-codex"].emit("click");
  assert.match(env.copied[1], /^\[mcp_servers.image-runner\]/);
  assert.ok(env.copied[1].includes(`RUNNER_EXTENSION_ID = "${env.chrome.runtime.id}"`));
  assert.doesNotMatch(env.copied.join(""), /TOKEN|Bearer/);
  env.put("navigator", { clipboard: { writeText: async () => { throw new Error("Denied"); } } });
  await env.elements["mcp-copy-codex"].emit("click");
  assert.equal(env.elements["mcp-copy-codex"].textContent, "Copy Codex config");
  assert.equal(env.elements["mcp-config"].hidden, false);
  assert.equal(env.elements["mcp-config"].selected, true);
  assert.equal(env.elements["mcp-config"].value, env.copied[1]);
  await env.elements["mcp-copy-claude"].emit("click");
  assert.equal(env.elements["mcp-copy-claude"].textContent, "Copy Claude config");
  assert.equal(env.elements["mcp-config"].value, env.copied[0]);
});

test("background discovery stays off across startup and responds when enabled", async t => {
  const env = setup(t, { mcpEnabled: false });
  let opened = 0;
  env.chrome.tabs.create = async () => { opened++; };
  await import(`../background.js?test=${Date.now()}`);
  env.chrome.runtime.onStartup.emit();
  await flush();
  assert.equal(env.calls.length, 0);
  assert.equal(opened, 0);
  await env.chrome.storage.local.set({ mcpEnabled: true });
  await flush();
  assert.equal(opened, 1);
  assert.equal(env.calls[0].path, "/bootstrap");
});

test("hung helper startup is bounded and permits a later automatic attempt", async t => {
  const env = setup(t);
  const fetch = globalThis.fetch;
  const keepAlive = setTimeout(() => {}, 6000);
  t.after(() => clearTimeout(keepAlive));
  env.put("fetch", (url, options) => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("Timeout", "TimeoutError")), { once: true })));
  const client = setupMCP({ execute: async () => {}, setFolder: async () => {} });
  await client.connect();
  assert.equal(env.elements["mcp-status"].textContent, "Waiting for local helper");
  env.put("fetch", fetch);
  await client.connect();
  assert.equal(env.elements["mcp-status"].textContent, "Local helper connected");
});

test("failed preference save still disables this tab and reports persistence failure", async t => {
  const env = setup(t);
  const client = setupMCP({ execute: async () => {}, setFolder: async () => {} });
  await client.connect();
  env.chrome.storage.local.set = async () => { throw new Error("Storage unavailable"); };
  env.elements["mcp-enabled"].checked = false;
  await env.elements["mcp-enabled"].emit("change");
  assert.equal(env.elements["mcp-status"].textContent, "Agent control off");
  assert.match(env.elements["mcp-status"].title, /Preference not saved/);
  const before = env.calls.length;
  await client.connect();
  assert.equal(env.calls.length, before);
});

test("a dashboard without queue ownership cannot claim the helper session", async t => {
  const env = setup(t);
  let release;
  let owned = false;
  const ready = new Promise(resolve => { release = resolve; });
  const client = setupMCP({ execute: async () => {}, setFolder: async () => {}, waitUntilReady: async () => {
    await ready;
    if (!owned) throw new Error("Another control tab owns the GPT queue.");
  } });
  const connecting = client.connect();
  await flush();
  assert.equal(env.calls.length, 0);
  release();
  await connecting;
  assert.equal(env.calls.length, 0);
  assert.equal(env.elements["mcp-status"].textContent, "Agent control unavailable");
  assert.match(env.elements["mcp-status"].title, /Another control tab/);
  owned = true;
  await client.connect();
  assert.equal(env.calls.filter(call => call.path === "/connect").length, 1);
  assert.equal(env.elements["mcp-status"].textContent, "Local helper connected");
});
