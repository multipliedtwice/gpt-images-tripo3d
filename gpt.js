import { setupQueueTabs } from "./queue-status.js";
import { sleep, errorWith, withTimeout, isMissingReceiver } from "./util.js";
import { outputStem } from "./files.js";

const $ = id => document.getElementById(id);
const KEY = "gptQueue";
const LOCK = "tripo-folder-runner-gpt";
const HOME = "https://chatgpt.com/";
const PATTERNS = ["https://chatgpt.com/*"];
const IMAGE_TIMEOUT = 12 * 60 * 1000;
const POLL = 3000;
const STATUS_TIMEOUT = 20000;
const STATUS_ATTEMPTS = 5;
const IN_FLIGHT = ["saving", "submitted"];
const LABELS = { pending: "Waiting", submitted: "Generating", saving: "Saving", saved: "Saved", failed: "Failed" };
const MIME = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

export const parsePrompts = value => String(value).replace(/\r\n?/g, "\n").split(/\n\s*\n/).map(prompt => prompt.trim()).filter(Boolean);

const transientStatusError = error => ["GPT_TIMEOUT", "GPT_ERROR"].includes(error?.code) || isMissingReceiver(error) || /message (?:port|channel) closed|asynchronous response.*(?:closed|before)/i.test(error?.message || "");
const conversationIdentity = value => { const url = new URL(value); return `${url.origin}${url.pathname.replace(/\/+$/, "")}`; };

