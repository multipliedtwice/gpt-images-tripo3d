import test from "node:test";
import assert from "node:assert/strict";
import { createBridge } from "../mcp/bridge.js";

const token = "test-token-abcdefghijklmnopqrstuvwxyz";
const extensionId = "a".repeat(32);
const origin = `chrome-extension://${extensionId}`;
const setup = async (t, options = {}) => {
  const bridge = await createBridge({ port: 0, token, extensionId, ...options });
  t.after(() => bridge.close());
  const url = `http://127.0.0.1:${bridge.port}`;
  const request = (path, data = {}, extraHeaders = {}) => fetch(url + path, { method: "POST", headers: { Origin: origin, "X-Runner-Extension-ID": extensionId, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extraHeaders }, body: JSON.stringify(data) });
  return { bridge, url, request };
};
test("bootstrap only releases configuration to exact extension origin", async t => {
  const { url, request } = await setup(t);
  assert.equal((await fetch(`${url}/bootstrap`)).status, 403);
  assert.equal((await fetch(`${url}/bootstrap`, { headers: { Origin: "https://evil.example" } })).status, 403);
  const response = await fetch(`${url}/bootstrap`, { headers: { Origin: origin, "X-Runner-Extension-ID": extensionId } });
  assert.equal(response.status, 200);
  assert.equal((await fetch(`${url}/bootstrap`, { headers: { "X-Runner-Extension-ID": extensionId } })).status, 200);
  assert.equal((await fetch(`${url}/bootstrap`, { headers: { Origin: "https://evil.example", "X-Runner-Extension-ID": extensionId } })).status, 403);
  assert.equal((await response.json()).token, token);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
  assert.equal((await request("/connect", {}, { Authorization: "Bearer incorrect" })).status, 401);
  const preflight = await fetch(`${url}/connect`, { method: "OPTIONS", headers: { Origin: origin, "X-Runner-Extension-ID": extensionId } });
  assert.equal(preflight.status, 204);
});
test("bridge delivers command once and accepts corresponding result", async t => {
  const { bridge, request } = await setup(t);
  const { session } = await (await request("/connect")).json();
  assert.equal((await request("/connect")).status, 409);
  const pending = bridge.call("runner_status", {});
  const { command } = await (await request("/poll", { session })).json();
  assert.equal(command.name, "runner_status");
  assert.equal((await request("/result", { session, id: command.id, result: { running: false } })).status, 200);
  assert.deepEqual(await pending, { running: false });
  assert.equal((await request("/result", { session, id: command.id, result: {} })).status, 404);
});
test("timed out queued mutation is removed and never delivered", async t => {
  const { bridge, request } = await setup(t, { timeout: 30, pollTime: 20 });
  const { session } = await (await request("/connect")).json();
  await assert.rejects(bridge.call("runner_start", { queue: "gpt" }), /timed out/);
  assert.deepEqual(await (await request("/poll", { session })).json(), {});
});
test("disconnect rejects pending command and permits fresh owner", async t => {
  const { bridge, request } = await setup(t);
  await assert.rejects(bridge.call("runner_status", {}), /Start the local MCP helper/);
  const { session } = await (await request("/connect")).json();
  const pending = assert.rejects(bridge.call("runner_start", { queue: "gpt" }), /uncertain/);
  await request("/disconnect", { session });
  await pending;
  assert.equal((await request("/poll", { session })).status, 409);
  assert.equal((await request("/connect")).status, 200);
});
test("malformed requests and wrong methods fail without changing ownership", async t => {
  const { url, request } = await setup(t);
  assert.equal((await fetch(url + "/connect", { method: "POST", headers: { Origin: origin, "X-Runner-Extension-ID": extensionId, Authorization: `Bearer ${token}` }, body: "{" })).status, 400);
  assert.equal((await request("/poll", { session: "wrong" })).status, 409);
  assert.equal((await fetch(url + "/connect", { headers: { Origin: origin, "X-Runner-Extension-ID": extensionId, Authorization: `Bearer ${token}` } })).status, 405);
});
test("abandoned dashboard lease expires and rejects uncertain work", async t => {
  const { bridge, request } = await setup(t, { leaseTime: 30 });
  const { session } = await (await request("/connect")).json();
  await assert.rejects(bridge.call("runner_start", { queue: "gpt" }), /lease expired/);
  assert.equal((await request("/poll", { session })).status, 409);
  assert.equal((await request("/connect")).status, 200);
});
test("disconnect releases waiting poll", async t => {
  const { request } = await setup(t);
  const { session } = await (await request("/connect")).json();
  const poll = request("/poll", { session });
  await new Promise(resolve => setTimeout(resolve, 10));
  await request("/disconnect", { session });
  assert.deepEqual(await (await poll).json(), { disconnected: true });
});
test("disconnecting one caller cancels its queued command while retaining delivered work and other callers", async t => {
  const { bridge, request } = await setup(t, { pollTime: 20 });
  const { session } = await (await request('/connect')).json();
  const first = Symbol('first');
  const second = Symbol('second');
  const delivered = assert.rejects(bridge.call('runner_start', { queue: 'gpt' }, first), /uncertain/);
  const { command } = await (await request('/poll', { session })).json();
  const queued = assert.rejects(bridge.call('runner_stop', { queue: 'gpt' }, first), /uncertain/);
  const surviving = bridge.call('runner_status', {}, second);
  bridge.cancelOwner(first);
  await Promise.all([delivered, queued]);
  assert.equal((await request('/result', { session, id: command.id, result: { accepted: true } })).status, 200);
  const next = await (await request('/poll', { session })).json();
  assert.equal(next.command.name, 'runner_status');
  await request('/result', { session, id: next.command.id, result: { running: true } });
  assert.deepEqual(await surviving, { running: true });
  assert.deepEqual(await (await request('/poll', { session })).json(), {});
});
