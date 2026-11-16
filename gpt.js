import { sleep, errorWith, withTimeout, isMissingReceiver } from "./util.js";
import { outputStem } from "./files.js";

const $ = id => document.getElementById(id);
const KEY = "gptQueue";
const LOCK = "tripo-folder-runner-gpt";
const HOME = "https://chatgpt.com/";
const PATTERNS = ["https://chatgpt.com/*"];
const IMAGE_TIMEOUT = 10 * 60 * 1000;
const POLL = 3000;
const IN_FLIGHT = ["saving", "submitted"];
const LABELS = { pending: "Waiting", submitted: "Generating", saving: "Saving", saved: "Saved", failed: "Failed" };
const MIME = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

export const parsePrompts = value => String(value).replace(/\r\n?/g, "\n").split(/\n\s*\n/).map(prompt => prompt.trim()).filter(Boolean);

const decode = base64 => Uint8Array.from(atob(base64), char => char.charCodeAt(0));
const ascii = bytes => String.fromCharCode(...bytes);
const sniff = bytes => bytes[0] === 0x89 && ascii(bytes.slice(1, 4)) === "PNG" ? "png" : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? "jpg" : ascii(bytes.slice(0, 4)) === "RIFF" && ascii(bytes.slice(8, 12)) === "WEBP" ? "webp" : null;
const promptStem = prompt => outputStem(`${prompt.replace(/\s+/g, " ").replace(/^[\s.]+/, "").slice(0, 80)}.png`);
const stemOf = name => name.replace(/\.[^.]*$/, "");
const folded = name => name.normalize("NFC").toLowerCase();
const isMissing = error => ["NotFoundError", "TypeMismatchError"].includes(error?.name);

