import { inspectExport, safeArchivePath, sha256 } from './archive.js';

export const WORK_FOLDER = '.tripo-runner';
const IMAGE_PATTERN = /\.(png|jpe?g|webp)$/i;
const JOURNAL_PATTERN = /^state-(\d{8})\.json$/;
const SCHEMA = 1;
const TOOL = 'tripo-folder-runner';
const OWNER_FILE = '.tripo-runner-owner.json';

function fileError(message, code = 'FILESYSTEM_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isMissing(error) {
  return error?.name === 'NotFoundError';
}

function assertSourceName(name) {
  if (typeof name !== 'string' || !name || name.startsWith('.') || /[\\/\u0000]/.test(name) || !IMAGE_PATTERN.test(name)) throw fileError('Choose an image file from the selected folder’s root.');
  return name;
}

function assertJobId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9-]{16,80}$/i.test(id)) throw fileError('The recovery job identifier is invalid.');
  return id;
}

function assertFolderName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || name === WORK_FOLDER || /[\\/\u0000]/.test(name)) throw fileError('The output folder name is invalid.');
  return name;
}

export function outputStem(name) {
  let stem = String(name).replace(/\.[^.]*$/, '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[ .]+$/g, '').slice(0, 120).replace(/[ .]+$/g, '');
  if (!stem || /^\.+$/.test(stem)) stem = 'image';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
  return stem;
}

async function getFileHandleOrNull(directory, name) {
  try {
    return await directory.getFileHandle(name);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function readJson(directory, name) {
  const handle = await getFileHandleOrNull(directory, name);
  return handle ? JSON.parse(await (await handle.getFile()).text()) : null;
}

async function replacePrivateFile(directory, name, blob) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
  return handle;
}

async function workDirectory(root, create = false) {
  let directory;
  try {
    directory = await root.getDirectoryHandle(WORK_FOLDER, { create });
  } catch (error) {
    if (!create && isMissing(error)) return null;
    throw error;
  }
  let identity;
  try {
    identity = await readJson(directory, 'identity.json');
  } catch {
    throw fileError('The .tripo-runner recovery folder has invalid metadata.');
  }
  if (identity) {
    if (identity.tool !== TOOL || identity.schema !== SCHEMA) throw fileError('The .tripo-runner folder belongs to another format.');
    return directory;
  }
  for await (const unused of directory.values()) {
    if (unused) throw fileError('The existing .tripo-runner folder has no valid identity. Rename it before continuing.');
  }
  if (!create) return null;
  await replacePrivateFile(directory, 'identity.json', new Blob([JSON.stringify({ tool: TOOL, schema: SCHEMA })], { type: 'application/json' }));
  return directory;
}

async function jobDirectory(root, id, create = false) {
  const work = await workDirectory(root, create);
  if (!work) return null;
  try {
    return await work.getDirectoryHandle(assertJobId(id), { create });
  } catch (error) {
    if (!create && isMissing(error)) return null;
    throw error;
  }
}

async function readLatest(directory, id, allowEmpty = false) {
  const names = [];
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind === 'file' && JOURNAL_PATTERN.test(name)) names.push(name);
  }
  names.sort().reverse();
  if (!names.length && allowEmpty) return null;
  const name = names[0];
  try {
    if (!name) throw new Error('Missing state');
    const value = await readJson(directory, name);
    if (value?.schema !== SCHEMA || value.id !== id || value.revision !== Number(name.match(JOURNAL_PATTERN)[1]) || !/^[a-f0-9]{64}$/.test(value.sourceHash) || !Number.isSafeInteger(value.sourceSize) || value.sourceSize < 1 || typeof value.createdAt !== 'string' || typeof value.status !== 'string' || !value.status) throw new Error('Invalid state');
    assertSourceName(value.sourceName);
    assertFolderName(value.folderName);
    return value;
  } catch {
    throw fileError(`The newest recovery journal for job ${id} is missing or corrupt. Processing stopped to avoid generating this image twice. Restore ${WORK_FOLDER}/${id}/${name || 'state-00000001.json'} from a backup before resuming.`, 'JOURNAL_CORRUPT');
  }
}

