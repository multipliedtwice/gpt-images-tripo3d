import net from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { mkdir, lstat, chmod, unlink, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge } from './bridge.js';
import { createFolderService } from './folder.js';
import { validateTool } from '../mcp-tools.js';

export const MAX_BYTES = 4 * 1024 * 1024;
export const brokerConfig = async (env = process.env) => {
  const port = Number(env.RUNNER_MCP_PORT || 17321);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('RUNNER_MCP_PORT must be 1024–65535.');
  if (!/^[a-p]{32}$/.test(env.RUNNER_EXTENSION_ID || '')) throw new Error('RUNNER_EXTENSION_ID must be the extension ID from chrome://extensions.');
  const token = env.RUNNER_MCP_TOKEN || null;
  if (token && token.length < 32) throw new Error('RUNNER_MCP_TOKEN must contain at least 32 characters.');
  let outputDir = null;
  if (env.RUNNER_OUTPUT_DIR) {
    if (!isAbsolute(env.RUNNER_OUTPUT_DIR)) throw new Error('RUNNER_OUTPUT_DIR must be an absolute folder path.');
    const info = await lstat(resolve(env.RUNNER_OUTPUT_DIR));
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('RUNNER_OUTPUT_DIR must be an existing directory, not a symlink.');
    outputDir = await realpath(env.RUNNER_OUTPUT_DIR);
  }
  return { protocol: 1, port, extensionId: env.RUNNER_EXTENSION_ID, outputDir, token };
};
export const brokerSocket = async port => {
  if (process.platform === 'win32') {
    const user = userInfo();
    const identity = createHash('sha256').update(`${user.username}\0${user.homedir}`).digest('hex').slice(0, 24);
    return `\\\\.\\pipe\\tripo-runner-${identity}-${port}`;
  }
  const uid = process.getuid();
  const directory = `/tmp/tripo-runner-${uid}`;
  await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077)) throw new Error('The local MCP socket directory must be a private directory owned by this user.');
  return `${directory}/${port}.sock`;
};
export const readFrames = (socket, receive) => {
  let buffer = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (!socket.destroyed) {
      const end = buffer.indexOf(10);
      if (end < 0) break;
      if (end > MAX_BYTES) { socket.destroy(); return; }
      const line = buffer.subarray(0, end).toString('utf8');
      buffer = buffer.subarray(end + 1);
      try { receive(JSON.parse(line)); } catch { socket.destroy(); return; }
    }
    if (buffer.length > MAX_BYTES) socket.destroy();
  });
};
export const writeFrame = (socket, value) => {
  const frame = JSON.stringify(value);
  if (Buffer.byteLength(frame) > MAX_BYTES) throw new Error('MCP broker message exceeds 4 MiB.');
  if (socket.destroyed || socket.writableEnded) throw new Error('MCP broker disconnected; outcome may be uncertain. Inspect before retrying.');
  socket.write(frame + '\n');
};
export const createBroker = async (config, { idleTime = 500, timeout = 15000 } = {}) => {
  const socketPath = await brokerSocket(config.port);
  const folder = config.outputDir ? await createFolderService(config.outputDir) : null;
  let bridge;
  let sessionChanged = () => {};
  try { bridge = await createBridge({ port: config.port, extensionId: config.extensionId, token: config.token || randomBytes(32).toString('hex'), folder, timeout, onSessionChange: () => sessionChanged() }); }
  catch (error) { await folder?.close(); throw error; }
  const clients = new Set();
  let idle;
  let closing = null;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      clearTimeout(idle);
      for (const socket of clients) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      await bridge.close();
    })();
    return closing;
  };
  const scheduleIdle = () => {
    clearTimeout(idle);
    if (!clients.size && !bridge.connected && !closing) idle = setTimeout(close, idleTime);
  };
  sessionChanged = scheduleIdle;
  const server = net.createServer(socket => {
    clearTimeout(idle);
    clients.add(socket);
    let ready = false;
    const owner = Symbol('client');
    const requests = new Set();
    const handshake = setTimeout(() => socket.destroy(), 5000);
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(handshake);
      clients.delete(socket);
      bridge.cancelOwner(owner);
      scheduleIdle();
    });
    readFrames(socket, message => {
      if (!ready) {
        clearTimeout(handshake);
        const mismatch = ['protocol', 'port', 'extensionId', 'outputDir', 'token'].find(key => message?.config?.[key] !== config[key]);
        if (message?.type !== 'hello' || mismatch) {
          writeFrame(socket, { error: `MCP broker configuration mismatch (${mismatch || 'handshake'}). Use the same extension, RUNNER_OUTPUT_DIR and token settings, or choose another RUNNER_MCP_PORT.` });
          socket.end();
          return;
        }
        ready = true;
        writeFrame(socket, { ready: true });
        return;
      }
      if (message?.type !== 'call' || typeof message.id !== 'string' || !message.id || requests.has(message.id)) { socket.destroy(); return; }
      requests.add(message.id);
      const reply = value => { requests.delete(message.id); if (!socket.destroyed && !socket.writableEnded) { try { writeFrame(socket, { id: message.id, ...value }); } catch { socket.destroy(); } } };
      Promise.resolve().then(() => {
        validateTool(message.name, message.args);
        return bridge.call(message.name, message.args, owner);
      }).then(result => reply({ result }), error => reply({ error: error.message }));
    });
  });
  try {
    if (process.platform !== 'win32') {
      const existing = await lstat(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (existing) {
        if (!existing.isSocket() || existing.uid !== process.getuid()) throw new Error('Local MCP socket path is not an owned socket.');
        await unlink(socketPath);
      }
    }
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    if (process.platform !== 'win32') await chmod(socketPath, 0o600);
    scheduleIdle();
  } catch (error) { await bridge.close(); throw error; }
  return { close, socketPath };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const broker = await createBroker(await brokerConfig());
    process.on('SIGINT', () => broker.close());
    process.on('SIGTERM', () => broker.close());
  } catch { process.exitCode = 1; }
}
