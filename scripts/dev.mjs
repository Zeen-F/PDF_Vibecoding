import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { developmentEnvironment } from './dev-environment.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const apiPort = Number(process.env.DEV_API_PORT || 4318);
const uiPort = 5173;
// A production PAPERDESK_DATA_DIR must not silently become the development library.
const dataDir = resolve(root, process.env.DEV_DATA_DIR || '.local/dev-data');
const children = new Map();
let stopping = false;
let shutdownPromise;

async function assertAvailable(port, label) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', error => reject(new Error(
      error.code === 'EADDRINUSE'
        ? `${label} port ${port} is already in use. Stop that process${label === 'API' ? ' or set DEV_API_PORT' : ''}; no existing server will be reused.`
        : `Cannot open ${label} port ${port}: ${error.message}`,
    )));
    probe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
}

function shutdown(code = 0, signal = 'SIGTERM') {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  process.exitCode = code;
  shutdownPromise = (async () => {
    const running = [...children.keys()];
    const exited = running.map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('close', resolve);
    }));
    for (const child of running) child.kill(signal);
    const timer = setTimeout(() => {
      for (const child of running) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }, 5000);
    timer.unref();
    await Promise.all(exited);
    clearTimeout(timer);
  })();
  return shutdownPromise;
}

function launch(label, args, env) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  children.set(child, label);
  child.once('error', error => {
    children.delete(child);
    console.error(`${label} could not start: ${error.message}`);
    void shutdown(1);
  });
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`${label} stopped unexpectedly (${signal || `exit ${code}`}); stopping the development workspace.`);
      void shutdown(code || 1);
    }
  });
}

process.once('SIGINT', () => { void shutdown(130, 'SIGINT'); });
process.once('SIGTERM', () => { void shutdown(143); });

try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Paperdesk requires Node.js 24 or newer. Use the Node 24 LTS version in .nvmrc.');
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535 || apiPort === uiPort) {
    throw new Error('DEV_API_PORT must be an integer from 1 to 65535, different from the UI port 5173.');
  }
  await assertAvailable(apiPort, 'API');
  await assertAvailable(uiPort, 'UI');
  if (!stopping) {
    const env = developmentEnvironment(process.env, { apiPort, dataDir });
    console.log(`Development UI: http://127.0.0.1:${uiPort}\nDevelopment API: http://127.0.0.1:${apiPort}\nDevelopment data: ${dataDir}`);
    launch('API', ['server/index.mjs'], env);
    launch('Vite', [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))], env);
  }
} catch (error) {
  console.error(error.message);
  await shutdown(1);
}