export async function listJobs(root) {
  const work = await workDirectory(root);
  if (!work) return [];
  const jobs = [];
  for await (const [id, directory] of work.entries()) {
    if (directory.kind !== 'directory' || !/^[a-z0-9-]{16,80}$/i.test(id)) continue;
    const job = await readLatest(directory, id);
    if (job) jobs.push(job);
  }
  return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getJob(root, id) {
  const directory = await jobDirectory(root, id);
  return directory ? readLatest(directory, id) : null;
}

export async function scanImages(root) {
  const images = [];
  for await (const [name, handle] of root.entries()) {
    if (handle.kind !== 'file' || name.startsWith('.') || !IMAGE_PATTERN.test(name)) continue;
    const file = await handle.getFile();
    images.push({ name, size: file.size, lastModified: file.lastModified, type: file.type || imageType(name) });
  }
  return images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

function imageType(name) {
  return /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg';
}

export async function readSource(root, name) {
  const handle = await root.getFileHandle(assertSourceName(name));
  const file = await handle.getFile();
  if (!file.size) throw fileError(`The image ${name} is empty.`, 'INVALID_IMAGE');
  if (file.size > 20 * 1024 * 1024) throw fileError(`The image ${name} exceeds Studio’s 20 MiB upload limit.`, 'INVALID_IMAGE');
  return file;
}

async function allocateFolder(root, name, jobs) {
  const occupied = new Set(jobs.map(job => job.folderName.normalize('NFC').toLowerCase()));
  for await (const [entryName] of root.entries()) occupied.add(entryName.normalize('NFC').toLowerCase());
  const stem = outputStem(name);
  let folder = stem;
  let suffix = 2;
  while (occupied.has(folder.toLowerCase())) folder = `${stem}--${suffix++}`;
  return folder;
}

export async function createJob(root, sourceName) {
  const source = await readSource(root, sourceName);
  const sourceHash = await sha256(source);
  const jobs = await listJobs(root);
  const existing = jobs.find(job => job.status !== 'completed' && job.sourceName === sourceName && job.sourceHash === sourceHash);
  if (existing) return existing;
  const now = new Date().toISOString();
  const job = { schema: SCHEMA, id: crypto.randomUUID(), sourceName, sourceHash, sourceSize: source.size, sourceModified: source.lastModified, sourceType: source.type || imageType(sourceName), folderName: await allocateFolder(root, sourceName, jobs), status: 'prepared', createdAt: now, updatedAt: now, revision: 0 };
  return updateJob(root, job, {});
}

export async function updateJob(root, job, patch = {}) {
  assertJobId(job.id);
  assertSourceName(job.sourceName);
  assertFolderName(job.folderName);
  for (const field of ['id', 'sourceName', 'sourceHash', 'folderName', 'schema']) {
    if (field in patch && patch[field] !== job[field]) throw fileError(`Cannot change the job’s ${field}.`);
  }
  const directory = await jobDirectory(root, job.id, true);
  const latest = await readLatest(directory, job.id, true);
  let highestRevision = Math.max(latest?.revision || 0, job.revision || 0);
  for await (const [name] of directory.entries()) {
    const match = name.match(JOURNAL_PATTERN);
    if (match) highestRevision = Math.max(highestRevision, Number(match[1]));
  }
  const revision = highestRevision + 1;
  if (revision > 99999999) throw fileError('The recovery journal has reached its revision limit.');
  const next = { ...job, ...latest, ...patch, schema: SCHEMA, revision, updatedAt: new Date().toISOString() };
  const name = `state-${String(revision).padStart(8, '0')}.json`;
  if (await getFileHandleOrNull(directory, name)) throw fileError('A recovery journal conflict was detected. Stop other runs for this folder.');
  const blob = new Blob([JSON.stringify(next, null, 2)], { type: 'application/json' });
  await replacePrivateFile(directory, name, blob);
  const verified = await readJson(directory, name);
  if (verified?.id !== next.id || verified.revision !== revision || verified.status !== next.status) throw fileError('Could not verify the recovery journal write.');
  return next;
}

async function targetFile(directory, path, create = false) {
  const parts = safeArchivePath(path).split('/');
  let parent = directory;
  for (const segment of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(segment, { create });
  return parent.getFileHandle(parts.at(-1), { create });
}

async function writeWithoutOverwrite(directory, path, blob, hash) {
  let existing;
  try {
    existing = await targetFile(directory, path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (existing) {
    const file = await existing.getFile();
    if (file.size !== blob.size || await sha256(file) !== hash) throw fileError(`The output ${path} already exists with different content. Nothing was overwritten.`, 'OUTPUT_CONFLICT');
    return;
  }
  const handle = await targetFile(directory, path, true);
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
  const written = await handle.getFile();
  if (written.size !== blob.size || await sha256(written) !== hash) throw fileError(`Could not verify the saved ${path}. The root image was kept.`, 'WRITE_VERIFY_FAILED');
}

function prepareOutputFiles(result, job) {
  let files = result.files;
  if (result.format === 'fbx') files = files.map(file => ({ ...file, path: `${outputStem(job.sourceName)}.fbx` }));
  const sourceKey = job.sourceName.normalize('NFC').toLowerCase();
  const collides = files.some(file => [sourceKey, OWNER_FILE].includes(file.path.split('/')[0].normalize('NFC').toLowerCase()));
  if (collides) files = files.map(file => ({ ...file, path: `model/${file.path}` }));
  return files.slice().sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function outputManifest(files) {
  return files.map(({ path, sha256: hash, size }) => ({ path, sha256: hash, size }));
}

function verifyOutputManifest(job, manifest) {
  if (job.outputFiles && JSON.stringify(job.outputFiles) !== JSON.stringify(manifest)) throw fileError('The recovered export differs from the saved output manifest. The previous staged export was kept.', 'EXPORT_CHANGED');
}

async function ownedOutput(root, job) {
  let output;
  try {
    output = await root.getDirectoryHandle(assertFolderName(job.folderName));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (output) {
    let owner;
    try {
      owner = await readJson(output, OWNER_FILE);
    } catch {}
    if (owner?.tool !== TOOL || owner.id !== job.id || owner.sourceHash !== job.sourceHash) throw fileError(`The output folder ${job.folderName} already exists without this job’s recovery marker. Nothing was overwritten. Move that folder aside before resuming.`, 'OUTPUT_CONFLICT');
    return output;
  }
  output = await root.getDirectoryHandle(job.folderName, { create: true });
  const owner = new Blob([JSON.stringify({ tool: TOOL, id: job.id, sourceHash: job.sourceHash })], { type: 'application/json' });
  await writeWithoutOverwrite(output, OWNER_FILE, owner, await sha256(owner));
  return output;
}

async function assertSourceUnchanged(root, job) {
  const source = await readSource(root, job.sourceName);
  if (source.size !== job.sourceSize || await sha256(source) !== job.sourceHash) throw fileError(`The root image ${job.sourceName} changed during processing. It was not moved.`, 'SOURCE_CHANGED');
  return source;
}

async function verifiedSourceCopy(directory, job) {
  let file;
  try {
    file = await (await directory.getFileHandle(job.sourceName)).getFile();
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (file.size !== job.sourceSize || await sha256(file) !== job.sourceHash) throw fileError('The copied source image does not match the original. The root image was kept.', 'SOURCE_COPY_MISMATCH');
  return file;
}

async function completeCommit(root, job, parsed) {
  const files = prepareOutputFiles(parsed, job);
  const manifest = outputManifest(files);
  verifyOutputManifest(job, manifest);
  const fbxPaths = manifest.filter(file => /\.fbx$/i.test(file.path)).map(file => file.path);
  let next = job.status === 'committing' ? job : await updateJob(root, job, { status: 'committing', outputFiles: manifest, fbxPaths, exportFormat: parsed.format });
  const output = await ownedOutput(root, next);
  for (const file of files) await writeWithoutOverwrite(output, file.path, file.blob, file.sha256);
  let source;
  try {
    source = await assertSourceUnchanged(root, next);
  } catch (error) {
    if (!isMissing(error)) throw error;
    if (!await verifiedSourceCopy(output, next)) throw fileError('Both the root image and its verified copy are missing.', 'SOURCE_MISSING');
  }
  if (source) {
    await writeWithoutOverwrite(output, next.sourceName, source, next.sourceHash);
    await assertSourceUnchanged(root, next);
    await verifiedSourceCopy(output, next);
    await root.removeEntry(next.sourceName);
  }
  next = await updateJob(root, next, { status: 'completed', completedAt: new Date().toISOString(), sourceMoved: true });
  const staging = await jobDirectory(root, next.id);
  const warnings = [];
  try {
    await staging.removeEntry('export.bin');
  } catch (error) {
    if (!isMissing(error)) warnings.push('The completed export’s temporary package could not be removed.');
  }
  try {
    await output.removeEntry(OWNER_FILE);
  } catch (error) {
    if (!isMissing(error)) warnings.push('The completed folder’s temporary recovery marker could not be removed.');
  }
  return warnings.length ? { ...next, cleanupWarning: warnings.join(' ') } : next;
}

export async function commitExport(root, job, blob, suggestedName = 'model.fbx') {
  let latest = await getJob(root, job.id) || job;
  if (latest.status === 'completed') return latest;
  const parsed = await inspectExport(blob, suggestedName);
  verifyOutputManifest(latest, outputManifest(prepareOutputFiles(parsed, latest)));
  const packageHash = await sha256(blob);
  const staging = await jobDirectory(root, latest.id, true);
  await assertSourceUnchanged(root, latest).catch(async error => {
    if (latest.status !== 'committing' || !isMissing(error)) throw error;
    const output = await root.getDirectoryHandle(latest.folderName);
    if (!await verifiedSourceCopy(output, latest)) throw error;
  });
  latest = await updateJob(root, latest, { status: latest.status === 'committing' ? 'committing' : 'staging', packageHash, packageSize: blob.size, suggestedName });
  const packageHandle = await replacePrivateFile(staging, 'export.bin', blob);
  const saved = await packageHandle.getFile();
  if (saved.size !== blob.size || await sha256(saved) !== packageHash) throw fileError('The staged export could not be verified. The root image was kept.', 'STAGING_INCOMPLETE');
  return completeCommit(root, latest, parsed);
}

export async function resumeCommit(root, job) {
  const latest = await getJob(root, job.id) || job;
  if (latest.status === 'completed') return latest;
  if (!['staging', 'committing'].includes(latest.status)) throw fileError('This image needs its existing Studio generation exported before the file move can resume.', 'EXPORT_NEEDED');
  const staging = await jobDirectory(root, latest.id);
  const packageHandle = staging && await getFileHandleOrNull(staging, 'export.bin');
  if (!packageHandle) throw fileError('The staged export is missing. Export the existing Studio model again.', 'EXPORT_NEEDED');
  const blob = await packageHandle.getFile();
  if (blob.size !== latest.packageSize || await sha256(blob) !== latest.packageHash) throw fileError('The staged export is incomplete. Export the existing Studio model again.', 'EXPORT_NEEDED');
  const parsed = await inspectExport(blob, latest.suggestedName || 'model.fbx');
  return completeCommit(root, latest, parsed);
}
