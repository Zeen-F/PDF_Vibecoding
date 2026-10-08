import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const storageVariables = new Set(['PAPERDESK_VAULT_DIR', 'PAPERDESK_VAULT_SUBDIR', 'PAPERDESK_DATA_DIR']);

// Fixtures provide their own paths after this boundary; inherited production
// storage must never redirect a test's explicitly selected temporary library.
export function clearInheritedTestStorage(environment = process.env) {
  for (const key of Object.keys(environment)) {
    if (storageVariables.has(key.toUpperCase())) delete environment[key];
  }
  return environment;
}

export function isolatedTestEnvironment(environment = process.env) {
  const result = clearInheritedTestStorage({ ...environment });
  // A nested Node test invocation must create its own runner, rather than
  // inherit the current runner's private child-process reporting protocol.
  delete result.NODE_TEST_CONTEXT;
  return result;
}

export function runIsolatedNode(args, { environment = process.env, cwd = process.cwd(), stdio = 'inherit' } = {}) {
  if (!args.length) throw new Error('Usage: node scripts/test-isolated.mjs <Node arguments or script>');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: isolatedTestEnvironment(environment), stdio, shell: false });
    let shutdownTimer, requestedSignal;
    const signals = new Map([['SIGINT', 130], ['SIGTERM', 143]]);
    const handlers = new Map();
    const cleanup = () => {
      clearTimeout(shutdownTimer);
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    for (const signal of signals.keys()) {
      const handler = () => {
        if (requestedSignal) { child.kill('SIGKILL'); return; }
        requestedSignal = signal;
        child.kill(signal);
        shutdownTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
        shutdownTimer.unref();
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, signal) => {
      cleanup();
      resolve(signals.get(requestedSignal || signal) ?? code ?? 1);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = await runIsolatedNode(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
