import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { createInterface } from "node:readline";

const availablePort = async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
};
test("real stdio server negotiates, lists, validates and shuts down on stdin EOF", async t => {
  const port = await availablePort();
  const child = spawn(process.execPath, ["mcp/server.js"], { cwd: new URL("..", import.meta.url), env: { ...process.env, RUNNER_MCP_PORT: String(port), RUNNER_EXTENSION_ID: "a".repeat(32), RUNNER_MCP_TOKEN: "testing-abcdefghijklmnopqrstuvwxyz" }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const responses = [];
  const waiting = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    const value = JSON.parse(line);
    responses.push(value);
    const resolve = waiting.get(value.id);
    if (resolve) { waiting.delete(value.id); resolve(value); }
  });
  const call = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No response for ${method}`)), 4000);
    waiting.set(id, value => { clearTimeout(timer); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  assert.equal((await call(1, "tools/list")).error.code, -32002);
  const init = await call(2, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  const tools = await call(3, "tools/list");
  assert.ok(tools.result.tools.some(tool => tool.name === "runner_add_prompts"));
  assert.equal((await call(4, "tools/call", { name: "runner_settings", arguments: { limit: -1 } })).result.isError, true);
  assert.equal((await call(5, "tools/call", { name: "runner_status", arguments: {} })).result.isError, true);
  assert.deepEqual((await call(6, "ping")).result, {});
  assert.equal((await call(7, "unknown")).error.code, -32601);
  assert.ok(responses.every(response => response.jsonrpc === "2.0"));
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.stdin.end();
  assert.equal(await exited, 0);
});

const extensionId = 'a'.repeat(32);
const token = 'testing-abcdefghijklmnopqrstuvwxyz';
const initParams = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } };
const client = (t, port, extra = {}) => {
  const child = spawn(process.execPath, ['mcp/server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, RUNNER_MCP_PORT: String(port), RUNNER_EXTENSION_ID: extensionId, RUNNER_MCP_TOKEN: token, RUNNER_OUTPUT_DIR: '', ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});
  const exited = new Promise(resolve => child.once('exit', resolve));
  createInterface({ input: child.stdout }).on('line', line => {
    const response = JSON.parse(line);
    const item = waiting.get(response.id);
    if (item) { waiting.delete(response.id); clearTimeout(item.timer); item.resolve(response); }
  });
  t.after(async () => { if (child.exitCode === null) { child.stdin.end(); await exited; } });
  const raw = (id, line) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`No stdio response: ${stderr}`)); }, 6000);
    waiting.set(id, { resolve, timer });
    child.stdin.write(line + '\n');
  });
  const call = (id, method, params) => raw(id, JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  return { child, call, raw, exited, error: () => stderr, stop: async () => { child.stdin.end(); return exited; }, initialize: () => call('init', 'initialize', initParams) };
};
const dashboard = port => {
  const url = `http://127.0.0.1:${port}`;
  const headers = { Origin: `chrome-extension://${extensionId}`, 'X-Runner-Extension-ID': extensionId, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  return { url, headers, request: (path, data = {}) => fetch(url + path, { method: 'POST', headers, body: JSON.stringify(data) }) };
};
const waitClosed = async port => {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const open = await new Promise(resolve => { const socket = net.createConnection({ port, host: '127.0.0.1' }); socket.on('connect', () => { socket.destroy(); resolve(true); }); socket.on('error', () => resolve(false)); });
    if (!open) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Task broker did not stop after its last client and dashboard disconnected.');
};

test('simultaneous stdio clients share one broker, isolate colliding IDs and survive another client exit', async t => {
  const port = await availablePort();
  const first = client(t, port);
  const second = client(t, port);
  const third = client(t, port);
  const initialized = await Promise.all([first.initialize(), second.initialize(), third.initialize()]);
  assert.ok(initialized.every(response => response.result.protocolVersion === '2025-06-18'));
  const page = dashboard(port);
  const { session } = await (await page.request('/connect')).json();
  t.after(async () => { await page.request('/disconnect', { session }).catch(() => {}); await waitClosed(port); });
  const result1 = first.call(42, 'tools/call', { name: 'runner_settings', arguments: { limit: 11 } });
  const result2 = second.call(42, 'tools/call', { name: 'runner_settings', arguments: { limit: 22 } });
  const commands = [
    (await (await page.request('/poll', { session })).json()).command,
    (await (await page.request('/poll', { session })).json()).command
  ];
  assert.notEqual(commands[0].id, commands[1].id);
  for (const command of commands.toReversed()) await page.request('/result', { session, id: command.id, result: { command: command.id, limit: command.args.limit } });
  const answers = await Promise.all([result1, result2]);
  assert.ok(answers.every(answer => answer.id === 42 && !answer.result.isError));
  assert.deepEqual(new Set(answers.map(answer => JSON.parse(answer.result.content[0].text).command)), new Set(commands.map(command => command.id)));
  assert.deepEqual(answers.map(answer => JSON.parse(answer.result.content[0].text).limit), [11, 22]);
  const remaining = second.call(43, 'tools/call', { name: 'runner_status', arguments: {} });
  assert.equal(await first.stop(), 0);
  const { command } = await (await page.request('/poll', { session })).json();
  await page.request('/result', { session, id: command.id, result: { survived: true } });
  assert.deepEqual(JSON.parse((await remaining).result.content[0].text), { survived: true });
  assert.deepEqual((await third.call(43, 'ping')).result, {});
  await Promise.all([second.stop(), third.stop()]);
});

test('last stdio departure preserves a connected dashboard and configured folder service', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const folder = await mkdtemp(join(tmpdir(), 'runner-broker-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const port = await availablePort();
  const first = client(t, port, { RUNNER_OUTPUT_DIR: folder });
  await first.initialize();
  const page = dashboard(port);
  const { session } = await (await page.request('/connect')).json();
  t.after(async () => { await page.request('/disconnect', { session }).catch(() => {}); await waitClosed(port); });
  assert.equal(await first.stop(), 0);
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal((await fetch(page.url + '/bootstrap', { headers: page.headers })).status, 200);
  const root = await page.request('/fs/op', { op: 'entries', path: '' });
  assert.equal(root.status, 200);
  const replacement = client(t, port, { RUNNER_OUTPUT_DIR: folder });
  await replacement.initialize();
  assert.deepEqual((await replacement.call(1, 'ping')).result, {});
  await replacement.stop();
});

test('existing broker rejects extension, folder and explicit-token configuration mismatches', async t => {
  const port = await availablePort();
  const first = client(t, port); await first.initialize();
  t.after(() => waitClosed(port));
  const { realpath } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const differentFolder = await realpath(tmpdir());
  for (const settings of [{ RUNNER_EXTENSION_ID: 'b'.repeat(32) }, { RUNNER_OUTPUT_DIR: differentFolder }, { RUNNER_MCP_TOKEN: 'different-token-abcdefghijklmnopqrstuvwxyz' }]) {
    const incompatible = client(t, port, settings);
    assert.equal(await incompatible.exited, 1);
    assert.match(incompatible.error(), /configuration mismatch.*Use the same extension.*RUNNER_OUTPUT_DIR.*RUNNER_MCP_PORT/);
  }
  assert.deepEqual((await first.call(1, 'ping')).result, {});
  await first.stop();
});

test('malformed stdio and broker requests and timed-out work never replay mutations', async t => {
  const { createBroker, brokerConfig } = await import('../mcp/broker.js');
  const port = await availablePort();
  const broker = await createBroker(await brokerConfig({ RUNNER_MCP_PORT: String(port), RUNNER_EXTENSION_ID: extensionId, RUNNER_MCP_TOKEN: token }), { timeout: 40 });
  t.after(() => broker.close());
  const first = client(t, port); await first.initialize();
  assert.equal((await first.raw(null, '{')).error.code, -32700);
  assert.equal((await first.raw(null, '[]')).error.code, -32600);
  const page = dashboard(port);
  const { session } = await (await page.request('/connect')).json();
  const result = first.call(2, 'tools/call', { name: 'runner_start', arguments: { queue: 'gpt' } });
  const { command } = await (await page.request('/poll', { session })).json();
  const expired = await result;
  assert.equal(expired.result.isError, true);
  assert.match(expired.result.content[0].text, /timed out.*uncertain/);
  assert.equal((await page.request('/result', { session, id: command.id, result: {} })).status, 404);
  const socket = net.createConnection(broker.socketPath);
  await new Promise(resolve => socket.once('connect', resolve));
  const disconnected = new Promise(resolve => socket.once('close', resolve));
  socket.resume();
  socket.write('{\n');
  await disconnected;
  assert.deepEqual((await first.call(3, 'ping')).result, {});
  await first.stop();
  await page.request('/disconnect', { session });
});
