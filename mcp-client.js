import { createRemoteFolder } from "./remote-folder.js";

const URL = "http://127.0.0.1:17321";
export const createMCPConfig = extensionId => ({
  mcpServers: {
    "image-runner": {
      command: "node",
      args: ["/absolute/path/to/mcp-helper/mcp/server.js"],
      env: { RUNNER_EXTENSION_ID: extensionId, RUNNER_OUTPUT_DIR: "/absolute/path/to/output" }
    }
  }
});

export const formatMCPConfig = (extensionId, format) => {
  const config = createMCPConfig(extensionId);
  if (format === "claude") return JSON.stringify(config, null, 2);
  const server = config.mcpServers["image-runner"];
  return `[mcp_servers.image-runner]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n\n[mcp_servers.image-runner.env]\n${Object.entries(server.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join("\n")}\n`;
};

export const setupMCP = ({ execute, setFolder, waitUntilReady = async () => {} }) => {
  const $ = id => document.getElementById(id);
  let enabled = true;
  let current = null;
  let closed = false;
  let preferenceChanged = false;
  let releasing = Promise.resolve();
  let preferenceError = "";
  const status = (text, detail = "") => { $("mcp-status").textContent = text; $("mcp-status").title = [detail, preferenceError].filter(Boolean).join(" "); };
  const release = attempt => {
    if (!attempt) return;
    attempt.controller.abort();
    if (current === attempt) current = null;
    if (attempt.session) releasing = fetch(`${URL}/disconnect`, {
      method: "POST", headers: attempt.headers, body: JSON.stringify({ session: attempt.session }),
      keepalive: true, signal: AbortSignal.timeout(2000)
    }).catch(() => {});
  };
  const applyEnabled = value => {
    enabled = value !== false;
    $("mcp-enabled").checked = enabled;
    if (!enabled) release(current);
    if (!current) status(enabled ? "Waiting for local helper" : "Agent control off");
  };
  const ready = chrome.storage.local.get("mcpEnabled").then(saved => { if (!preferenceChanged) applyEnabled(saved.mcpEnabled); }).catch(error => { applyEnabled(false); status("Agent control off", error.message); });
  const connect = async () => {
    await ready;
    if (!enabled || closed) return;
    try { await waitUntilReady(); }
    catch (error) { if (enabled && !closed) status("Agent control unavailable", error.message); return; }
    await releasing;
    if (!enabled || closed || current) return;
    const attempt = { controller: new AbortController(), session: null, headers: null };
    current = attempt;
    const active = () => current === attempt && enabled && !closed;
    const signal = timeout => AbortSignal.any([attempt.controller.signal, AbortSignal.timeout(timeout)]);
    const post = async (path, data) => {
      const response = await fetch(`${URL}${path}`, {
        method: "POST", headers: attempt.headers, body: JSON.stringify(data), signal: signal(path === "/poll" ? 25000 : 5000)
      });
      const value = await response.json();
      if (path === "/result" && response.status === 404) return { expired: true };
      if (!response.ok) throw new Error(value.error || "Local helper request failed.");
      return value;
    };
    try {
      const response = await fetch(`${URL}/bootstrap`, { signal: signal(5000), headers: { "X-Runner-Extension-ID": chrome.runtime.id } });
      if (!response.ok) throw new Error("Local helper is not configured for this extension.");
      const bootstrap = await response.json();
      if (!active()) return;
      attempt.headers = { Authorization: `Bearer ${bootstrap.token}`, "Content-Type": "application/json", "X-Runner-Extension-ID": chrome.runtime.id };
      const result = await post("/connect", {});
      attempt.session = result.session;
      if (!active()) { release(attempt); return; }
      if (bootstrap.folder) await setFolder(createRemoteFolder({ url: URL, token: bootstrap.token, name: bootstrap.folder }));
      if (!active()) { release(attempt); return; }
      status("Local helper connected");
      (async () => {
        while (active()) {
          const value = await post("/poll", { session: attempt.session });
          if (!active()) return;
          if (value.disconnected) throw new Error("Local helper stopped.");
          if (!value.command) continue;
          const { id, name, args } = value.command;
          let result;
          try { result = { result: await execute(name, args) }; }
          catch (error) { result = { error: error.message || String(error) }; }
          if (!active()) return;
          await post("/result", { session: attempt.session, id, ...result });
        }
      })().catch(error => {
        if (!active()) return;
        release(attempt);
        status("Waiting for local helper", error.message);
      });
    } catch (error) {
      if (!active()) return;
      release(attempt);
      status("Waiting for local helper", error.message);
    }
  };
  $("mcp-enabled").addEventListener("change", async () => {
    const checked = $("mcp-enabled").checked;
    await ready;
    applyEnabled(checked);
    try { await chrome.storage.local.set({ mcpEnabled: enabled }); preferenceError = ""; }
    catch { preferenceError = "Preference not saved. Change applies to this tab."; }
    status($("mcp-status").textContent);
    if (enabled) connect();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.mcpEnabled) return;
    preferenceChanged = true;
    applyEnabled(changes.mcpEnabled.newValue);
    if (enabled) connect();
  });
  for (const format of ["claude", "codex"]) $(`mcp-copy-${format}`).addEventListener("click", async () => {
    const value = formatMCPConfig(chrome.runtime.id, format);
    try { await navigator.clipboard.writeText(value); $(`mcp-copy-${format}`).textContent = `Copied ${format === "claude" ? "Claude" : "Codex"} config`; }
    catch {
      $(`mcp-copy-${format}`).textContent = `Copy ${format === "claude" ? "Claude" : "Codex"} config`;
      $("mcp-config").value = value;
      $("mcp-config").hidden = false;
      $("mcp-config").focus();
      $("mcp-config").select();
    }
  });
  const menu = document.querySelector(".mcp-settings");
  document.addEventListener("pointerdown", event => { if (menu.open && !menu.contains(event.target)) menu.open = false; });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !menu.open) return;
    menu.open = false;
    menu.querySelector("summary").focus();
  });
  window.addEventListener("pagehide", () => { closed = true; release(current); });
  return { connect };
};
