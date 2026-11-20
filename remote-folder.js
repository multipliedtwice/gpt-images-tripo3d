const entryName = value => {
  if (typeof value !== "string" || !value || [".", ".."].includes(value) || /[/\\\0]/.test(value)) throw new DOMException("Use a single file or folder name.", "TypeError");
  return value;
};
export const createRemoteFolder = ({ url, token, name, extensionId = globalThis.chrome?.runtime?.id || "" }) => {
  const request = async (path, options = {}) => {
    const response = await fetch(`${url}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, "X-Runner-Extension-ID": extensionId, ...options.headers } });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new DOMException(result.error || `Folder request failed (${response.status}).`, result.name || "NotAllowedError");
    }
    return response;
  };
  const op = async data => (await request("/fs/op", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })).json();
  const handle = (path, kind, label) => {
    const common = { name: label, kind, _remote: true, queryPermission: async () => (await op({ op: "permission", path })).permission, requestPermission: async () => (await op({ op: "permission", path })).permission };
    if (kind === "file") return {
      ...common,
      async getFile() {
        const response = await request(`/fs/file?path=${encodeURIComponent(path)}`);
        const bytes = await response.blob();
        return new File([bytes], label, { lastModified: Number(response.headers.get("X-Runner-Last-Modified")) || 0 });
      },
      async createWritable() {
        let chunks = [];
        let finished = false;
        let size = 0;
        return {
          async write(data) {
            if (finished) throw new DOMException("Writable is closed.", "InvalidStateError");
            if (!(typeof data === "string" || data instanceof Blob || data instanceof ArrayBuffer || ArrayBuffer.isView(data))) throw new DOMException("Unsupported write data.", "NotSupportedError");
            const chunk = new Blob([data]);
            if (size + chunk.size > 1024 * 1024 * 1024) throw new DOMException("File exceeds 1 GiB.", "QuotaExceededError");
            chunks.push(chunk);
            size += chunk.size;
          },
          async close() {
            if (finished) throw new DOMException("Writable is closed.", "InvalidStateError");
            finished = true;
            const body = new Blob(chunks);
            chunks = [];
            await request(`/fs/write?path=${encodeURIComponent(path)}`, { method: "POST", body });
          },
          async abort() { finished = true; chunks = []; }
        };
      }
    };
    const child = value => path ? `${path}/${entryName(value)}` : entryName(value);
    return {
      ...common,
      async getFileHandle(value, options = {}) { const next = child(value); await op({ op: "entry", path: next, kind: "file", create: options.create === true }); return handle(next, "file", value); },
      async getDirectoryHandle(value, options = {}) { const next = child(value); await op({ op: "entry", path: next, kind: "directory", create: options.create === true }); return handle(next, "directory", value); },
      async removeEntry(value, options = {}) { await op({ op: "remove", path: child(value), recursive: options.recursive === true }); },
      async *entries() { const { entries } = await op({ op: "entries", path }); for (const entry of entries) yield [entry.name, handle(child(entry.name), entry.kind, entry.name)]; },
      async *values() { for await (const [, value] of this.entries()) yield value; },
      async *keys() { for await (const [key] of this.entries()) yield key; }
    };
  };
  return handle("", "directory", name);
};
