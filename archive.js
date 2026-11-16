const MiB = 1024 * 1024;
const DEFAULT_LIMITS = Object.freeze({ archiveBytes: 512 * MiB, expandedBytes: 1024 * MiB, entryBytes: 768 * MiB, entries: 2048 });
const encoder = new TextEncoder();
const binaryFbxMagic = encoder.encode('Kaydara FBX Binary  \u0000\u001a\u0000');
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function archiveError(message) {
  const error = new Error(message);
  error.code = 'INVALID_EXPORT';
  return error;
}

export async function sha256(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export async function validateFbx(blob) {
  if (blob.size < 64) throw archiveError('The downloaded FBX is empty or too short.');
  const bytes = new Uint8Array(await blob.slice(0, Math.min(blob.size, 32768)).arrayBuffer());
  if (binaryFbxMagic.every((value, index) => bytes[index] === value)) {
    const version = new DataView(bytes.buffer).getUint32(23, true);
    if (version < 6000 || version > 9999) throw archiveError('The FBX header has an unsupported version.');
    return 'binary';
  }
  const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
  if (/^\s*;\s*FBX\b/i.test(text) && /\bFBXHeaderExtension\s*:/i.test(text) && /\bFBXVersion\s*:\s*\d+/i.test(text)) return 'ascii';
  throw archiveError('The download is not an FBX model. The source image has not been moved.');
}

export function safeArchivePath(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f]/.test(value)) throw archiveError('The export contains an invalid filename.');
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) throw archiveError('The export contains an absolute path.');
  const parts = normalized.replace(/\/$/, '').split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[<>:"|?*]/.test(part) || /[ .]$/.test(part)) throw archiveError('The export contains an unsafe file path.');
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw archiveError('The export contains a filename unsupported on an SD card.');
  }
  return parts.join('/');
}

function decodeFilename(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw archiveError('The ZIP contains non-UTF-8 filenames. Export a package with standard filenames.');
  }
}

function checkRange(start, length, end, message) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > end) throw archiveError(message);
}

function zipEntries(buffer, limits) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw archiveError('The ZIP download is incomplete or invalid.');
  const count = view.getUint16(eocd + 10, true);
  const centralBytes = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (view.getUint16(eocd + 4, true) || view.getUint16(eocd + 6, true) || count !== view.getUint16(eocd + 8, true)) throw archiveError('Multi-part ZIP exports are not supported.');
  if (count === 65535 || centralBytes === 0xffffffff || centralOffset === 0xffffffff) throw archiveError('ZIP64 exports are not supported.');
  if (!count || count > limits.entries) throw archiveError(`The export must contain between 1 and ${limits.entries} files.`);
  checkRange(centralOffset, centralBytes, eocd, 'The ZIP directory is invalid.');
  const entries = [];
  const paths = new Set();
  const components = new Map();
  const filePaths = new Set();
  let offset = centralOffset;
  let expanded = 0;
  for (let index = 0; index < count; index += 1) {
    checkRange(offset, 46, centralOffset + centralBytes, 'The ZIP directory is truncated.');
    if (view.getUint32(offset, true) !== 0x02014b50) throw archiveError('The ZIP directory is invalid.');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compressed = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameBytes = view.getUint16(offset + 28, true);
    const extraBytes = view.getUint16(offset + 30, true);
    const commentBytes = view.getUint16(offset + 32, true);
    const disk = view.getUint16(offset + 34, true);
    const external = view.getUint32(offset + 38, true);
    const localOffset = view.getUint32(offset + 42, true);
    checkRange(offset + 46, nameBytes + extraBytes + commentBytes, centralOffset + centralBytes, 'The ZIP filename is truncated.');
    const name = decodeFilename(bytes.subarray(offset + 46, offset + 46 + nameBytes));
    const path = safeArchivePath(name);
    const collisionKey = path.normalize('NFC').toLowerCase();
    const unixMode = external >>> 16;
    const isDirectory = name.endsWith('/') || (unixMode & 0xf000) === 0x4000;
    if ((unixMode & 0xf000) === 0xa000) throw archiveError('Symbolic links are not allowed in exports.');
    if (![0, 0x4000, 0x8000].includes(unixMode & 0xf000)) throw archiveError('The ZIP contains an unsupported special file.');
    if (flags & 1) throw archiveError('Encrypted ZIP exports are not supported.');
    if (disk || compressed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw archiveError('ZIP64 and multi-part exports are not supported.');
    if (method !== 0 && method !== 8) throw archiveError('The ZIP compression method is not supported.');
    if (paths.has(collisionKey)) throw archiveError('The ZIP contains duplicate or case-conflicting paths.');
    paths.add(collisionKey);
    const segments = path.split('/');
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const component = segments.slice(0, depth).join('/');
      const componentKey = component.normalize('NFC').toLowerCase();
      if (components.has(componentKey) && components.get(componentKey) !== component) throw archiveError('The ZIP contains case-conflicting folder names.');
      if (depth < segments.length && filePaths.has(componentKey)) throw archiveError('The ZIP uses the same path as both a file and a folder.');
      components.set(componentKey, component);
    }
    if (!isDirectory) {
      if ([...components.keys()].some(key => key.startsWith(`${collisionKey}/`))) throw archiveError('The ZIP uses the same path as both a file and a folder.');
      filePaths.add(collisionKey);
    }
    expanded += size;
    if (size > limits.entryBytes || expanded > limits.expandedBytes) throw archiveError('The expanded export exceeds the supported size limit.');
    checkRange(localOffset, 30, centralOffset, 'The ZIP entry is truncated.');
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw archiveError('The ZIP entry header is invalid.');
    const localNameBytes = view.getUint16(localOffset + 26, true);
    const localExtraBytes = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameBytes + localExtraBytes;
    checkRange(localOffset + 30, localNameBytes + localExtraBytes, centralOffset, 'The ZIP entry name is truncated.');
    if (view.getUint16(localOffset + 8, true) !== method || (view.getUint16(localOffset + 6, true) & 1)) throw archiveError('The ZIP entry does not match its directory.');
    if (safeArchivePath(decodeFilename(bytes.subarray(localOffset + 30, localOffset + 30 + localNameBytes))) !== path) throw archiveError('The ZIP entry filename does not match its directory.');
    checkRange(dataOffset, compressed, centralOffset, 'The ZIP entry data is truncated.');
    if (!isDirectory && !path.startsWith('__MACOSX/') && !/(^|\/)\.DS_Store$/.test(path)) entries.push({ path, method, crc, size, compressed, dataOffset });
    offset += 46 + nameBytes + extraBytes + commentBytes;
  }
  if (offset !== centralOffset + centralBytes) throw archiveError('The ZIP directory length is invalid.');
  return entries;
}