export const waitForGPTImage = async ({ readStatus, conversationUrl = null, saveConversation = async () => {}, onWaiting = () => {}, onRetry = () => {}, now = Date.now, pause = sleep }) => {
  const deadline = now() + IMAGE_TIMEOUT;
  let failures = 0;
  const expired = () => errorWith("No image appeared within 12 minutes. Start again to keep checking this chat. The prompt was not sent again.", "GPT_IMAGE_TIMEOUT");
  while (now() < deadline) {
    let result;
    try {
      const budget = Math.min(STATUS_TIMEOUT, deadline - now());
      result = await withTimeout(readStatus(budget), budget, "ChatGPT did not respond while checking this image.", "GPT_TIMEOUT");
    } catch (error) {
      if (now() >= deadline) throw expired();
      if (!transientStatusError(error) || ++failures >= STATUS_ATTEMPTS) throw error;
      const delay = Math.min(2000 * 2 ** (failures - 1), deadline - now());
      onRetry({ attempt: failures + 1, attempts: STATUS_ATTEMPTS, delay });
      await pause(delay);
      continue;
    }
    if (now() >= deadline) throw expired();
    failures = 0;
    if (conversationUrl && result.conversationUrl && conversationIdentity(result.conversationUrl) !== conversationIdentity(conversationUrl)) throw errorWith("The selected ChatGPT tab changed to another conversation. Return to this prompt’s saved chat before resuming.", "GPT_CONVERSATION_CHANGED");
    if (!conversationUrl && result.conversationUrl) {
      conversationUrl = result.conversationUrl;
      await saveConversation(conversationUrl);
    }
    if (now() >= deadline) throw expired();
    if (result.state === "ready") return result;
    if (result.state === "failed") throw errorWith(result.detail, result.code);
    onWaiting(result);
    await pause(Math.min(POLL, Math.max(0, deadline - now())));
  }
  throw expired();
};

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
  const state = { items: [], requests: [], tabId: null, running: false, starting: false, stop: false, saved: 0 };

  let mutations = Promise.resolve();
  let resolveLoaded;
  let rejectLoaded;
  const loaded = new Promise((resolve, reject) => { resolveLoaded = resolve; rejectLoaded = reject; });
  loaded.catch(() => {});
  const workers = new Map();
  const allWorkers = () => [state, ...workers.values()];
  const busy = () => allWorkers().some(worker => worker.running || worker.starting);
  const workerFor = requestId => {
    if (requestId === undefined) return state;
    if (!state.requests.some(request => request.id === requestId)) throw new Error("Unknown requestId. Add its prompts first.");
    if (!workers.has(requestId)) workers.set(requestId, { requestId, tabId: state.requests.find(request => request.id === requestId).tabId || null, running: false, starting: false, stop: false, saved: 0 });
    return workers.get(requestId);
  };
  const sameRequest = (item, worker) => item.requestId === worker.requestId;
  let releaseController;
  const controllerReady = new Promise((resolve, reject) => {
    navigator.locks.request(`${LOCK}-controller`, { ifAvailable: true }, async lock => {
      if (!lock) throw errorWith("Another control tab owns the GPT queue. Use that control tab, or close it and reload this one.", "GPT_CONTROLLER_ACTIVE");
      resolve();
      await new Promise(release => { releaseController = release; });
    }).catch(reject);
  });
  controllerReady.catch(() => {});
  globalThis.addEventListener?.("pagehide", () => releaseController?.(), { once: true });
  const transact = build => {
    const pending = mutations.then(async () => {
      await controllerReady;
      await loaded;
      const change = await build();
      if (change.readOnly) return change.result;
      await chrome.storage.local.set({ [KEY]: { items: change.items || state.items, requests: change.requests || state.requests, tabId: state.tabId } });
      change.apply?.();
      return change.result;
    });
    mutations = pending.catch(() => {});
    return pending;
  };
  const persist = () => transact(() => ({}));
  const patch = async (item, changes, idle = false) => {
    await transact(() => {
      if (idle) {
        requireIdle(item.requestId);
        if (!state.items.includes(item)) throw new Error("Prompt no longer exists.");
      }
      const updated = { ...item, ...changes, updatedAt: new Date().toISOString() };
      return { items: state.items.map(other => other === item ? updated : other), apply: () => Object.assign(item, updated) };
    });
    render();
  };
  const removeItem = async item => {
    await transact(() => {
      requireIdle(item.requestId);
      const items = state.items.filter(other => other !== item);
      return { items, apply: () => { state.items = items; } };
    });
    render();
  };

  let lastStatus = state;
  const showStatus = () => {
    const active = allWorkers().filter(worker => worker.running || worker.starting);
    const shown = active.length === 1 ? active[0] : lastStatus;
    const kind = active.length ? "running" : shown.kind || "idle";
    $("gpt-badge").className = `badge ${kind}`;
    $("gpt-badge").textContent = kind === "running" ? "RUNNING" : kind === "error" ? "PAUSED" : "READY";
    $("gpt-title").textContent = active.length > 1 ? `${active.length} requests running` : shown.status || "Prompt queue ready";
    $("gpt-detail").textContent = active.length > 1 ? "Each request uses its own ChatGPT tab." : (shown.detail || "") + (shown.running && shown.stop ? " Stop requested; the current image will finish first." : "");
  };
  const setStatus = (kind, title, detail, worker = state) => {
    Object.assign(worker, { kind, status: title, detail });
    lastStatus = worker;
    showStatus();
  };

  const controls = () => {
    const active = busy();
    for (const id of ["gpt-select", "gpt-refresh", "gpt-open", "gpt-clear"]) $(id).disabled = active;
    $("gpt-add").disabled = false;
    $("gpt-start").disabled = !getRoot() || !state.items.some(item => {
      const worker = item.requestId === undefined ? state : workers.get(item.requestId);
      return (item.status === "pending" || IN_FLIGHT.includes(item.status)) && !worker?.running && !worker?.starting;
    });
    $("gpt-stop").disabled = !active || allWorkers().filter(worker => worker.running || worker.starting).every(worker => worker.stop);
    $("gpt-stop").textContent = active && allWorkers().filter(worker => worker.running || worker.starting).every(worker => worker.stop) ? "Stopping after this image…" : "Stop after this image";
    $("gpt-counter").textContent = active ? `${allWorkers().filter(worker => worker.running || worker.starting).length} active · ${allWorkers().reduce((total, worker) => total + worker.saved, 0)} saved` : "";
    showStatus();
    const root = getRoot();
    $("gpt-folder").textContent = root ? `Images are saved to the root of ${root.name}. With Watch enabled, the Tripo queue picks them up.` : "Choose a folder in the Tripo models tab first.";
  };

  const actionButton = (label, action) => {
    const button = document.createElement("button");
    button.className = "link-button";
    button.textContent = label;
    button.disabled = busy();
    button.addEventListener("click", () => action().catch(error => setStatus("error", "Needs attention", error.message)));
    return button;
  };

  let filters;
  const render = () => {
    const count = status => state.items.filter(item => item.status === status).length;
    $("gpt-pending").textContent = String(count("pending") + count("submitted") + count("saving"));
    $("gpt-saved").textContent = String(count("saved"));
    $("gpt-failed").textContent = String(count("failed"));
    const body = $("gpt-body");
    body.replaceChildren();
    filters?.update(state.items);
    const visible = state.items.filter(item => !filters || filters.matches(item));
    for (const item of visible) {
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
      if (item.status === "failed" || item.error) actions.append(actionButton(item.status === "pending" ? "Clear error" : "Send again", () => patch(item, { status: "pending", error: null, code: null, conversationUrl: null, fileName: null }, true)));
      if (item.status !== "saving" && item.status !== "saved") actions.append(actionButton("Remove", () => removeItem(item)));
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
    $("gpt-empty").hidden = visible.length > 0;
    if (!visible.length) filters?.empty($("gpt-empty"), state.items.length, "prompts");
    controls();
  };

  const message = async (type, payload = {}, timeout = 30000, worker = state) => {
    if (!worker.tabId) throw errorWith("Choose a ChatGPT tab first.", "GPT_TAB_REQUIRED");
    const result = await withTimeout(chrome.tabs.sendMessage(worker.tabId, { type, ...payload }), timeout, "ChatGPT did not respond. Keep its tab open, then start again.", "GPT_TIMEOUT");
    if (!result?.ok) throw Object.assign(errorWith(result?.error || "ChatGPT did not return a usable response.", result?.code || "GPT_ERROR"), { submitted: result?.submitted });
    return result;
  };

  const connect = async (worker = state) => {
    try {
      return await message("gpt:inspect", {}, 5000, worker);
    } catch (error) {
      if (!isMissingReceiver(error)) throw error;
      await chrome.scripting.executeScript({ target: { tabId: worker.tabId }, files: ["content-gpt.js"] });
      return message("gpt:inspect", {}, 5000, worker);
    }
  };

  const navigate = async (url, worker) => {
    await chrome.tabs.update(worker.tabId, { url });
    await sleep(1000);
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const tab = await chrome.tabs.get(worker.tabId);
      if (tab.status === "complete") {
        try {
          const info = await connect(worker);
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

  const waitForImage = (item, worker) => {
    const verifyTab = async () => {
      let tab;
      try { tab = await chrome.tabs.get(worker.tabId); }
      catch (error) { throw errorWith("The selected ChatGPT tab is no longer available. Open its saved chat before resuming.", /No tab|not found/i.test(error?.message || "") ? "GPT_TAB_CLOSED" : "GPT_TAB_UNAVAILABLE"); }
      const url = new URL(tab.url || "about:blank");
      if (url.origin !== "https://chatgpt.com") throw errorWith("The selected tab is no longer on ChatGPT. Return to the saved chat before resuming.", "GPT_WRONG_TAB");
      if (item.conversationUrl && conversationIdentity(url.href) !== conversationIdentity(item.conversationUrl)) throw errorWith("The selected ChatGPT conversation changed. Return to this prompt’s saved chat before resuming.", "GPT_CONVERSATION_CHANGED");
    };
    return waitForGPTImage({
      conversationUrl: item.conversationUrl,
      readStatus: async timeout => {
        await verifyTab();
        try { return await message("gpt:status", {}, timeout, worker); }
        catch (error) {
          if (isMissingReceiver(error)) {
            await verifyTab();
            await chrome.scripting.executeScript({ target: { tabId: worker.tabId }, files: ["content-gpt.js"] });
          }
          throw error;
        }
      },
      saveConversation: conversationUrl => patch(item, { conversationUrl }),
      onWaiting: result => setStatus("running", "ChatGPT is generating", `${result.detail} Prompt: ${item.prompt.slice(0, 120)}`, worker),
      onRetry: ({ attempt, attempts }) => setStatus("running", "Checking ChatGPT again", `Attempt ${attempt} of ${attempts}. Checking the same chat without sending another prompt.`, worker)
    });
  };

  const send = async (item, worker) => {
    setStatus("running", "Opening a new chat", item.prompt.slice(0, 160), worker);
    await navigate(HOME, worker);
    await patch(item, { status: "submitted", conversationUrl: null, fileName: null, error: null, code: null, submittedAt: new Date().toISOString() });
    try {
      const result = await message("gpt:submit", { jobId: `${item.id}:${item.submittedAt}`, prompt: item.prompt }, 75000, worker);
      if (result.conversationUrl) await patch(item, { conversationUrl: result.conversationUrl });
    } catch (error) {
      if (error.submitted === false) await patch(item, { status: "pending" });
      throw error;
    }
  };

  const reopen = async (item, worker) => {
    if (!item.conversationUrl) throw errorWith("This prompt was sent, but its chat link was not recorded. Open ChatGPT to check it, then use Send again or Remove.", "GPT_CONVERSATION_MISSING");
    setStatus("running", "Reopening the existing chat", "The prompt is not sent again.", worker);
    await navigate(item.conversationUrl, worker);
  };

  const processItem = async (item, worker) => {
    const root = getRoot();
    if (item.status === "saving" && item.fileName && (await exists(root, item.fileName, "file") || await exists(root, stemOf(item.fileName), "directory"))) return patch(item, { status: "saved", error: null, code: null });
    if (item.status === "pending") await send(item, worker);
    else await reopen(item, worker);
    const ready = await waitForImage(item, worker);
    setStatus("running", "Saving the image", item.prompt.slice(0, 160), worker);
    const image = await message("gpt:image", { src: ready.src }, 60000, worker);
    const bytes = decode(image.base64);
    const extension = sniff(bytes);
    if (!extension) throw errorWith("ChatGPT returned a file that is not PNG, JPEG or WebP.", "GPT_IMAGE_FORMAT");
    const fileName = await transact(async () => {
      const fileName = item.fileName && item.fileName.endsWith(`.${extension}`) ? item.fileName : await allocateName(root, item, state.items, extension);
      const updated = { ...item, status: "saving", fileName, updatedAt: new Date().toISOString() };
      return { items: state.items.map(other => other === item ? updated : other), apply: () => Object.assign(item, updated), result: fileName };
    });
    render();
    await writeImage(root, fileName, new Blob([bytes], { type: MIME[extension] }));
    await patch(item, { status: "saved", error: null, code: null, savedAt: new Date().toISOString() });
    worker.saved += 1;
    await onSaved();
  };

  const nextItem = worker => state.items.find(item => sameRequest(item, worker) && IN_FLIGHT.includes(item.status)) || state.items.find(item => sameRequest(item, worker) && item.status === "pending");

  const runLoop = async worker => {
    for (let item = nextItem(worker); item && !worker.stop; item = nextItem(worker)) {
      try {
        await processItem(item, worker);
      } catch (error) {
        if (error.code === "GPT_NO_IMAGE") {
          await patch(item, { status: "failed", error: `ChatGPT replied without an image: ${error.message}`, code: error.code });
          continue;
        }
        await patch(item, { error: error.message, code: error.code || "GPT_ERROR" });
        throw error;
      }
      if (nextItem(worker)) await sleep(2000);
    }
    setStatus("idle", worker.stop ? "Stopped after the current image" : "Prompt queue complete", `${worker.saved} image${worker.saved === 1 ? "" : "s"} saved this run.`, worker);
  };

  const prepareWorkerTab = async worker => {
    if (worker === state) {
      if (!worker.tabId) await refreshTabs();
      if (!worker.tabId) throw errorWith("No ChatGPT tab was found. Click Open ChatGPT, sign in, then start again. Nothing was sent.", "GPT_TAB_REQUIRED");
      return;
    }
    if (worker.tabId) {
      let tab;
      try { tab = await chrome.tabs.get(worker.tabId); }
      catch { tab = null; }
      if (tab && new URL(tab.url || "about:blank").origin !== "https://chatgpt.com") throw errorWith("This request’s tab is no longer on ChatGPT. Return it to ChatGPT before resuming.", "GPT_WRONG_TAB");
      if (tab) return;
    }
    const tab = await chrome.tabs.create({ url: HOME, active: false });
    try {
      await transact(() => {
        const requests = state.requests.map(request => request.id === worker.requestId ? { ...request, tabId: tab.id } : request);
        return { requests, apply: () => { state.requests = requests; worker.tabId = tab.id; } };
      });
    } catch (error) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      throw error;
    }
  };

  const start = async (control = {}, worker = state) => {
    if (worker.running || worker.starting) return;
    worker.starting = true;
    worker.stop = false;
    controls();
    try {
      await controllerReady;
      await loaded;
      await mutations;
      if (!nextItem(worker)) throw new Error("No GPT prompts are ready to run in this request.");
      if (!getRoot()) throw errorWith("Choose a folder in the Tripo models tab first.", "FOLDER_REQUIRED");
      await ensurePermission(control.remote === true);
      await prepareWorkerTab(worker);
      const lockName = worker === state ? LOCK : `${LOCK}-request-${worker.requestId}`;
      await navigator.locks.request(lockName, { ifAvailable: true }, async lock => {
        if (!lock) throw errorWith("This GPT request is already running in another control tab.", "RUN_ALREADY_ACTIVE");
        await navigator.locks.request(`${LOCK}-tab-${worker.tabId}`, { ifAvailable: true }, async tabLock => {
          if (!tabLock) throw errorWith("This ChatGPT tab is already used by another request.", "GPT_TAB_BUSY");
          Object.assign(worker, { running: true, starting: false, saved: 0 });
          control.accept?.();
          render();
          try { await runLoop(worker); }
          catch (error) { setStatus("error", "Prompt queue paused", error.message, worker); }
          finally { worker.running = false; render(); }
        });
      });
    } catch (error) {
      control.reject?.(error);
      setStatus("error", "Could not start the prompt queue", error.message, worker);
    } finally {
      worker.starting = false;
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
      const info = await connect(state);
      showInfo(info.loggedOut ? "ChatGPT is signed out in this tab. Sign in, then refresh." : info.limit ? `ChatGPT shows a limit: ${info.limit}` : "ChatGPT connected. Keep this tab open while the queue runs.", !info.loggedOut && !info.limit);
    } catch (error) {
      showInfo(error.message);
    }
  }

  const guarded = action => async event => {
    if (busy()) return;
    state.starting = true;
    controls();
    try { await controllerReady; await loaded; await action(event); }
    catch (error) { setStatus("error", "Needs attention", error.message || String(error)); }
    finally { state.starting = false; controls(); }
  };

  $("gpt-refresh").addEventListener("click", guarded(refreshTabs));
  $("gpt-select").addEventListener("change", guarded(async () => { state.tabId = Number($("gpt-select").value) || null; await refreshTabs(); }));
  const openTab = async () => { state.tabId = (await chrome.tabs.create({ url: HOME })).id; await sleep(1500); await refreshTabs(); return { tabId: state.tabId }; };
  $("gpt-open").addEventListener("click", guarded(openTab));
  const addPrompts = async (prompts, requestId) => {
    if (!Array.isArray(prompts) || !prompts.length || prompts.some(prompt => typeof prompt !== "string" || !prompt.trim())) throw new Error("Paste prompts separated by a blank line.");
    if (requestId !== undefined && (typeof requestId !== "string" || !requestId.trim() || requestId.length > 100)) throw new Error("requestId must contain 1–100 characters.");
    const exactPrompts = [...prompts];
    const result = await transact(async () => {
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(exactPrompts)))), byte => byte.toString(16).padStart(2, "0")).join("");
      const receipt = requestId === undefined ? null : state.requests.find(request => request.id === requestId);
      if (receipt) {
        if (receipt.digest !== digest) throw new Error("requestId already exists with different prompts. Use a new requestId for new work.");
        return { readOnly: true, result: { added: [...receipt.itemIds], requestId, reused: true } };
      }
      const now = new Date().toISOString();
      const added = exactPrompts.map(prompt => ({ id: crypto.randomUUID(), prompt, status: "pending", createdAt: now, updatedAt: now, ...(requestId === undefined ? {} : { requestId }) }));
      const items = [...state.items, ...added];
      const requests = requestId === undefined ? state.requests : [...state.requests, { id: requestId, digest, itemIds: added.map(item => item.id), createdAt: now }];
      return { items, requests, apply: () => { state.items = items; state.requests = requests; }, result: { added: added.map(item => item.id), ...(requestId === undefined ? {} : { requestId, reused: false }) } };
    });
    render();
    if (!busy()) setStatus("idle", `${prompts.length} prompt${prompts.length === 1 ? "" : "s"} ${result.reused ? "already queued" : "added"}`, "Click Start to generate them in ChatGPT.");
    return result;
  };
  const requireIdle = requestId => { if (requestId === undefined ? busy() : workerFor(requestId).running || workerFor(requestId).starting) throw new Error("GPT queue is busy."); };
  const clearFinished = async requestId => {
    await transact(() => {
      requireIdle(requestId);
      const items = state.items.filter(item => !["saved", "failed"].includes(item.status) || (requestId !== undefined && item.requestId !== requestId));
      return { items, apply: () => { state.items = items; } };
    });
    render();
    return { cleared: true, ...(requestId === undefined ? {} : { requestId }) };
  };
  const startRemote = (requestId, remote = true) => {
    const worker = workerFor(requestId);
    if (worker.running) return Promise.resolve({ accepted: true, asynchronous: true, alreadyRunning: true, stopRequested: worker.stop, tabId: worker.tabId });
    if (worker.startPromise) return worker.startPromise;
    if (worker.starting) throw new Error("GPT queue is busy.");
    const pending = new Promise((resolve, reject) => { start({ remote, accept: () => resolve({ accepted: true, asynchronous: true, alreadyRunning: false, stopRequested: worker.stop, tabId: worker.tabId }), reject }, worker).catch(reject); });
    worker.startPromise = pending;
    pending.finally(() => { if (worker.startPromise === pending) worker.startPromise = null; }).catch(() => {});
    return pending;
  };
  const startAll = async () => {
    await controllerReady;
    await loaded;
    await mutations;
    const requestIds = [...new Set(state.items.filter(item => item.status === "pending" || IN_FLIGHT.includes(item.status)).map(item => item.requestId))];
    const results = await Promise.allSettled(requestIds.filter(requestId => {
      const worker = workerFor(requestId);
      return !worker.running && !worker.starting;
    }).map(requestId => startRemote(requestId, false)));
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
  };
  const stop = requestId => {
    const targets = requestId === undefined ? allWorkers().filter(worker => worker.running || worker.starting) : [workerFor(requestId)];
    if (!targets.length || targets.every(worker => !worker.running && !worker.starting)) throw new Error("GPT queue is not running.");
    for (const worker of targets) worker.stop = true;
    controls();
    return { stopRequested: true, ...(requestId === undefined ? { allRequests: true } : { requestId }) };
  };
  $("gpt-add").addEventListener("click", () => addPrompts(parsePrompts($("gpt-prompts").value)).then(() => { $("gpt-prompts").value = ""; }).catch(error => setStatus("error", "Needs attention", error.message)));
  $("gpt-start").addEventListener("click", () => startAll().catch(error => setStatus("error", "Could not start prompts", error.message)));
  $("gpt-stop").addEventListener("click", () => stop());
  $("gpt-clear").addEventListener("click", () => clearFinished().catch(error => setStatus("error", "Needs attention", error.message)));

  const initialize = async () => {
    await controllerReady;
    const saved = (await chrome.storage.local.get(KEY))[KEY];
    state.items = Array.isArray(saved?.items) ? saved.items : [];
    state.requests = Array.isArray(saved?.requests) ? saved.requests : [];
    state.tabId = saved?.tabId || null;
    resolveLoaded();
    render();
    const waiting = state.items.find(item => IN_FLIGHT.includes(item.status));
    setStatus(waiting?.error ? "error" : "idle", waiting ? "A prompt is waiting to resume" : "Paste prompts to begin", waiting ? waiting.error || "Start reopens its chat. The prompt is not sent again." : "Each prompt runs in a new ChatGPT chat. The first image is saved to your Tripo folder.");
    await refreshTabs();
  };

  filters = setupQueueTabs($("gpt-filters"), render, "Saved");
  const ready = initialize().catch(error => { rejectLoaded(error); setStatus("error", "Setup needs attention", error.message); throw error; });
  ready.catch(() => {});
  return {
    ready, busy, refresh: controls, addPrompts, clearFinished, stop,
    openTab: async () => { await controllerReady; await loaded; requireIdle(); return openTab(); },
    snapshot: (offset = 0, limit = 25, requestId) => {
      const items = requestId === undefined ? state.items : state.items.filter(item => item.requestId === requestId);
      const receipt = requestId === undefined ? null : state.requests.find(request => request.id === requestId);
      const worker = requestId === undefined ? state : workers.get(requestId);
      const request = requestId === undefined ? null : { id: requestId, known: !!receipt, itemIds: receipt ? [...receipt.itemIds] : [], missingItemIds: receipt ? receipt.itemIds.filter(id => !items.some(item => item.id === id)) : [] };
      const running = requestId === undefined ? allWorkers().some(worker => worker.running) : !!worker?.running;
      const starting = requestId === undefined ? allWorkers().some(worker => worker.starting) : !!worker?.starting;
      return { items: items.slice(offset, offset + limit).map(item => ({ ...item })), itemCount: items.length, totalItemCount: state.items.length, ...(request ? { request } : {}), running, starting, stopRequested: requestId === undefined ? busy() && allWorkers().filter(worker => worker.running || worker.starting).every(worker => worker.stop) : !!worker?.stop, tabId: worker?.tabId || receipt?.tabId || null, status: worker?.status || (receipt ? "Request ready" : $("gpt-title").textContent), detail: worker?.detail || "", ...(requestId === undefined ? { workers: [...workers.values()].map(({ requestId, tabId, running, starting, stop }) => ({ requestId, tabId, running, starting, stopRequested: stop })) } : {}) };
    },
    startRemote,
    selectTab: async tabId => {
      await controllerReady; await loaded;
      requireIdle();
      const tabs = await chrome.tabs.query({ url: PATTERNS });
      if (!tabs.some(tab => tab.id === tabId)) throw new Error("Select an existing ChatGPT tab from runner_status.");
      state.tabId = tabId; await refreshTabs(); return { tabId };
    },
    promptAction: async (id, action, requestId) => {
      requireIdle(requestId);
      const item = state.items.find(item => item.id === id);
      if (!item || (requestId !== undefined && item.requestId !== requestId)) throw new Error("Prompt not found in this request.");
      if (["saved", "saving"].includes(item.status)) throw new Error("Saved or saving images cannot be reset or removed.");
      if (action === "retry") await patch(item, { status: "pending", error: null, code: null, conversationUrl: null, fileName: null }, true);
      else await removeItem(item);
      return { id, action };
    }
  };
};
