import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";

const MAX_BYTES = 4 * 1024 * 1024;
export const createBridge = async ({ port = 17321, token, extensionId, timeout = 15000, pollTime = 20000, leaseTime = 60000, folder = null, onSessionChange = () => {} }) => {
  if (typeof token !== "string" || token.length < 32) throw new Error("RUNNER_MCP_TOKEN must contain at least 32 characters.");
  if (!/^[a-p]{32}$/.test(extensionId || "")) throw new Error("RUNNER_EXTENSION_ID must be the extension ID from chrome://extensions.");
  const origin = `chrome-extension://${extensionId}`;
  let session = null;
  let lease = null;
  const heartbeat = () => { clearTimeout(lease); lease = setTimeout(() => reset("Dashboard lease expired; inspect state before retrying."), leaseTime); lease.unref(); };
  let poll = null;
  const pending = new Map();
  const answer = (res, status, value) => {
    if (res.destroyed || res.writableEnded) return;
    let body = JSON.stringify(value);
    if (Buffer.byteLength(body) > MAX_BYTES) { status = 413; body = JSON.stringify({ error: "Response too large. Reduce queue size." }); }
    res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": origin, "Vary": "Origin", "Cache-Control": "no-store" });
    res.end(body);
  };
  const finishPoll = value => {
    if (!poll) return;
    const current = poll;
    poll = null;
    clearTimeout(current.timer);
    answer(current.res, 200, value);
  };
  const reset = message => {
    session = null;
    onSessionChange();
    clearTimeout(lease);
    finishPoll({ disconnected: true });
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(message)); }
    pending.clear();
  };
  const deliver = () => {
    const item = [...pending.values()].find(item => !item.delivered);
    if (!poll || !item) return;
    item.delivered = true;
    finishPoll({ command: { id: item.id, name: item.name, args: item.args } });
  };
  const server = http.createServer(async (req, res) => {
    if (req.headers.host !== `127.0.0.1:${server.address().port}` || (req.headers.origin && req.headers.origin !== origin) || (req.method !== "OPTIONS" && req.headers["x-runner-extension-id"] !== extensionId)) return answer(res, 403, { error: "Extension origin required." });
    if (req.url === "/bootstrap" && req.method === "GET") return answer(res, 200, { token, folder: folder?.name || null });
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Runner-Extension-ID", "Vary": "Origin" });
      return res.end();
    }
    const expected = Buffer.from(`Bearer ${token}`);
    const supplied = Buffer.from(req.headers.authorization || "");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return answer(res, 401, { error: "Invalid token." });
    if (folder && req.url.startsWith("/fs/")) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      if (await folder.handle(req, res)) return;
    }
    if (req.method !== "POST") return answer(res, 405, { error: "POST required." });
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES) { answer(res, 413, { error: "Request too large." }); req.destroy(); return; }
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (req.url === "/connect") {
        if (session) return answer(res, 409, { error: "A dashboard is already connected. Disconnect it first." });
        session = randomUUID();
        onSessionChange();
        heartbeat();
        return answer(res, 200, { session });
      }
      if (!session || data.session !== session) return answer(res, 409, { error: "Dashboard session is disconnected." });
      if (req.url === "/disconnect") { reset("Dashboard disconnected; command outcome may be uncertain. Inspect before retrying."); return answer(res, 200, { disconnected: true }); }
      if (req.url === "/poll") {
        heartbeat();
        if (poll) return answer(res, 409, { error: "A poll is already active." });
        const current = { res, timer: null };
        poll = current;
        current.timer = setTimeout(() => finishPoll({}), pollTime);
        res.on("close", () => { if (poll === current) { clearTimeout(current.timer); poll = null; } });
        deliver();
        return;
      }
      if (req.url === "/result") {
        const item = pending.get(data.id);
        if (!item || !item.delivered) return answer(res, 404, { error: "Command expired or unknown; never replay it." });
        clearTimeout(item.timer);
        pending.delete(data.id);
        if (typeof data.error === "string") item.reject(new Error(data.error));
        else item.resolve(data.result);
        return answer(res, 200, { received: true });
      }
      answer(res, 404, { error: "Unknown endpoint." });
    } catch { answer(res, 400, { error: "Invalid JSON request." }); }
  });
  server.requestTimeout = 10 * 60 * 1000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return {
    port: server.address().port,
    get connected() { return !!session; },
    call(name, args, owner = null) {
      if (!session) return Promise.reject(new Error("Start the local MCP helper and wait for the extension to connect automatically."));
      if (pending.size >= 16) return Promise.reject(new Error("Too many commands pending."));
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const item = { id, name, args, owner, resolve, reject, delivered: false, timer: setTimeout(() => {
          pending.delete(id);
          reject(new Error("Command timed out; outcome may be uncertain. Inspect state before retrying."));
        }, timeout) };
        pending.set(id, item);
        deliver();
      });
    },
    cancelOwner(owner) {
      for (const [id, item] of pending) {
        if (item.owner !== owner) continue;
        item.reject(new Error("MCP client disconnected; outcome may be uncertain. Inspect before retrying."));
        if (item.delivered) { item.resolve = () => {}; item.reject = () => {}; }
        else { clearTimeout(item.timer); pending.delete(id); }
      }
    },
    async close() { reset("MCP server stopped."); server.closeAllConnections(); await folder?.close(); await new Promise(resolve => server.close(resolve)); }
  };
};