const exists = async (root, name, kind) => {
  try {
    const handle = kind === "file" ? await root.getFileHandle(name) : await root.getDirectoryHandle(name);
    return kind === "file" ? (await handle.getFile()).size > 0 : true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
};

const allocateName = async (root, item, items, extension) => {
  const taken = new Set(items.filter(other => other.id !== item.id && other.fileName).map(other => folded(stemOf(other.fileName))));
  for await (const [name, handle] of root.entries()) taken.add(folded(handle.kind === "file" ? stemOf(name) : name));
  const stem = promptStem(item.prompt);
  let candidate = stem;
  for (let suffix = 2; taken.has(folded(candidate)); suffix++) candidate = `${stem}--${suffix}`;
  return `${candidate}.${extension}`;
};

const writeImage = async (root, name, blob) => {
  const handle = await root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
  if ((await handle.getFile()).size !== blob.size) throw errorWith(`${name} was not saved completely.`, "GPT_SAVE_FAILED");
};

export const setupGPT = ({ getRoot, ensurePermission, onSaved }) => {
  const state = { items: [], tabId: null, running: false, starting: false, stop: false, saved: 0 };

  const persist = () => chrome.storage.local.set({ [KEY]: { items: state.items, tabId: state.tabId } });
  const patch = async (item, changes) => {
    Object.assign(item, changes, { updatedAt: new Date().toISOString() });
    await persist();
    render();
  };

  const setStatus = (kind, title, detail) => {
    $("gpt-badge").className = `badge ${kind}`;
    $("gpt-badge").textContent = kind === "running" ? "RUNNING" : kind === "error" ? "PAUSED" : "READY";
    $("gpt-title").textContent = title;
    $("gpt-detail").textContent = detail + (state.running && state.stop ? " Stop requested; the current image will finish first." : "");
  };

  const controls = () => {
    const busy = state.running || state.starting;
    for (const id of ["gpt-select", "gpt-refresh", "gpt-open", "gpt-clear"]) $(id).disabled = busy;
    $("gpt-add").disabled = state.starting;
    $("gpt-start").disabled = busy || !getRoot() || !state.tabId || !state.items.some(item => item.status === "pending" || IN_FLIGHT.includes(item.status));
    $("gpt-stop").disabled = !state.running || state.stop;
    $("gpt-stop").textContent = state.stop ? "Stopping after this image…" : "Stop after this image";
    $("gpt-counter").textContent = state.running ? `${state.saved} saved this run` : "";
    const root = getRoot();
    $("gpt-folder").textContent = root ? `Images are saved to the root of ${root.name}. With Watch enabled, the Tripo queue picks them up.` : "Choose a folder in the Tripo models tab first.";
  };

  const actionButton = (label, action) => {
    const button = document.createElement("button");
    button.className = "link-button";
    button.textContent = label;
    button.disabled = state.running || state.starting;
    button.addEventListener("click", () => action().catch(error => setStatus("error", "Needs attention", error.message)));
    return button;
  };

  const render = () => {
    const count = status => state.items.filter(item => item.status === status).length;
    $("gpt-pending").textContent = String(count("pending") + count("submitted") + count("saving"));
    $("gpt-saved").textContent = String(count("saved"));
    $("gpt-failed").textContent = String(count("failed"));
    const body = $("gpt-body");
    body.replaceChildren();
    for (const item of state.items) {
      const row = document.createElement("tr");
      const promptCell = document.createElement("td");
      promptCell.textContent = item.prompt.length > 220 ? `${item.prompt.slice(0, 220)}…` : item.prompt;
      promptCell.title = item.prompt;
      const progress = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = `row-status ${item.status === "saved" ? "completed" : item.status === "failed" || item.error ? "failed" : item.status === "pending" ? "" : "active"}`;
      badge.textContent = item.error && item.status !== "failed" ? "Needs attention" : LABELS[item.status] || item.status;
      progress.append(badge);
      if (item.error) {
        const detail = document.createElement("span");
        detail.className = "row-detail";
        detail.textContent = item.error;
        progress.append(detail);
      }
      const actions = document.createElement("div");
      actions.className = "row-actions";
      if (item.status === "failed" || item.error) actions.append(actionButton(item.status === "pending" ? "Clear error" : "Send again", () => patch(item, { status: "pending", error: null, code: null, conversationUrl: null, fileName: null })));
      if (item.status !== "saving" && item.status !== "saved") actions.append(actionButton("Remove", async () => { state.items = state.items.filter(other => other !== item); await persist(); render(); }));
      if (item.conversationUrl) {
        const link = document.createElement("a");
        link.className = "link-button";
        link.href = item.conversationUrl;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "Open chat";
        actions.append(link);
      }
      if (actions.childElementCount) progress.append(actions);
      const fileCell = document.createElement("td");
      fileCell.textContent = item.fileName || "Named after the prompt";
      row.append(promptCell, progress, fileCell);
      body.append(row);
    }
    $("gpt-empty").hidden = state.items.length > 0;
    controls();
  };

  const message = async (type, payload = {}, timeout = 30000) => {
    if (!state.tabId) throw errorWith("Choose a ChatGPT tab first.", "GPT_TAB_REQUIRED");
    const result = await withTimeout(chrome.tabs.sendMessage(state.tabId, { type, ...payload }), timeout, "ChatGPT did not respond. Keep its tab open, then start again.", "GPT_TIMEOUT");
    if (!result?.ok) throw Object.assign(errorWith(result?.error || "ChatGPT did not return a usable response.", result?.code || "GPT_ERROR"), { submitted: result?.submitted });
    return result;
  };

  const connect = async () => {
    try {
      return await message("gpt:inspect", {}, 5000);
    } catch (error) {
      if (!isMissingReceiver(error)) throw error;
      await chrome.scripting.executeScript({ target: { tabId: state.tabId }, files: ["content-gpt.js"] });
      return message("gpt:inspect", {}, 5000);
    }
  };

  const navigate = async url => {
    await chrome.tabs.update(state.tabId, { url });
    await sleep(1000);
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const tab = await chrome.tabs.get(state.tabId);
      if (tab.status === "complete") {
        try {
          const info = await connect();
          if (info.loggedOut) throw errorWith("Sign in to ChatGPT in the selected tab, then start again.", "GPT_SIGNED_OUT");
          if (url === HOME ? info.composer && !info.turns : info.turns > 0) return info;
        } catch (error) {
          if (error.code === "GPT_SIGNED_OUT") throw error;
        }
      }
      await sleep(750);
    }
    throw errorWith("ChatGPT did not finish loading in the selected tab.", "GPT_LOAD_TIMEOUT");
  };

  const waitForImage = async item => {
    const deadline = Date.now() + IMAGE_TIMEOUT;
    while (Date.now() < deadline) {
      const result = await message("gpt:status", {}, 15000);
      if (result.conversationUrl && result.conversationUrl !== item.conversationUrl) await patch(item, { conversationUrl: result.conversationUrl });
      if (result.state === "ready") return result;
      if (result.state === "failed") throw errorWith(result.detail, result.code);
      setStatus("running", "ChatGPT is generating", `${result.detail} Prompt: ${item.prompt.slice(0, 120)}`);
      await sleep(POLL);
    }
    throw errorWith("No image appeared within 10 minutes. Start again to keep checking this chat, or send the prompt again.", "GPT_IMAGE_TIMEOUT");
  };

  const send = async item => {
    setStatus("running", "Opening a new chat", item.prompt.slice(0, 160));
    await navigate(HOME);
    await patch(item, { status: "submitted", conversationUrl: null, fileName: null, error: null, code: null, submittedAt: new Date().toISOString() });
    try {
      const result = await message("gpt:submit", { jobId: `${item.id}:${item.submittedAt}`, prompt: item.prompt }, 75000);
      if (result.conversationUrl) await patch(item, { conversationUrl: result.conversationUrl });
    } catch (error) {
      if (error.submitted === false) await patch(item, { status: "pending" });
      throw error;
    }
  };

  const reopen = async item => {
    if (!item.conversationUrl) throw errorWith("This prompt was sent, but its chat link was not recorded. Open ChatGPT to check it, then use Send again or Remove.", "GPT_CONVERSATION_MISSING");
    setStatus("running", "Reopening the existing chat", "The prompt is not sent again.");
    await navigate(item.conversationUrl);
  };

  const processItem = async item => {
    const root = getRoot();
    if (item.status === "saving" && item.fileName && (await exists(root, item.fileName, "file") || await exists(root, stemOf(item.fileName), "directory"))) return patch(item, { status: "saved", error: null, code: null });
    if (item.status === "pending") await send(item);
    else await reopen(item);
    const ready = await waitForImage(item);
    setStatus("running", "Saving the image", item.prompt.slice(0, 160));
    const image = await message("gpt:image", { src: ready.src }, 60000);
    const bytes = decode(image.base64);
    const extension = sniff(bytes);
    if (!extension) throw errorWith("ChatGPT returned a file that is not PNG, JPEG or WebP.", "GPT_IMAGE_FORMAT");
    const fileName = item.fileName && item.fileName.endsWith(`.${extension}`) ? item.fileName : await allocateName(root, item, state.items, extension);
    await patch(item, { status: "saving", fileName });
    await writeImage(root, fileName, new Blob([bytes], { type: MIME[extension] }));
    await patch(item, { status: "saved", error: null, code: null, savedAt: new Date().toISOString() });
    state.saved += 1;
    await onSaved();
  };

  const nextItem = () => state.items.find(item => IN_FLIGHT.includes(item.status)) || state.items.find(item => item.status === "pending");

  const runLoop = async () => {
    for (let item = nextItem(); item && !state.stop; item = nextItem()) {
      try {
        await processItem(item);
      } catch (error) {
        if (error.code === "GPT_NO_IMAGE") {
          await patch(item, { status: "failed", error: `ChatGPT replied without an image: ${error.message}`, code: error.code });
          continue;
        }
        await patch(item, { status: error.code === "GPT_LIMIT" ? "pending" : item.status, error: error.message, code: error.code || "GPT_ERROR" });
        throw error;
      }
      if (nextItem()) await sleep(2000);
    }
    setStatus("idle", state.stop ? "Stopped after the current image" : "Prompt queue complete", `${state.saved} image${state.saved === 1 ? "" : "s"} saved this run.`);
  };

  const start = async () => {
    if (state.running || state.starting) return;
    state.starting = true;
    controls();
    try {
      if (!getRoot()) throw errorWith("Choose a folder in the Tripo models tab first.", "FOLDER_REQUIRED");
      await ensurePermission();
      if (!state.tabId) await refreshTabs();
      if (!state.tabId) throw errorWith("No ChatGPT tab was found. Click Open ChatGPT, sign in, then start again. Nothing was sent.", "GPT_TAB_REQUIRED");
      await navigator.locks.request(LOCK, { ifAvailable: true }, async lock => {
        if (!lock) throw errorWith("Another control tab is already running the prompt queue.", "RUN_ALREADY_ACTIVE");
        Object.assign(state, { running: true, starting: false, stop: false, saved: 0 });
        render();
        try {
          await runLoop();
        } catch (error) {
          setStatus("error", "Prompt queue paused", error.message);
        } finally {
          state.running = false;
          render();
        }
      });
    } catch (error) {
      setStatus("error", "Could not start the prompt queue", error.message);
    } finally {
      state.starting = false;
      controls();
    }
  };

  const showInfo = (text, connected = false) => {
    $("gpt-info").className = `studio-info${connected ? " connected" : ""}`;
    $("gpt-info").textContent = text;
  };

  async function refreshTabs() {
    const tabs = await chrome.tabs.query({ url: PATTERNS });
    const select = $("gpt-select");
    select.replaceChildren(...tabs.map(tab => Object.assign(document.createElement("option"), { value: String(tab.id), textContent: (tab.title || "ChatGPT").slice(0, 95) })));
    state.tabId = tabs.some(tab => tab.id === state.tabId) ? state.tabId : tabs[0]?.id || null;
    if (!tabs.length) select.append(Object.assign(document.createElement("option"), { value: "", textContent: "No ChatGPT tab found" }));
    select.value = state.tabId ? String(state.tabId) : "";
    await persist();
    controls();
    if (!state.tabId) return showInfo("Open ChatGPT and sign in. Each prompt runs in a new chat in that tab.");
    try {
      const info = await connect();
      showInfo(info.loggedOut ? "ChatGPT is signed out in this tab. Sign in, then refresh." : info.limit ? `ChatGPT shows a limit: ${info.limit}` : "ChatGPT connected. Keep this tab open while the queue runs.", !info.loggedOut && !info.limit);
    } catch (error) {
      showInfo(error.message);
    }
  }

  const guarded = action => async event => {
    if (state.running || state.starting) return;
    state.starting = true;
    controls();
    try { await action(event); }
    catch (error) { setStatus("error", "Needs attention", error.message || String(error)); }
    finally { state.starting = false; controls(); }
  };

  $("gpt-refresh").addEventListener("click", guarded(refreshTabs));
  $("gpt-select").addEventListener("change", guarded(async () => { state.tabId = Number($("gpt-select").value) || null; await refreshTabs(); }));
  $("gpt-open").addEventListener("click", guarded(async () => { state.tabId = (await chrome.tabs.create({ url: HOME })).id; await sleep(1500); await refreshTabs(); }));
  $("gpt-add").addEventListener("click", async () => {
    const prompts = parsePrompts($("gpt-prompts").value);
    if (!prompts.length) return setStatus("error", "No prompts found", "Paste prompts separated by a blank line.");
    const now = new Date().toISOString();
    state.items.push(...prompts.map(prompt => ({ id: crypto.randomUUID(), prompt, status: "pending", createdAt: now, updatedAt: now })));
    $("gpt-prompts").value = "";
    await persist();
    render();
    setStatus("idle", `${prompts.length} prompt${prompts.length === 1 ? "" : "s"} added`, state.running ? "They run after the current queue." : "Click Start to generate them in ChatGPT.");
  });
  $("gpt-start").addEventListener("click", start);
  $("gpt-stop").addEventListener("click", () => { state.stop = true; controls(); setStatus("running", $("gpt-title").textContent, $("gpt-detail").textContent.replace(/ Stop requested.*$/, "")); });
  $("gpt-clear").addEventListener("click", guarded(async () => { state.items = state.items.filter(item => !["saved", "failed"].includes(item.status)); await persist(); render(); }));

  const initialize = async () => {
    const saved = (await chrome.storage.local.get(KEY))[KEY];
    state.items = Array.isArray(saved?.items) ? saved.items : [];
    state.tabId = saved?.tabId || null;
    render();
    const waiting = state.items.find(item => IN_FLIGHT.includes(item.status));
    setStatus(waiting?.error ? "error" : "idle", waiting ? "A prompt is waiting to resume" : "Paste prompts to begin", waiting ? waiting.error || "Start reopens its chat. The prompt is not sent again." : "Each prompt runs in a new ChatGPT chat. The first image is saved to your Tripo folder.");
    await refreshTabs();
  };

  initialize().catch(error => setStatus("error", "Setup needs attention", error.message));
  return { busy: () => state.running || state.starting, refresh: controls };
};
