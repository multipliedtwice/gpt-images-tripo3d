import { setupQueueTabs } from "./queue-status.js";
import { setupMCP } from "./mcp-client.js";
import { validateTool } from "./mcp-tools.js";
import { scanImages, readSource, listJobs, createJob, updateJob, getJob, commitExport, resumeCommit } from "./files.js";
import { sha256 } from "./archive.js";
import { getPreference, setPreference } from "./db.js";
import { receiveExport } from "./transfer.js";
import { sleep, errorWith, withTimeout, isMissingReceiver } from "./util.js";
import { setupGPT } from "./gpt.js";

const $ = id => document.getElementById(id);
const STUDIO_HOSTS = new Set(["studio.tripo3d.ai", "tripo3d.ai", "www.tripo3d.ai"]);
const STUDIO_PATTERNS = ["https://studio.tripo3d.ai/*", "https://tripo3d.ai/workspace/*", "https://www.tripo3d.ai/workspace/*"];
const LOCK_NAME = "tripo-folder-runner-active-run";
const UPLOAD_TIMEOUT = 75000;
const state = { root: null, permission: false, tabId: null, images: [], jobs: [], current: null, running: false, starting: true, stop: false, completed: 0, options: null, stable: new Map(), wakeLock: null, importTarget: null };
let gpt = null;
const hasSavedExport = job => ["staging", "committing"].includes(job?.status);

