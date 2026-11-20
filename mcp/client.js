import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { brokerConfig, brokerSocket, readFrames, writeFrame } from './broker.js';

const connect = (path, config) => new Promise((resolve, reject) => {
  const socket = net.createConnection(path);
  const pending = new Map();
  let ready = false;
  const timer = setTimeout(() => { reject(new Error('Local MCP broker handshake timed out.')); socket.destroy(); }, 5000);
  const disconnected = () => {
    clearTimeout(timer);
    const error = new Error('MCP broker disconnected; outcome may be uncertain. Inspect before retrying.');
    if (!ready) reject(error);
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  };
  socket.on('error', error => { clearTimeout(timer); if (!ready) reject(error); });
  socket.on('close', disconnected);
  socket.on('connect', () => writeFrame(socket, { type: 'hello', config }));
  readFrames(socket, message => {
    if (!ready) {
      clearTimeout(timer);
      if (message?.ready !== true) { reject(new Error(message?.error || 'Incompatible local MCP broker.')); socket.destroy(); return; }
      ready = true;
      resolve({
        call(name, args) {
          return new Promise((resolve, reject) => {
            const id = randomUUID();
            pending.set(id, { resolve, reject });
            try { writeFrame(socket, { type: 'call', id, name, args }); }
            catch (error) { pending.delete(id); reject(error); }
          });
        },
        async close() { socket.destroy(); }
      });
      return;
    }
    const item = pending.get(message?.id);
    if (!item) { socket.destroy(); return; }
    pending.delete(message.id);
    if (typeof message.error === 'string') item.reject(new Error(message.error));
    else item.resolve(message.result);
  });
});
export const connectBroker = async () => {
  const config = await brokerConfig();
  const path = await brokerSocket(config.port);
  try { return await connect(path, config); }
  catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  let child;
  let launchError;
  let launchedAt = 0;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    try { return await connect(path, config); }
    catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
    if ((!child || child.exitCode !== null || child.signalCode !== null) && Date.now() - launchedAt >= 100) {
      launchedAt = Date.now();
      child = spawn(process.execPath, [fileURLToPath(new URL('./broker.js', import.meta.url))], { env: process.env, detached: true, windowsHide: true, stdio: 'ignore' });
      child.on('error', error => { launchError = error; });
      child.unref();
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Could not start the shared MCP broker on port ${config.port}. Check whether another service uses RUNNER_MCP_PORT, or choose another port.`);
};
