import { constants } from "node:fs";
import { lstat, realpath, open, mkdir, readdir, rename, unlink, rmdir } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";

const MAX_FILE = 1024 * 1024 * 1024;
const failure = (name, message) => Object.assign(new Error(message), { name });
const translated = error => {
  if (error.code === "ENOENT") return failure("NotFoundError", "File or folder no longer exists.");
  if (["ENOTDIR", "EISDIR"].includes(error.code)) return failure("TypeMismatchError", "Entry has a different type.");
  if (["EACCES", "EPERM", "ELOOP"].includes(error.code)) return failure("NotAllowedError", "Folder access denied.");
  if (["ENOTEMPTY", "EEXIST"].includes(error.code)) return failure("InvalidModificationError", "Folder is not empty or entry already exists.");
  return error;
};
const partsOf = value => {
  if (typeof value !== "string" || value.includes("\\") || value.includes("\0") || (value && (isAbsolute(value) || value.split("/").some(part => !part || part === "." || part === "..")))) throw failure("NotAllowedError", "Invalid folder-relative path.");
  return value ? value.split("/") : [];
};
const send = (res, status, data) => {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(data);
  if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw failure("QuotaExceededError", "Folder listing is too large.");
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
};
const readJSON = async req => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw failure("QuotaExceededError", "Folder request is too large.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw failure("SyntaxError", "Invalid folder request JSON."); }
};
export const createFolderService = async rootPath => {
  if (!isAbsolute(rootPath || "")) throw new Error("RUNNER_OUTPUT_DIR must be an absolute folder path.");
  const requested = resolve(rootPath);
  const initial = await lstat(requested);
  if (initial.isSymbolicLink() || !initial.isDirectory()) throw new Error("RUNNER_OUTPUT_DIR must be an existing directory, not a symlink.");
  const root = await realpath(requested);
  const rootInfo = await lstat(root);
  const temporary = new Set();
  let closed = false;
  const checkRoot = async () => {
    if (closed) throw failure("NotAllowedError", "Folder service is closed.");
    const current = await lstat(root);
    if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== rootInfo.dev || current.ino !== rootInfo.ino) throw failure("NotAllowedError", "Configured folder changed. Restart the MCP server.");
  };
  const checked = async (relative, missing = false) => {
    const parts = partsOf(relative);
    await checkRoot();
    let current = root;
    let info = rootInfo;
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]);
      try { info = await lstat(current); }
      catch (error) { if (error.code === "ENOENT" && missing && index === parts.length - 1) return { path: current, info: null }; throw error; }
      if (info.isSymbolicLink()) throw failure("NotAllowedError", "Symlink access is not permitted.");
      if (index < parts.length - 1 && !info.isDirectory()) throw failure("TypeMismatchError", "Parent entry is not a folder.");
    }
    return { path: current, info };
  };
  const verifyParent = async relative => {
    const parts = partsOf(relative);
    if (!parts.length) throw failure("NotAllowedError", "The configured folder cannot be replaced or removed.");
    const parent = await checked(parts.slice(0, -1).join("/"));
    if (!parent.info.isDirectory()) throw failure("TypeMismatchError", "Parent entry is not a folder.");
    return parent;
  };
  const operation = async data => {
    if (!data || typeof data !== "object") throw failure("TypeError", "Folder operation is required.");
    const relative = data.path;
    if (data.op === "permission") { await checked(relative); return { permission: "granted" }; }
    if (data.op === "entry") {
      if (!["file", "directory"].includes(data.kind)) throw failure("TypeError", "Entry kind is required.");
      if (data.create) await verifyParent(relative);
      let entry = await checked(relative, Boolean(data.create));
      if (!entry.info) {
        if (data.kind === "directory") await mkdir(entry.path);
        else { const file = await open(entry.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await file.close(); }
        entry = await checked(relative);
      }
      if (data.kind === "directory" ? !entry.info.isDirectory() : !entry.info.isFile()) throw failure("TypeMismatchError", "Entry has a different type.");
      return { kind: data.kind, name: basename(entry.path) };
    }
    if (data.op === "entries") {
      const entry = await checked(relative);
      if (!entry.info.isDirectory()) throw failure("TypeMismatchError", "Entry is not a folder.");
      const entries = [];
      for (const item of await readdir(entry.path, { withFileTypes: true })) {
        if (temporary.has(join(entry.path, item.name)) || item.isSymbolicLink() || (!item.isFile() && !item.isDirectory())) continue;
        entries.push({ name: item.name, kind: item.isDirectory() ? "directory" : "file" });
      }
      await checked(relative);
      return { entries };
    }
    if (data.op === "remove") {
      await verifyParent(relative);
      const entry = await checked(relative);
      if (entry.info.isDirectory()) {
        if (data.recursive) throw failure("NotSupportedError", "Recursive removal is unavailable through local control.");
        await rmdir(entry.path);
      } else if (entry.info.isFile()) await unlink(entry.path);
      else throw failure("NotAllowedError", "Unsupported entry type.");
      return {};
    }
    throw failure("NotSupportedError", "Unknown folder operation.");
  };
  const readFile = async (res, relative) => {
    const entry = await checked(relative);
    if (!entry.info.isFile()) throw failure("TypeMismatchError", "Entry is not a file.");
    const file = await open(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (info.ino !== entry.info.ino || info.dev !== entry.info.dev || !info.isFile()) throw failure("NotAllowedError", "File changed while opening.");
      if (info.size > MAX_FILE) throw failure("QuotaExceededError", "File exceeds 1 GiB.");
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": info.size, "Cache-Control": "no-store", "X-Runner-Last-Modified": String(info.mtimeMs), "Access-Control-Expose-Headers": "X-Runner-Last-Modified" });
      await pipeline(file.createReadStream(), res);
    } finally { await file.close().catch(() => {}); }
  };
  const writeFile = async (req, relative) => {
    const parent = await verifyParent(relative);
    const entry = await checked(relative);
    if (!entry.info.isFile()) throw failure("TypeMismatchError", "Entry is not a file.");
    const length = Number(req.headers["content-length"]);
    if (Number.isFinite(length) && length > MAX_FILE) throw failure("QuotaExceededError", "File exceeds 1 GiB.");
    const temp = join(parent.path, `.runner-write-${randomUUID()}.tmp`);
    temporary.add(temp);
    let file;
    try {
      file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_FILE) throw failure("QuotaExceededError", "File exceeds 1 GiB.");
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
          if (!bytesWritten) throw failure("NotReadableError", "File write made no progress.");
          offset += bytesWritten;
        }
      }
      await file.sync();
      await file.close();
      file = null;
      const currentParent = await verifyParent(relative);
      const current = await checked(relative);
      if (currentParent.info.ino !== parent.info.ino || currentParent.info.dev !== parent.info.dev || current.info.ino !== entry.info.ino || current.info.dev !== entry.info.dev || current.info.mtimeMs !== entry.info.mtimeMs || current.info.size !== entry.info.size) throw failure("InvalidModificationError", "File changed during write.");
      await rename(temp, entry.path);
    } finally {
      await file?.close().catch(() => {});
      await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; });
      temporary.delete(temp);
    }
  };
  return {
    name: basename(root),
    async handle(req, res) {
      const url = new URL(req.url, "http://127.0.0.1");
      if (!url.pathname.startsWith("/fs/")) return false;
      try {
        if (req.method === "POST" && url.pathname === "/fs/op") send(res, 200, await operation(await readJSON(req)));
        else if (req.method === "GET" && url.pathname === "/fs/file") await readFile(res, url.searchParams.get("path"));
        else if (req.method === "POST" && url.pathname === "/fs/write") { await writeFile(req, url.searchParams.get("path")); send(res, 200, {}); }
        else send(res, 405, { error: "Unsupported folder request.", name: "NotSupportedError" });
      } catch (caught) {
        const error = translated(caught);
        if (res.headersSent) res.destroy();
        else send(res, 400, { error: error.message, name: error.name });
      }
      return true;
    },
    async close() {
      closed = true;
      for (const path of temporary) await unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; });
      temporary.clear();
    }
  };
};