const sourceMime = name => /\.png$/i.test(name) ? "image/png" : /\.webp$/i.test(name) ? "image/webp" : "image/jpeg";
const modelURL = value => {
  const url = new URL(value);
  if (url.protocol !== "https:" || !STUDIO_HOSTS.has(url.hostname) || !/^\/workspace\/generate\/[^/]+\/?$/.test(url.pathname)) throw errorWith("The saved model URL is not a Tripo Studio model.", "INVALID_MODEL_URL");
  url.hash = "";
  return url.href;
};
const modelID = value => {
  const slug = decodeURIComponent(new URL(modelURL(value)).pathname.split("/").filter(Boolean).at(-1));
  return slug.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i)?.[1]?.toLowerCase() || slug;
};
const humanSize = bytes => `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
const textCell = (row, text) => { const cell = document.createElement("td"); cell.textContent = text; row.append(cell); return cell; };

const setStatus = (kind, title, detail) => {
  $("state-badge").className = `badge ${kind}`;
  $("state-badge").textContent = kind === "running" ? "RUNNING" : kind === "error" ? "PAUSED" : "READY";
  $("status-title").textContent = title;
  $("status-detail").textContent = detail + (state.running && state.stop ? " Stop requested; the current model will finish first." : "");
};

const updateControls = () => {
  const busy = state.running || state.starting;
  for (const id of ["choose-folder", "grant-folder", "studio-select", "refresh-studio", "open-studio", "max-credits", "model-limit", "watch-folder", "rescan", "resume", "bind-model", "regenerate", "import-export"]) $(id).disabled = busy;
  $("start").disabled = busy || !state.root || (!state.tabId && !hasSavedExport(state.current));
  $("bind-model").disabled = busy || !state.tabId;
  $("regenerate").disabled = busy || !state.tabId;
  $("regenerate").hidden = !state.current || !["submitting", "generating"].includes(state.current.status) || (!!state.current.modelId && state.current.errorCode !== "MODEL_UNAVAILABLE") || hasSavedExport(state.current);
  $("stop").disabled = !state.running || state.stop;
  $("stop").textContent = state.stop ? "Stopping after this model…" : "Stop after this model";
  $("grant-folder").hidden = !state.root || state.permission;
  $("recovery").hidden = busy || !state.current || state.current.status === "completed";
  if (state.current) {
    $("recovery-title").textContent = state.current.sourceName;
    const paid = ["submitting", "generating", "exporting", "staging", "committing"].includes(state.current.status);
    const instruction = paid ? "Resume checks the existing generation or saved export. It will not click Generate again. If Studio never started this generation, use Regenerate. If its model cannot be found, select this image’s model in Studio and link it below, or import its downloaded FBX/ZIP." : "This image has not been submitted for generation. Resume uploads it again before checking the credit ceiling. You can also link an existing model or import a downloaded FBX/ZIP.";
    $("recovery-detail").textContent = [state.current.error, instruction].filter(Boolean).join(' ');
  }
  gpt?.refresh();
  const limit = state.options?.limit;
  $("run-counter").textContent = state.running ? `${state.completed}${limit ? ` / ${limit}` : ""} saved this run` : "";
};

let tripoFilters;
const renderQueue = () => {
  const unfinished = state.jobs.filter(job => job.status !== "completed");
  const completed = state.jobs.filter(job => job.status === "completed");
  $("pending-count").textContent = String(state.images.length);
  $("completed-count").textContent = String(completed.length);
  $("active-count").textContent = String(unfinished.length);
  $("folder-name").textContent = state.root?.name || "No folder selected";
  $("folder-meta").textContent = state.root ? state.permission ? `${state.images.length} root image${state.images.length === 1 ? "" : "s"} · ${completed.length} completed` : "Reconnect to allow reading and saving files." : "Select a folder on your SD card or computer.";
  const labels = { prepared: "Prepared", uploaded: "Uploaded", submitting: "Submitted / checking", generating: "Generating", exporting: "Exporting", staging: "Saving export", committing: "Organizing files", completed: "Completed" };
  const rootNames = new Set(state.images.map(image => image.name));
  const rows = [
    ...state.images.map(image => ({ name: image.name, job: unfinished.find(job => job.sourceName === image.name), size: image.size })),
    ...unfinished.filter(job => !rootNames.has(job.sourceName)).map(job => ({ name: job.sourceName, job, size: job.sourceSize })),
    ...completed.slice().reverse().map(job => ({ name: job.sourceName, job, size: job.sourceSize }))
  ];
  tripoFilters?.update(rows.map(row => row.job));
  const filtered = rows.filter(row => !tripoFilters || tripoFilters.matches(row.job));
  const visible = filtered.filter(row => row.job?.status !== "completed").concat(filtered.filter(row => row.job?.status === "completed").slice(0, 80));
  const rank = ({ job }) => !job ? 2 : job.status === "completed" ? 3 : job.id === state.current?.id ? 0 : 1;
  visible.sort((a, b) => rank(a) - rank(b));
  const body = $("queue-body");
  body.replaceChildren();
  for (const rowData of visible) {
    const row = document.createElement("tr");
    const nameCell = textCell(row, rowData.name);
    const small = document.createElement("span");
    small.className = "row-detail";
    small.textContent = humanSize(rowData.size);
    nameCell.append(small);
    const progress = textCell(row, "");
    const badge = document.createElement("span");
    const job = rowData.job;
    badge.className = `row-status ${job?.status === "completed" ? "completed" : job?.error ? "failed" : job ? "active" : ""}`;
    badge.textContent = job?.status === "completed" ? "Completed" : job?.error ? "Needs attention" : job ? labels[job.status] || job.status : "Waiting";
    progress.append(badge);
    if (job?.error && job.status !== "completed") progress.title = job.error;
    textCell(row, job ? `${job.folderName}/` : "Created after export");
    body.append(row);
  }
  $("empty-state").hidden = visible.length > 0;
  if (!visible.length) tripoFilters?.empty($("empty-state"), rows.length, "images");
  $("queue-note").hidden = completed.length <= 80 || !["all", "completed"].includes(tripoFilters?.selected() || "all");
  $("queue-note").textContent = `Showing the latest 80 of ${completed.length} completed models. All remain in your folder.`;
  updateControls();
};

const refreshQueue = async () => {
  if (!state.root || !state.permission) return renderQueue();
  const [images, jobs] = await Promise.all([scanImages(state.root), listJobs(state.root)]);
  state.images = images;
  state.jobs = jobs;
  const same = state.current && jobs.find(job => job.id === state.current.id && job.status !== "completed");
  state.current = same || jobs.find(job => job.status !== "completed") || null;
  renderQueue();
};

const settings = () => {
  const maxCredits = Number($("max-credits").value);
  const limit = Number($("model-limit").value);
  if (!Number.isSafeInteger(maxCredits) || maxCredits < 1 || maxCredits > 10000) throw errorWith("Enter a whole-number credit ceiling between 1 and 10,000.", "INVALID_OPTIONS");
  if (!$("model-limit").value.trim() || !Number.isSafeInteger(limit) || limit < 0 || limit > 100000) throw errorWith("Enter a whole number of models, or 0 for no limit.", "INVALID_OPTIONS");
  return { maxCredits, limit, watch: $("watch-folder").checked };
};

const requestFolderPermission = async (remote = false) => {
  if (!state.root) throw errorWith("Choose your source folder first.", "FOLDER_REQUIRED");
  let permission = await state.root.queryPermission({ mode: "readwrite" });
  if (permission !== "granted" && !remote) permission = await state.root.requestPermission({ mode: "readwrite" });
  state.permission = permission === "granted";
  updateControls();
  if (!state.permission) throw errorWith("Chrome needs permission to read and save files in the selected folder. Click Reconnect folder and allow access.", "FOLDER_PERMISSION");
};

const studioMessage = async (type, payload = {}, timeout = 55000, timeoutMessage = "Studio did not respond. Keep its tab open, then resume the existing job.") => {
  if (!state.tabId) throw errorWith("Choose a Tripo Studio tab first.", "STUDIO_REQUIRED");
  const result = await withTimeout(chrome.tabs.sendMessage(state.tabId, { type, ...payload }), timeout, timeoutMessage);
  if (!result?.ok) throw Object.assign(new Error(result?.error || "Studio did not return a usable response."), { code: result?.code || "STUDIO_ERROR", submitted: result?.submitted });
  return result;
};

const ensureStudio = async () => {
  if (!state.tabId) throw errorWith("No Tripo Studio tab is selected. Open your signed-in Studio Generate page, click Refresh tabs, select it, then resume.", "STUDIO_REQUIRED");
  const tab = await chrome.tabs.get(state.tabId);
  const url = new URL(tab.url || "about:blank");
  if (url.protocol !== "https:" || !STUDIO_HOSTS.has(url.hostname) || !url.pathname.startsWith("/workspace")) throw errorWith("Open the Generate workspace in your signed-in Studio tab, then refresh the connection.", "WRONG_PAGE");
  try {
    return await studioMessage("tripo:inspect", {}, 8000);
  } catch (error) {
    if (!isMissingReceiver(error)) throw error;
    await chrome.scripting.executeScript({ target: { tabId: state.tabId }, world: "MAIN", files: ["page-capture.js"] });
    await chrome.scripting.executeScript({ target: { tabId: state.tabId }, files: ["content.js"] });
    return studioMessage("tripo:inspect", {}, 8000);
  }
};

const showStudio = info => {
  $("studio-info").className = "studio-info connected";
  $("studio-info").textContent = `${info.model || "Studio connected"}${info.cost === null ? " · credit cost not visible yet" : ` · ${info.cost} credits per generation`}${Number.isFinite(info.balance) ? ` · ${info.balance} credits left` : ""}. Settings are controlled in Studio.`;
};

const refreshTabs = async () => {
  const tabs = await chrome.tabs.query({ url: STUDIO_PATTERNS });
  const selected = state.tabId;
  const select = $("studio-select");
  select.replaceChildren();
  for (const tab of tabs) {
    const option = document.createElement("option");
    option.value = String(tab.id);
    option.textContent = (tab.title || new URL(tab.url).hostname).slice(0, 95);
    select.append(option);
  }
  state.tabId = tabs.some(tab => tab.id === selected) ? selected : tabs[0]?.id || null;
  if (!tabs.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No Studio tab found";
    select.append(option);
  }
  select.value = state.tabId ? String(state.tabId) : "";
  updateControls();
  $("studio-info").className = "studio-info";
  if (state.tabId) {
    try { showStudio(await ensureStudio()); }
    catch (error) { $("studio-info").textContent = error.message; }
  } else {
    $("studio-info").textContent = "Sign in to Studio and choose your generation settings there.";
  }
};

const saveJob = async patch => {
  state.current = await updateJob(state.root, state.current, patch);
  const index = state.jobs.findIndex(job => job.id === state.current.id);
  if (index >= 0) state.jobs[index] = state.current;
  else state.jobs.push(state.current);
  renderQueue();
  return state.current;
};

const base64File = async file => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
};

const generationStep = async () => {
  const file = await readSource(state.root, state.current.sourceName);
  if (await sha256(file) !== state.current.sourceHash) throw errorWith("This root image changed after the job was prepared. Restore its original contents before resuming.", "SOURCE_CHANGED");
  setStatus("running", `Uploading ${state.current.sourceName}`, "The queue uses the generation settings currently selected in Studio.");
  await ensureStudio();
  await studioMessage("tripo:upload", { jobId: state.current.id, name: file.name, mime: sourceMime(file.name), base64: await base64File(file), lastModified: file.lastModified }, UPLOAD_TIMEOUT, "Studio did not finish preparing and confirming the image upload. Generate has not been clicked; resume this job.");
  await saveJob({ status: "uploaded", error: null, errorCode: null });
  const info = await ensureStudio();
  showStudio(info);
  if (!Number.isFinite(info.cost) || info.cost < 0) throw errorWith("The Generate credit cost is not visible. Check Studio, then resume; Generate has not been clicked.", "COST_UNKNOWN");
  if (info.cost > state.options.maxCredits) throw errorWith(`Studio shows ${info.cost} credits, above your ${state.options.maxCredits}-credit ceiling. Adjust Studio or the ceiling and resume.`, "COST_LIMIT");
  if (Number.isFinite(info.balance) && info.balance < info.cost) throw errorWith(`Tripo shows ${info.balance} credits, below the ${info.cost}-credit generation cost. Add credits, then resume; Generate has not been clicked.`, "INSUFFICIENT_CREDITS");
  if (!info.baseline || !Array.isArray(info.baseline.assetIds)) throw errorWith("Studio’s current model identity could not be recorded. Generate has not been clicked.", "BASELINE_MISSING");
  await saveJob({ status: "submitting", baseline: info.baseline, generationCost: info.cost, requestedAt: new Date().toISOString(), studioOrigin: new URL(info.url).origin });
  setStatus("running", `Generating ${state.current.sourceName}`, `${info.cost} Studio credits shown. Waiting for the new model.`);
  let response;
  try {
    response = await studioMessage("tripo:generate", { jobId: state.current.id, maxCredits: state.options.maxCredits, baseline: state.current.baseline }, 60000);
  } catch (error) {
    if (error.submitted === false) await saveJob({ status: "uploaded", baseline: null });
    throw error;
  }
  await saveJob({ status: "generating", submittedAt: response.submittedAt || Date.now(), generationCost: response.cost ?? info.cost });
};

const waitForModel = async () => {
  if (!state.current.baseline && !state.current.modelUrl) throw errorWith("This job cannot be matched to a saved model. Open this image’s model in Studio and use “Use selected model”, or import its FBX/ZIP.", "MODEL_IDENTITY_MISSING");
  await ensureStudio();
  if (state.current.modelUrl) {
    await studioMessage("tripo:recover", { url: modelURL(state.current.modelUrl) }, 15000);
    await sleep(1500);
  }
  const waitLimit = 30 * 60 * 1000;
  const deadline = state.current.modelId ? Date.now() + waitLimit : Math.max((state.current.submittedAt || Date.now()) + waitLimit, Date.now() + 20000);
  let failures = 0;
  while (Date.now() < deadline) {
    let info;
    try {
      info = await studioMessage("tripo:status", { jobId: state.current.id, baseline: state.current.baseline, modelUrl: state.current.modelUrl || null }, 15000);
      failures = 0;
    } catch (error) {
      if (++failures >= 3) throw error;
      await sleep(2000);
      await ensureStudio();
      continue;
    }
    if (info.state === "failed") throw errorWith(info.detail || "Studio reported that this generation failed. Check it before resuming.", info.code || "GENERATION_FAILED");
    if (info.modelUrl && info.modelId) {
      const url = modelURL(info.modelUrl);
      if (modelID(url) !== String(info.modelId).toLowerCase() && modelID(url) !== info.modelId) throw errorWith("Studio returned inconsistent model identifiers. Select the correct model before resuming.", "MODEL_MISMATCH");
      if (!state.current.modelUrl || state.current.modelId !== info.modelId) await saveJob({ modelUrl: url, modelId: info.modelId, status: hasSavedExport(state.current) ? state.current.status : "generating" });
    }
    setStatus("running", `Waiting for ${state.current.sourceName}`, info.detail || "Waiting for Studio to finish the existing model.");
    if (info.state === "ready") {
      if (!state.current.modelUrl || !info.modelUrl) throw errorWith("The finished model has no stable identity. Use “Use selected model” to recover it.", "MODEL_IDENTITY_MISSING");
      return;
    }
    await sleep(4000);
  }
  throw errorWith("No model appeared within 30 minutes of clicking Generate. If Studio shows no model for this image, use “Regenerate” (may charge credits again); otherwise select its model and use “Use selected model”.", "GENERATION_TIMEOUT");
};

const exportStep = async () => {
  await saveJob({ status: hasSavedExport(state.current) ? state.current.status : "exporting", error: null, errorCode: null });
  setStatus("running", `Exporting ${state.current.sourceName}`, "Selecting FBX and waiting for the exported model package.");
  const transfer = receiveExport({ jobId: state.current.id, tabId: state.tabId, onProgress: (bytes, total) => setStatus("running", `Downloading ${state.current.sourceName}`, `${humanSize(bytes)}${total ? ` of ${humanSize(total)}` : ""} received. The original stays in the root until saving is complete.`) });
  let result;
  try {
    try {
      await studioMessage("tripo:export", { jobId: state.current.id }, 25000);
    } catch (error) {
      if (error.code !== "EXPORT_BUTTON_NOT_FOUND") throw error;
      setStatus("running", "Finish the FBX export in Studio", "FBX is selected. Click the final Export or Download button in Studio; the runner will wait for its file.");
    }
    result = await transfer.promise;
  } finally {
    transfer.close();
    await studioMessage("tripo:disarm-export", {}, 5000).catch(() => {});
  }
  setStatus("running", `Saving ${state.current.sourceName}`, "Verifying the FBX, saving companion files and checking the source copy before removing the root image.");
  state.current = await commitExport(state.root, state.current, result.blob, result.name);
};

const processCurrent = async () => {
  state.current = await getJob(state.root, state.current.id) || state.current;
  if (state.current.status === "completed") return;
  await saveJob({ error: null, errorCode: null });
  if (hasSavedExport(state.current)) {
    setStatus("running", `Finishing ${state.current.sourceName}`, "Recovering the already downloaded export and completing the folder operation.");
    try {
      state.current = await resumeCommit(state.root, state.current);
      return;
    } catch (error) {
      if (error.code !== "EXPORT_NEEDED" || !state.current.modelUrl) throw error;
    }
  }
  if (["prepared", "uploaded"].includes(state.current.status)) await generationStep();
  else if (!["submitting", "generating", "exporting", "staging", "committing"].includes(state.current.status)) throw errorWith(`The saved job has an unknown state: ${state.current.status}.`, "UNKNOWN_JOB_STATE");
  await waitForModel();
  await exportStep();
};

const stableImage = () => {
  const now = Date.now();
  const names = new Set(state.images.map(image => image.name));
  for (const name of state.stable.keys()) if (!names.has(name)) state.stable.delete(name);
  let next = null;
  for (const image of state.images) {
    const fingerprint = `${image.size}:${image.lastModified}`;
    const previous = state.stable.get(image.name);
    if (!previous || previous.fingerprint !== fingerprint) state.stable.set(image.name, { fingerprint, since: now });
    else if (!next && now - previous.since >= 2000) next = image;
  }
  return next;
};

const acquireWakeLock = async () => {
  if (!navigator.wakeLock || document.visibilityState !== "visible") return;
  try { state.wakeLock = await navigator.wakeLock.request("screen"); } catch {}
};

const recordRunError = async error => {
  let detail = error.message || String(error);
  if (state.current && state.current.status !== "completed") {
    try {
      state.current = await updateJob(state.root, state.current, { error: detail, errorCode: error.code || "RUN_ERROR" });
    } catch (journalError) {
      detail += ` The recovery journal also needs attention: ${journalError.message}`;
    }
  }
  setStatus("error", "Queue paused", detail);
};

const runLoop = async () => {
  while (!state.stop) {
    await refreshQueue();
    if (state.options.limit && state.completed >= state.options.limit) {
      setStatus("idle", "Run complete", `${state.completed} model${state.completed === 1 ? "" : "s"} saved. Increase Models this run, or set it to 0, to continue with the remaining images.`);
      return;
    }
    if (!state.current) {
      const next = stableImage();
      if (!next) {
        if (!state.images.length && !state.options.watch) {
          setStatus("idle", "Folder complete", `${state.completed} model${state.completed === 1 ? "" : "s"} saved this run. Add more root images whenever you are ready.`);
          return;
        }
        setStatus("running", state.images.length ? "Checking newly added images" : "Watching your folder", state.images.length ? "Waiting for root image files to stop changing before uploading." : "Add PNG, JPG or WebP images to the root. New files are checked every ten seconds.");
        await sleep(state.images.length ? 2500 : 1000);
        if (!state.images.length) {
          for (let i = 0; i < 9 && !state.stop; i++) await sleep(1000);
        }
        continue;
      }
      state.current = await createJob(state.root, next.name);
    }
    await processCurrent();
    const cleanupWarning = state.current?.cleanupWarning;
    state.completed += 1;
    state.current = null;
    await refreshQueue();
    if (cleanupWarning) {
      setStatus("error", "Model saved; cleanup needs attention", cleanupWarning);
      return;
    }
  }
  setStatus("idle", "Stopped after the current model", `${state.completed} model${state.completed === 1 ? "" : "s"} saved this run. Start again to continue the root images.`);
};

const startRun = async (control = {}) => {
  if (state.running || state.starting) return;
  state.starting = true;
  updateControls();
  try {
    await requestFolderPermission(control.remote === true);
    if (!state.tabId && !hasSavedExport(state.current)) await refreshTabs();
    if (!state.tabId && !hasSavedExport(state.current)) throw errorWith("No Tripo Studio tab was found. Open your signed-in Studio Generate page, click Refresh tabs, then resume. Nothing was uploaded or generated.", "STUDIO_REQUIRED");
    state.options = settings();
    await chrome.storage.local.set({ options: state.options, tabId: state.tabId });
    await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async lock => {
      if (!lock) throw errorWith("Another GPT Images to Tripo3d tab is already running. Stop that run before starting this one.", "RUN_ALREADY_ACTIVE");
      state.running = true;
      state.starting = false;
      state.stop = false;
      state.completed = 0;
      control.accept?.();
      state.stable.clear();
      updateControls();
      await acquireWakeLock();
      try {
        await runLoop();
      } catch (error) {
        await recordRunError(error);
      } finally {
        state.running = false;
        await state.wakeLock?.release().catch(() => {});
        state.wakeLock = null;
        try { await refreshQueue(); } catch (error) { setStatus("error", "Folder needs attention", error.message); }
        updateControls();
      }
    });
  } catch (error) {
    control.reject?.(error);
    setStatus("error", "Could not start the queue", error.message);
  } finally {
    state.starting = false;
    updateControls();
  }
};

const bindSelectedModel = async () => {
  if (state.running || state.starting || !state.current) return;
  const target = { root: state.root, tabId: state.tabId, jobId: state.current.id };
  state.starting = true;
  updateControls();
  try {
    await requestFolderPermission();
    await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async lock => {
      if (!lock) throw errorWith("Another GPT Images to Tripo3d tab is already running.", "RUN_ALREADY_ACTIVE");
      if (state.root !== target.root || state.tabId !== target.tabId || state.current?.id !== target.jobId) throw errorWith("The selected folder or job changed. Select its model again.", "JOB_CHANGED");
      const latest = await getJob(target.root, target.jobId);
      if (!latest || latest.status === "completed") throw errorWith("This job has already completed or changed in another control tab. Rescan the folder.", "JOB_CHANGED");
      state.current = latest;
      const info = await ensureStudio();
      if (!info.exportReady || !info.baseline?.modelId) throw errorWith("Select this image’s finished model in Studio and wait until Export is available, then try again.", "MODEL_NOT_READY");
      if (hasSavedExport(latest) && latest.modelId && latest.modelId !== info.baseline.modelId) throw errorWith("This folder already contains files from a saved model. Select that same model before resuming its export.", "MODEL_MISMATCH");
      const selected = info.baseline.modelId;
      if (!hasSavedExport(latest) && latest.baseline && (selected === latest.baseline.modelId || (latest.baseline.assetIds || []).includes(selected))) throw errorWith("The selected model already existed before Generate was clicked for this image, so it belongs to another image. Select the model generated from this image, use Regenerate, or import its FBX/ZIP.", "MODEL_PREDATES_JOB");
      const other = (await listJobs(target.root)).find(job => job.id !== latest.id && job.status === "completed" && job.modelId === selected);
      if (other) throw errorWith(`The selected model is already saved for ${other.sourceName}. Select the model generated from this image, use Regenerate, or import its FBX/ZIP.`, "MODEL_ALREADY_USED");
      await saveJob({ status: hasSavedExport(latest) ? latest.status : "generating", modelUrl: modelURL(info.url), modelId: info.baseline.modelId, manualBinding: true, baseline: latest.baseline || info.baseline, error: null, errorCode: null });
    });
  } finally {
    state.starting = false;
    updateControls();
  }
  await startRun();
};

const regenerateJob = async () => {
  if (state.running || state.starting || !state.current) return;
  const target = { root: state.root, tabId: state.tabId, jobId: state.current.id };
  if (!window.confirm("Generate this image again in Studio? Use this only if Studio shows no model for it. Credits may be charged again.")) return;
  state.starting = true;
  updateControls();
  try {
    await requestFolderPermission();
    await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async lock => {
      if (!lock) throw errorWith("Another GPT Images to Tripo3d tab is already running.", "RUN_ALREADY_ACTIVE");
      if (state.root !== target.root || state.tabId !== target.tabId || state.current?.id !== target.jobId) throw errorWith("The selected folder or job changed. Try again.", "JOB_CHANGED");
      const latest = await getJob(target.root, target.jobId);
      if (!latest || latest.status === "completed") throw errorWith("This job has already completed or changed in another control tab. Rescan the folder.", "JOB_CHANGED");
      state.current = latest;
      if (!["submitting", "generating"].includes(latest.status) || hasSavedExport(latest) || (latest.modelId && latest.errorCode !== "MODEL_UNAVAILABLE")) throw errorWith("This job already has a model or saved export. Use Resume instead.", "JOB_CHANGED");
      await ensureStudio();
      if (latest.modelId) {
        if (!latest.modelUrl) throw errorWith("The saved model link is missing. Check Studio before trying again.", "MODEL_IDENTITY_MISSING");
        let confirmed = false;
        const deadline = Date.now() + 20000;
        for (let attempt = 0; Date.now() < deadline; attempt++) {
          const info = await studioMessage("tripo:status", { jobId: latest.id, baseline: latest.baseline, modelUrl: latest.modelUrl, resetUnavailableCheck: attempt === 0 }, Math.min(5000, deadline - Date.now()));
          if (info.state === "failed" && info.code === "MODEL_UNAVAILABLE") { confirmed = true; break; }
          if (info.state !== "waiting") break;
          if (Date.now() < deadline) await sleep(Math.min(1000, deadline - Date.now()));
        }
        if (!confirmed) throw errorWith("Studio did not confirm that the saved model is unavailable. Check the model and use Resume.", "MODEL_NOT_CONFIRMED_UNAVAILABLE");
      }
      await studioMessage("tripo:forget-job", { jobId: latest.id }, 5000);
      await saveJob({ status: "uploaded", baseline: null, submittedAt: null, modelUrl: null, modelId: null, error: null, errorCode: null });
    });
  } finally {
    state.starting = false;
    updateControls();
  }
  await startRun();
};

const importExport = async file => {
  if (!file || state.running || state.starting || !state.current) return;
  const target = state.importTarget;
  if (!target || state.root !== target.root || state.current.id !== target.jobId) throw errorWith("The selected folder or job changed while the file picker was open. Choose the downloaded export again for the current job.", "JOB_CHANGED");
  state.starting = true;
  updateControls();
  try {
    await requestFolderPermission();
    await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async lock => {
      if (!lock) throw errorWith("Another GPT Images to Tripo3d tab is already running.", "RUN_ALREADY_ACTIVE");
      const latest = await getJob(target.root, target.jobId);
      if (!latest || latest.status === "completed") throw errorWith("This job has already completed or changed in another control tab. Rescan the folder.", "JOB_CHANGED");
      state.current = latest;
      state.running = true;
      state.starting = false;
      state.stop = false;
      updateControls();
      try {
        setStatus("running", `Saving ${state.current.sourceName}`, "Verifying the downloaded FBX/ZIP and completing this image’s folder.");
        state.current = await commitExport(target.root, latest, file, file.name);
        const folder = state.current.folderName;
        const cleanupWarning = state.current.cleanupWarning;
        state.current = null;
        await refreshQueue();
        setStatus(cleanupWarning ? "error" : "idle", cleanupWarning ? "Model saved; cleanup needs attention" : "Downloaded model saved", cleanupWarning || `The original image and model are now in ${folder}/. Start the queue to continue with other images.`);
      } catch (error) {
        await recordRunError(error);
      } finally {
        state.running = false;
        await refreshQueue();
        updateControls();
      }
    });
  } finally {
    state.starting = false;
    state.importTarget = null;
    updateControls();
  }
};

const event = (id, type, action) => $(id).addEventListener(type, async value => {
  try { await action(value); }
  catch (error) { if (error.name !== "AbortError") setStatus("error", "Needs attention", error.message || String(error)); }
});

const setupAction = action => async value => {
  if (state.running || state.starting) return;
  state.starting = true;
  updateControls();
  try { await action(value); }
  finally { state.starting = false; updateControls(); }
};

event("choose-folder", "click", setupAction(async () => {
  if (gpt?.busy()) throw errorWith("The GPT images queue is running. Stop it before changing the folder.", "GPT_RUNNING");
  if (!window.showDirectoryPicker) throw errorWith("This browser does not expose folder access. Use a current desktop Chrome browser.", "FOLDER_API_MISSING");
  const handle = await window.showDirectoryPicker({ mode: "readwrite", id: "tripo-source-folder" });
  state.root = handle;
  state.permission = true;
  state.current = null;
  state.stable.clear();
  await setPreference("folder", handle);
  await refreshQueue();
  setStatus("idle", state.current ? "A saved job is ready to resume" : "Folder connected", state.current ? "Start resumes the interrupted job before processing new root images." : "Choose your Studio tab and generation settings, then start the batch.");
}));
event("grant-folder", "click", setupAction(async () => { await requestFolderPermission(); await refreshQueue(); setStatus("idle", "Folder reconnected", "Start to resume existing work or process root images."); }));
event("refresh-studio", "click", setupAction(refreshTabs));
event("studio-select", "change", setupAction(async () => { state.tabId = Number($("studio-select").value) || null; await chrome.storage.local.set({ tabId: state.tabId }); await refreshTabs(); }));
const openStudio = async () => { const tab = await chrome.tabs.create({ url: "https://studio.tripo3d.ai/workspace/generate" }); state.tabId = tab.id; await refreshTabs(); };
event("open-studio", "click", setupAction(openStudio));
event("start", "click", startRun);
event("resume", "click", startRun);
event("stop", "click", () => { state.stop = true; updateControls(); $("status-detail").textContent += " Stop requested; the current model will finish first."; });
event("rescan", "click", setupAction(refreshQueue));
event("bind-model", "click", bindSelectedModel);
event("regenerate", "click", regenerateJob);
event("import-export", "click", () => { if (!state.current || state.running || state.starting) return; state.importTarget = { root: state.root, jobId: state.current.id }; $("export-file").value = ""; $("export-file").click(); });
event("export-file", "change", value => importExport(value.target.files[0]));
for (const id of ["max-credits", "model-limit", "watch-folder"]) event(id, "change", async () => { await chrome.storage.local.set({ options: settings() }); });
window.addEventListener("beforeunload", event => { if (state.running) { event.preventDefault(); event.returnValue = ""; } });
document.addEventListener("visibilitychange", () => { if (state.running && document.visibilityState === "visible") acquireWakeLock(); });

const initialize = async () => {
  const results = await Promise.allSettled([getPreference("folder"), chrome.storage.local.get(["options", "tabId"])]);
  if (results[0].status === "fulfilled") state.root = results[0].value || null;
  if (results[1].status === "fulfilled") {
    const saved = results[1].value;
    state.tabId = saved.tabId || null;
    if (saved.options) {
      $("max-credits").value = String(saved.options.maxCredits ?? 55);
      $("model-limit").value = String(saved.options.limit ?? 1);
      $("watch-folder").checked = saved.options.watch !== false;
    }
  }
  if (state.root) state.permission = await state.root.queryPermission({ mode: "readwrite" }) === "granted";
  await refreshQueue();
  await refreshTabs();
  if (state.root && !state.permission) setStatus("idle", "Reconnect your source folder", "Click Reconnect folder to restore access to your saved folder.");
  else if (state.current) setStatus("idle", "An interrupted job is ready to resume", state.current.error || "The saved generation will be checked before new work is started.");
  else if (state.root) setStatus("idle", "Ready to start", "Review the settings in Studio. The first run defaults to one model so you can check the output.");
  renderQueue();
};

const showView = name => {
  for (const view of ["tripo", "gpt"]) {
    $(`view-${view}`).hidden = view !== name;
    $(`tab-${view}`).setAttribute("aria-selected", String(view === name));
    $(`tab-${view}`).tabIndex = view === name ? 0 : -1;
  }
  chrome.storage.local.set({ view: name }).catch(() => {});
};
$("tab-tripo").addEventListener("click", () => showView("tripo"));
$("tab-gpt").addEventListener("click", () => showView("gpt"));
$("folder-settings").addEventListener("click", () => { showView("tripo"); $("choose-folder").focus(); });
for (const id of ["tab-gpt", "tab-tripo"]) $(id).addEventListener("keydown", event => {
  const name = event.key === "Home" ? "gpt" : event.key === "End" ? "tripo" : ["ArrowLeft", "ArrowRight"].includes(event.key) ? (id === "tab-gpt" ? "tripo" : "gpt") : null;
  if (!name) return;
  event.preventDefault();
  showView(name);
  $(`tab-${name}`).focus();
});
chrome.storage.local.get("view").then(saved => { if (saved.view === "gpt" || saved.view === "tripo") showView(saved.view); }).catch(() => {});

gpt = setupGPT({
  getRoot: () => state.root,
  ensurePermission: requestFolderPermission,
  onSaved: async () => { if (!state.running && !state.starting) await refreshQueue().catch(() => {}); }
});

tripoFilters = setupQueueTabs($("tripo-filters"), renderQueue);
updateControls();
let setupError = null;
const ready = initialize().catch(error => { setupError = error; setStatus("error", "Setup needs attention", error.message); }).finally(() => { state.starting = false; updateControls(); });

const requireIdle = () => { if (state.running || state.starting) throw errorWith("Tripo queue is busy.", "RUN_ALREADY_ACTIVE"); };
const launch = action => new Promise((resolve, reject) => { action({ remote: true, accept: () => resolve({ accepted: true, asynchronous: true }), reject }).catch(reject); });
const executeRemote = async (name, args) => {
  validateTool(name, args);
  await ready;
  await gpt.ready;
  if (setupError && name !== "runner_status") throw setupError;
  const offset = args.offset || 0;
  const limit = args.limit || 25;
  if (name === "runner_status") return {
    setupError: setupError?.message || null, page: { offset, limit },
    folder: { name: state.root?.name || null, permission: state.root ? await state.root.queryPermission({ mode: "readwrite" }) : "denied", configured: !!state.root?._remote },
    gpt: gpt.snapshot(offset, limit, args.requestId), tripo: { running: state.running, starting: state.starting, stopRequested: state.stop, currentJob: state.current, jobs: state.jobs.slice(offset, offset + limit), jobCount: state.jobs.length, images: state.images.slice(offset, offset + limit), imageCount: state.images.length, settings: settings(), tabId: state.tabId, status: $("status-title").textContent, detail: $("status-detail").textContent },
    tabs: (await chrome.tabs.query({ url: [...STUDIO_PATTERNS, "https://chatgpt.com/*"] })).map(({ id, title, url }) => ({ id, title, url }))
  };
  if (name === "runner_open_tab" && args.queue === "gpt") return gpt.openTab();
  if (name === "runner_open_tab") { requireIdle(); await openStudio(); return { tabId: state.tabId }; }
  if (name === "runner_add_prompts") return gpt.addPrompts(args.prompts, args.requestId);
  if (name === "runner_clear_finished") return gpt.clearFinished(args.requestId);
  if (name === "runner_prompt_action") return gpt.promptAction(args.id, args.action, args.requestId);
  if (name === "runner_start") {
    if (args.queue === "gpt") return gpt.startRemote(args.requestId);
    requireIdle();
    return launch(startRun);
  }
  if (name === "runner_stop") {
    if (args.queue === "gpt") return gpt.stop(args.requestId);
    if (!state.running) throw new Error("Tripo queue is not running.");
    state.stop = true; updateControls(); return { stopRequested: true };
  }
  if (name === "runner_select_tab" && args.queue === "gpt") return gpt.selectTab(args.tabId);
  requireIdle();
  if (name === "runner_rescan") { await requestFolderPermission(true); await refreshQueue(); return { images: state.images.length, jobs: state.jobs.length }; }
  if (name === "runner_select_tab") {
    const tabs = await chrome.tabs.query({ url: STUDIO_PATTERNS });
    if (!tabs.some(tab => tab.id === args.tabId)) throw new Error("Select an existing Studio tab from runner_status.");
    state.tabId = args.tabId; await chrome.storage.local.set({ tabId: state.tabId }); await refreshTabs(); return { tabId: state.tabId };
  }
  if (name === "runner_settings") {
    if (args.maxCredits !== undefined) $("max-credits").value = String(args.maxCredits);
    if (args.limit !== undefined) $("model-limit").value = String(args.limit);
    if (args.watch !== undefined) $("watch-folder").checked = args.watch;
    const options = settings(); await chrome.storage.local.set({ options }); return options;
  }
  throw new Error("Unsupported command.");
};
const mcp = setupMCP({ execute: executeRemote, waitUntilReady: () => Promise.all([ready, gpt.ready]), setFolder: async root => {
  await ready;
  if (state.running || state.starting || gpt.busy()) throw new Error("Stop queues before switching to configured output directory.");
  state.root = root; state.permission = true; state.current = null; state.stable.clear();
  await refreshQueue(); setupError = null; updateControls();
  setStatus("idle", state.current ? "A saved job is ready to resume" : "Output folder connected", state.current ? "Start resumes the interrupted job before processing new root images." : "Ready for images. Choose Studio settings before starting models.");
} });
ready.then(() => mcp.connect()).catch(() => {});

chrome.runtime.onMessage.addListener(message => { if (message.type === "runner:mcp-discover") mcp.connect(); });