async function inflateEntry(packageBlob, entry) {
  let stream = packageBlob.slice(entry.dataOffset, entry.dataOffset + entry.compressed).stream();
  if (entry.method === 8) stream = stream.pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  let crc = 0xffffffff;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > entry.size) throw archiveError('The decompressed export is larger than its declared size.');
      for (const byte of value) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw archiveError(`Could not unpack ${entry.path}: ${error.message}`);
  } finally {
    reader.releaseLock();
  }
  if (size !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) throw archiveError(`The downloaded file ${entry.path} failed its integrity check.`);
  return new Blob(chunks);
}

function removeCommonWrapper(files) {
  if (!files.length) return files;
  const segments = files.map(file => file.path.split('/'));
  let depth = 0;
  while (segments.every(parts => parts.length > depth + 1 && parts[depth] === segments[0][depth])) depth += 1;
  return depth ? files.map((file, index) => ({ ...file, path: segments[index].slice(depth).join('/') })) : files;
}

export async function inspectExport(blob, suggestedName = 'model.fbx', options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  if (!(blob instanceof Blob) || !blob.size) throw archiveError('The model download is empty.');
  if (blob.size > limits.archiveBytes) throw archiveError('The downloaded export exceeds 512 MiB.');
  const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  const isZip = signature[0] === 0x50 && signature[1] === 0x4b && signature[2] === 3 && signature[3] === 4;
  if (!isZip) {
    await validateFbx(blob);
    const basename = String(suggestedName).split(/[\\/]/).pop();
    const path = safeArchivePath(/\.fbx$/i.test(basename) ? basename : 'model.fbx');
    return { format: 'fbx', files: [{ path, blob, sha256: await sha256(blob), size: blob.size }], fbxPaths: [path] };
  }
  const entries = zipEntries(await blob.arrayBuffer(), limits);
  if (!entries.some(entry => /\.fbx$/i.test(entry.path))) throw archiveError('The export ZIP contains no FBX model. Select FBX in Studio’s Export dialog.');
  let files = [];
  for (const entry of entries) {
    const content = await inflateEntry(blob, entry);
    if (/\.fbx$/i.test(entry.path)) await validateFbx(content);
    files.push({ path: entry.path, blob: content, sha256: await sha256(content), size: content.size });
  }
  files = removeCommonWrapper(files);
  const fbxPaths = files.filter(file => /\.fbx$/i.test(file.path)).map(file => file.path);
  return { format: 'zip', files, fbxPaths };
}
