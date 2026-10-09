import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function desktopTestTarget(packaged, { platform = process.platform, electronExecutable } = {}) {
  if (!packaged) return { executablePath: electronExecutable || process.env.ELECTRON_EXECUTABLE_PATH || createRequire(import.meta.url)('electron') };
  const bundle = path.resolve(packaged);
  if (platform === 'darwin') return { executablePath: path.join(bundle, 'Contents/MacOS/Paperdesk'), appPath: path.join(bundle, 'Contents/Resources/app') };
  const directory = /\.exe$/i.test(bundle) ? path.dirname(bundle) : bundle;
  return { executablePath: /\.exe$/i.test(bundle) ? bundle : path.join(directory, platform === 'win32' ? 'Paperdesk.exe' : 'paperdesk'), appPath: path.join(directory, 'resources/app') };
}

export async function temporaryTestDirectory(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export function testEvidenceDirectory(root, temporary) {
  if (!process.env.PAPERDESK_ACCEPTANCE_DIR) return path.join(temporary, 'evidence');
  const directory = path.resolve(root, process.env.PAPERDESK_ACCEPTANCE_DIR);
  const relative = path.relative(path.join(root, '.local'), directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || /^(?:dev-data|migrations|backups)(?:[\\/]|$)/i.test(relative)) {
    throw new Error('PAPERDESK_ACCEPTANCE_DIR must be an isolated evidence directory inside this workspace .local');
  }
  return directory;
}

export async function removeTestDirectory(directory, prefix) {
  const target = path.resolve(directory), parent = path.resolve(tmpdir());
  if (path.dirname(target) !== parent || !path.basename(target).startsWith(prefix)) {
    throw new Error('Refusing to remove a directory outside this test’s temporary workspace');
  }
  await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
}

async function bounded(promise, timeoutMs, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

// Only this test's process can be stopped. Wait for the process to release its
// profile/SQLite files before deleting the synthetic fixture on Windows.
export async function closeTestApplication(application, userData) {
  if (!application) return;
  const child = application.process();
  const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
    : new Promise(resolve => child.once('close', resolve));
  try {
    await bounded(application.close(), 5_000, 'Test application did not close');
    await bounded(exited, 5_000, 'Test process did not exit');
  } catch {
    await bounded(application.evaluate(({ app }, profile) => {
      if (app.getPath('userData') !== profile) throw new Error('Refusing to stop another application profile');
      app.exit(0);
    }, userData), 2_000, 'Test application did not acknowledge cleanup').catch(() => {});
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') {
        // A process tree can include Electron renderer/utility children. No
        // process-name/global termination is used.
        const stopper = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
        await bounded(new Promise((resolve, reject) => { stopper.once('error', reject); stopper.once('close', resolve); }), 5_000, 'Owned test process tree did not stop');
      } else child.kill('SIGKILL');
    }
    await bounded(exited, 5_000, 'Owned test process is still running');
  }
}

export function testShutdownHandlers(cleanup) {
  let stopping = false;
  const handlers = new Map();
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const handler = () => {
      if (stopping) return;
      stopping = true;
      void cleanup().then(() => process.exit(code), error => { console.error(error.message); process.exit(1); });
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => { for (const [signal, handler] of handlers) process.off(signal, handler); };
}
