import { StringDecoder } from "node:string_decoder";
import { readFile } from "node:fs/promises";
import { connectBroker } from "./client.js";
import { TOOLS, validateTool } from "../mcp-tools.js";

const versions = ["2025-06-18", "2025-03-26", "2024-11-05"];
const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
let bridge;
try { bridge = await connectBroker(); }
catch (error) { process.stderr.write(`${error.message}\n`); process.exit(1); }
let initialized = false;
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const processLine = async line => {
  let message;
  try {
    if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw new Error();
    message = JSON.parse(line);
  } catch { fail(null, -32700, "Invalid JSON."); return; }
  if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" || (Object.hasOwn(message, "id") && typeof message.id !== "string" && typeof message.id !== "number")) { fail(null, -32600, "Invalid JSON-RPC request."); return; }
  if (!Object.hasOwn(message, "id")) return;
  const { id, method, params = {} } = message;
  let result;
  if (method === "initialize") {
    if (!params || typeof params.protocolVersion !== "string" || !params.clientInfo || typeof params.capabilities !== "object") return fail(id, -32602, "Invalid initialize parameters.");
    initialized = true;
    result = { protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0], capabilities: { tools: {} }, serverInfo: { name: "tripo-folder-runner", version } };
  } else if (method === "ping") result = {};
  else if (!initialized) return fail(id, -32002, "Initialize first.");
  else if (method === "tools/list") result = { tools: TOOLS };
  else if (method === "tools/call") {
    try {
      validateTool(params?.name, params?.arguments || {});
      const value = await bridge.call(params.name, params.arguments || {});
      result = { content: [{ type: "text", text: JSON.stringify(value) }] };
    } catch (error) { result = { isError: true, content: [{ type: "text", text: error.message }] }; }
  } else return fail(id, -32601, "Method not found.");
  send({ jsonrpc: "2.0", id, result });
};
const decoder = new StringDecoder("utf8");
let input = "";
let inputBytes = 0;
let discarding = false;
process.stdin.on("data", chunk => {
  for (const part of chunk.toString("binary").split(/(?<=\n)/)) {
    const bytes = Buffer.from(part, "binary");
    const complete = bytes.at(-1) === 10;
    if (!discarding) {
      inputBytes += bytes.length;
      if (inputBytes > 4 * 1024 * 1024) { input = ""; discarding = true; decoder.end(); fail(null, -32700, "Message exceeds 4 MiB."); }
      else input += decoder.write(bytes);
    }
    if (complete) { if (!discarding) processLine(input.trim()); input = ""; inputBytes = 0; discarding = false; }
  }
});
let closing = false;
const close = async () => { if (closing) return; closing = true; process.stdin.destroy(); await bridge.close(); };
process.stdin.on("end", close);
process.on("SIGINT", close);
process.on("SIGTERM", close);
