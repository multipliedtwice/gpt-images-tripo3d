const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;

const captureError = message => Object.assign(new Error(message), { code: "EXPORT_TRANSFER_FAILED" });

const remoteURL = raw => {
  const url = new URL(raw);
  const local = /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i.test(url.hostname);
  if (url.protocol !== "https:" || url.username || url.password || local) throw captureError("The captured export URL is not a supported HTTPS download.");
  return url.href;
};

const downloadBlob = async (url, signal, onProgress) => {
  const response = await fetch(remoteURL(url), { signal, credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) throw captureError(`The export download returned HTTP ${response.status}. Retry exporting the existing model.`);
  const length = Number(response.headers.get("content-length"));
  if (length > MAX_PACKAGE_BYTES) throw captureError("This export exceeds the 512 MiB package limit.");
  const mime = response.headers.get("content-type") || "application/octet-stream";
  if (/text\/html|application\/json/i.test(mime)) throw captureError("The export link returned a web page or API message instead of a model. Retry exporting the existing model.");
  if (!response.body) throw captureError("The export download did not contain a readable file.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PACKAGE_BYTES) throw captureError("This export exceeds the 512 MiB package limit.");
      chunks.push(value);
      onProgress(size, length || null);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (!size) throw captureError("The export download is empty.");
  return new Blob(chunks, { type: mime });
};

export const receiveExport = ({ jobId, tabId, timeout = 5 * 60 * 1000, onProgress = () => {} }) => {
  let resolve;
  let reject;
  let settled = false;
  let captureId = null;
  let mode = null;
  let metadata = null;
  let bytes = 0;
  let chunks = [];
  const abort = new AbortController();
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    chunks = [];
    if (error) {
      abort.abort();
      reject(error);
    } else {
      resolve(value);
    }
  };
  const timer = setTimeout(() => finish(captureError("No complete export arrived within five minutes. Retry export, or download the FBX/ZIP in Studio and use “Use downloaded FBX/ZIP”. The original image is still in the root.")), timeout);
  const accept = message => {
    if (settled) throw captureError("This export transfer is already closed.");
    if (typeof message.captureId !== "string" || !message.captureId || message.captureId.length > 100) throw captureError("The export capture identifier is invalid.");
    if (captureId && message.captureId !== captureId) throw captureError("Another export arrived while this job was receiving its model.");
    captureId = message.captureId;
    if (message.kind === "error") throw captureError(String(message.error || "Studio could not transfer the exported file."));
    if (message.kind === "url") {
      if (mode) throw captureError("A second export transfer was received for this image.");
      mode = "url";
      const url = remoteURL(message.url);
      const name = typeof message.name === "string" ? message.name.slice(0, 512) : "model.fbx";
      downloadBlob(url, abort.signal, onProgress).then(blob => finish(null, { blob, name })).catch(error => finish(error));
      return;
    }
    if (message.kind === "begin") {
      if (mode) throw captureError("A second export transfer was received for this image.");
      if (!Number.isSafeInteger(message.size) || message.size <= 0 || message.size > MAX_PACKAGE_BYTES) throw captureError("The export is empty or exceeds the 512 MiB package limit.");
      mode = "chunks";
      metadata = { size: message.size, name: String(message.name || "model.fbx").slice(0, 512), mime: String(message.mime || "application/octet-stream").slice(0, 150) };
      return;
    }
    if (message.kind === "chunk") {
      if (mode !== "chunks" || !metadata || message.index !== chunks.length || typeof message.base64 !== "string" || message.base64.length > 350000) throw captureError("The exported file arrived out of order or with an invalid chunk.");
      const binary = atob(message.base64);
      if (!binary.length || binary.length > MAX_CHUNK_BYTES) throw captureError("The exported file contains an invalid chunk size.");
      const data = Uint8Array.from(binary, character => character.charCodeAt(0));
      bytes += data.byteLength;
      if (bytes > metadata.size || bytes > MAX_PACKAGE_BYTES) throw captureError("The exported file is larger than its declared size.");
      chunks.push(data);
      onProgress(bytes, metadata.size);
      return;
    }
    if (message.kind === "end") {
      if (mode !== "chunks" || message.chunks !== chunks.length || bytes !== metadata?.size) throw captureError("The export transfer is incomplete. The original image has been kept.");
      const blob = new Blob(chunks, { type: metadata.mime });
      finish(null, { blob, name: metadata.name });
      return;
    }
    throw captureError("An unsupported export-transfer message was received.");
  };
  const listener = (message, sender, respond) => {
    if (message?.type !== "tripo:export-captured" || sender.id !== chrome.runtime.id || sender.tab?.id !== tabId || message.jobId !== jobId) return false;
    try {
      accept(message);
      respond({ ok: true });
    } catch (error) {
      finish(error);
      respond({ ok: false, error: error.message });
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(listener);
  return {
    promise,
    close() {
      chrome.runtime.onMessage.removeListener(listener);
      if (!settled) finish(captureError("The export capture was stopped. Resume the existing model to export again."));
      abort.abort();
    }
  };
};
