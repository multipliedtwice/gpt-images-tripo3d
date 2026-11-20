import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFolderService } from "../mcp/folder.js";
import { createRemoteFolder } from "../remote-folder.js";

const fixture = async context => {
  const temp = await mkdtemp(join(tmpdir(), "runner-folder-test-"));
  const rootPath = join(temp, "root");
  await mkdir(rootPath);
  const service = await createFolderService(rootPath);
  const server = http.createServer((req, res) => service.handle(req, res));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  context.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await service.close(); await rm(temp, { recursive: true, force: true }); });
  return { temp, rootPath, url, root: createRemoteFolder({ url, token: "test", name: service.name }) };
};

test("configured folder supports runner directory and file operations", async context => {
  const { root, rootPath } = await fixture(context);
  assert.equal(root._remote, true);
  assert.equal(await root.queryPermission({ mode: "readwrite" }), "granted");
  const directory = await root.getDirectoryHandle("models", { create: true });
  const file = await directory.getFileHandle("crate.fbx", { create: true });
  assert.equal((await file.getFile()).size, 0);
  const writable = await file.createWritable();
  await writable.write(new Uint8Array([1, 2, 3]));
  await writable.write(new Blob(["texture"]));
  await writable.close();
  const saved = await file.getFile();
  assert.equal(saved.name, "crate.fbx");
  assert.ok(saved.lastModified > 0);
  assert.deepEqual([...new Uint8Array(await saved.slice(0, 3).arrayBuffer())], [1, 2, 3]);
  assert.equal(await saved.slice(3).text(), "texture");
  assert.deepEqual([...await readFile(join(rootPath, "models", "crate.fbx"))], [...new Uint8Array(await saved.arrayBuffer())]);
  const entries = [];
  for await (const [name, handle] of root.entries()) entries.push([name, handle.kind]);
  assert.deepEqual(entries, [["models", "directory"]]);
  const values = [];
  for await (const value of directory.values()) values.push(value.name);
  assert.deepEqual(values, ["crate.fbx"]);
  await directory.removeEntry("crate.fbx");
  await root.removeEntry("models");
  assert.deepEqual(await readdir(rootPath), []);
});

test("aborted writable preserves original file and leaves no temporary files", async context => {
  const { root, rootPath } = await fixture(context);
  await writeFile(join(rootPath, "original.png"), "original");
  const handle = await root.getFileHandle("original.png");
  const writable = await handle.createWritable();
  await writable.write("replacement");
  await writable.abort();
  await assert.rejects(writable.close(), { name: "InvalidStateError" });
  assert.equal(await readFile(join(rootPath, "original.png"), "utf8"), "original");
  assert.deepEqual(await readdir(rootPath), ["original.png"]);
});

test("folder errors retain File System Access names and reject traversal", async context => {
  const { root, rootPath, url } = await fixture(context);
  await mkdir(join(rootPath, "directory"));
  await writeFile(join(rootPath, "file"), "value");
  await assert.rejects(root.getFileHandle("absent"), { name: "NotFoundError" });
  await assert.rejects(root.getFileHandle("directory"), { name: "TypeMismatchError" });
  await assert.rejects(root.getDirectoryHandle("file"), { name: "TypeMismatchError" });
  for (const name of ["../outside", "..", "/absolute", "a\\b", ""]) await assert.rejects(root.getFileHandle(name));
  const response = await fetch(`${url}/fs/op`, { method: "POST", body: JSON.stringify({ op: "entry", path: "../outside", kind: "file", create: true }) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).name, "NotAllowedError");
  const writeResponse = await fetch(`${url}/fs/write?path=`, { method: "POST", body: "overwrite root" });
  assert.equal(writeResponse.status, 400);
  assert.deepEqual((await readdir(rootPath)).sort(), ["directory", "file"]);
});

test("symlinks cannot expose or overwrite files outside configured folder", async context => {
  const { temp, rootPath, root, url } = await fixture(context);
  const outside = join(temp, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret"), "keep");
  await symlink(outside, join(rootPath, "link"));
  await symlink(join(outside, "secret"), join(rootPath, "filelink"));
  await assert.rejects(root.getDirectoryHandle("link"), { name: "NotAllowedError" });
  await assert.rejects(root.getFileHandle("filelink"), { name: "NotAllowedError" });
  const response = await fetch(`${url}/fs/write?path=${encodeURIComponent("link/secret")}`, { method: "POST", body: "changed" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).name, "NotAllowedError");
  assert.equal(await readFile(join(outside, "secret"), "utf8"), "keep");
  const entries = [];
  for await (const entry of root.entries()) entries.push(entry);
  assert.deepEqual(entries, []);
  await assert.rejects(createFolderService(join(rootPath, "link")), /not a symlink/);
});

test("local runner lifecycle writes and verifies staged files without picker", async context => {
  const { root } = await fixture(context);
  const { scanImages, createJob, listJobs, readSource, updateJob, commitExport } = await import("../files.js");
  const image = await root.getFileHandle("crate.png", { create: true });
  const writable = await image.createWritable();
  await writable.write(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  await writable.close();
  const images = await scanImages(root);
  assert.equal(images.length, 1);
  assert.equal(images[0].name, "crate.png");
  const job = await createJob(root, "crate.png");
  assert.equal(job.status, "prepared");
  assert.equal((await listJobs(root))[0].id, job.id);
  assert.equal((await readSource(root, "crate.png")).size, 8);
  const updated = await updateJob(root, job, { error: "manual fixture pause" });
  assert.equal(updated.error, "manual fixture pause");
  assert.equal((await listJobs(root))[0].error, "manual fixture pause");
  const model = new Blob(["; FBX 7.4.0 project file\nFBXHeaderExtension: { FBXVersion: 7400 }\n", " ".repeat(128)]);
  const completed = await commitExport(root, updated, model, "model.fbx");
  assert.equal(completed.status, "completed");
  await assert.rejects(root.getFileHandle("crate.png"), { name: "NotFoundError" });
  const output = await root.getDirectoryHandle(completed.folderName);
  assert.equal((await (await output.getFileHandle("crate.png")).getFile()).size, 8);
  assert.equal(await (await (await output.getFileHandle("crate.fbx")).getFile()).text(), await model.text());
});
