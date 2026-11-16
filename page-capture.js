(() => {
  if (window.__tripoFolderCaptureInstalled) return;
  window.__tripoFolderCaptureInstalled = true;

  const CONTENT_SOURCE = 'tripo-folder-content';
  const PAGE_SOURCE = 'tripo-folder-page';
  const CHUNK_BYTES = 256 * 1024;
  const MAX_BYTES = 512 * 1024 * 1024;
  const originalClick = HTMLAnchorElement.prototype.click;
  const originalOpen = window.open;
  const pending = new Map();
  let active = null;
  let sequence = 0;
  let bypass = false;

  const post = (state, payload) => window.postMessage({ source: PAGE_SOURCE, token: state.token, jobId: state.jobId, ...payload }, location.origin);

  const emit = (state, payload) => new Promise((resolve, reject) => {
    if (active !== state || Date.now() > state.expiresAt) {
      reject(new Error('The export capture expired. Retry exporting the existing model.'));
      return;
    }
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('GPT Images to Tripo3d did not acknowledge the export data. Keep its tab open and retry export.'));
    }, 45000);
    pending.set(id, { token: state.token, resolve, reject, timer });
    post(state, { ...payload, sequence: id });
  });

  const clearPending = message => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    pending.clear();
  };

  const fileName = (raw, suggested) => {
    if (suggested) return String(suggested).split(/[\\/]/).pop().slice(0, 240);
    try {
      const url = new URL(raw, location.href);
      const disposition = url.searchParams.get('response-content-disposition') || '';
      const match = disposition.match(/filename\*?\s*=\s*(?:UTF-8''|["'])?([^"';\r\n]+)/i);
      if (match) return decodeURIComponent(match[1]).split(/[\\/]/).pop().slice(0, 240);
      return decodeURIComponent(url.pathname.split('/').pop() || '').slice(0, 240);
    } catch {
      return '';
    }
  };

  const candidate = (raw, suggested, isDownload) => {
    if (!active || active.claimed || bypass || Date.now() > active.expiresAt || typeof raw !== 'string') return null;
    let url;
    try {
      url = new URL(raw, location.href);
    } catch {
      return null;
    }
    if (!['https:', 'blob:', 'data:'].includes(url.protocol)) return null;
    if (url.protocol === 'data:' && !/^data:application\//i.test(raw)) return null;
    const name = fileName(raw, suggested);
    const namedModel = /\.(fbx|zip)(?:$|[?#])/i.test(name) || /\.(fbx|zip)$/i.test(url.pathname);
    const anonymousBlob = (url.protocol === 'blob:' || url.protocol === 'data:') && isDownload && (!name || !/\.[a-z0-9]{2,5}$/i.test(name));
    if (!namedModel && !anonymousBlob) return null;
    return { url: url.href, name: namedModel && name ? name : 'tripo-export.bin', blob: url.protocol !== 'https:' };
  };

  const toBase64 = bytes => {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(binary);
  };

  const deliver = async (state, match) => {
    const captureId = crypto.randomUUID();
    state.captureId = captureId;
    if (!match.blob) {
      await emit(state, { type: 'capture', kind: 'url', captureId, url: match.url, name: match.name });
      return;
    }
    const response = await fetch(match.url);
    if (!response.ok) throw new Error(`The export blob could not be read (${response.status}).`);
    const blob = await response.blob();
    if (!blob.size || blob.size > MAX_BYTES) throw new Error('The export is empty or exceeds the 512 MiB capture limit. Use the downloaded file instead.');
    await emit(state, { type: 'capture', kind: 'begin', captureId, name: match.name, mime: blob.type || 'application/octet-stream', size: blob.size });
    let chunks = 0;
    for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
      await emit(state, { type: 'capture', kind: 'chunk', captureId, index: chunks, base64: toBase64(bytes) });
      chunks += 1;
    }
    await emit(state, { type: 'capture', kind: 'end', captureId, chunks });
  };

  const intercept = (raw, name, isDownload, fallback) => {
    const match = candidate(raw, name, isDownload);
    if (!match) return false;
    const state = active;
    state.claimed = true;
    post(state, { type: 'capturing' });
    deliver(state, match).catch(error => {
      if (state.cancelled) return;
      post(state, { type: 'capture', kind: 'error', captureId: state.captureId || crypto.randomUUID(), error: String(error.message || error) });
      bypass = true;
      try {
        fallback();
      } finally {
        bypass = false;
      }
    });
    return true;
  };

  HTMLAnchorElement.prototype.click = function (...args) {
    if (intercept(this.href, this.download, this.hasAttribute('download'), () => originalClick.apply(this, args))) return;
    return originalClick.apply(this, args);
  };

  document.addEventListener('click', event => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor || event.defaultPrevented) return;
    if (intercept(anchor.href, anchor.download, anchor.hasAttribute('download'), () => originalClick.call(anchor))) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  window.open = function (url, ...args) {
    if (typeof url === 'string' && intercept(url, '', false, () => originalOpen.call(window, url, ...args))) return null;
    return originalOpen.call(window, url, ...args);
  };

  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || !data || data.source !== CONTENT_SOURCE) return;
    if (data.type === 'arm' && /^[a-f0-9]{32}$/.test(data.token || '') && typeof data.jobId === 'string') {
      if (active) active.cancelled = true;
      clearPending('The export capture was replaced.');
      active = { token: data.token, jobId: data.jobId, expiresAt: Math.min(Number(data.expiresAt) || 0, Date.now() + 10 * 60 * 1000), claimed: false };
      post(active, { type: 'armed' });
    } else if (data.type === 'disarm' && active && data.token === active.token) {
      active.cancelled = true;
      active = null;
      clearPending('The export capture was stopped.');
    } else if (data.type === 'ack') {
      const entry = pending.get(data.sequence);
      if (!entry || entry.token !== data.token) return;
      pending.delete(data.sequence);
      clearTimeout(entry.timer);
      if (data.ok === false) entry.reject(new Error(data.error || 'GPT Images to Tripo3d could not accept the export data.'));
      else entry.resolve();
    }
  });
})();
