import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedTestEnvironment } from '../scripts/test-isolated.mjs';
import { temporaryTestDirectory, removeTestDirectory } from '../scripts/desktop-test-support.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
async function availablePort(port = 0) {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    return server.address().port;
  } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
}
async function waitForReady(url, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Development service did not start: ${url}\n${output()}`);
}

test('real development startup uses only its synthetic library and cooperative stop releases both ports', { timeout: 30_000 }, async t => {
  try { await availablePort(5173); }
  catch (error) { if (error.code === 'EADDRINUSE') { t.skip('An existing development UI owns port 5173; it is left running'); return; } throw error; }
  const port = await availablePort();
  const temporary = await temporaryTestDirectory('paperdesk-dev-lifecycle-');
  const library = path.join(temporary, '开发 测试库');
  const production = path.join(temporary, '生产资料');
  let child, timer, output = '';
  t.after(async () => {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      if (child.connected) child.send({ type: 'paperdesk-shutdown' });
      timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      try { await closed; } finally { clearTimeout(timer); }
    }
    await removeTestDirectory(temporary, 'paperdesk-dev-lifecycle-');
  });
  await mkdir(path.join(production, '.obsidian'), { recursive: true });
  await writeFile(path.join(production, 'original.txt'), 'protected synthetic production fixture');
  child = spawn(process.execPath, [path.join(root, 'scripts/dev.mjs')], { cwd: root, env: {
    ...isolatedTestEnvironment(), DEV_API_PORT: String(port), DEV_DATA_DIR: library,
    PAPERDESK_DATA_DIR: production, PAPERDESK_VAULT_DIR: production, Paperdesk_Vault_Dir: production,
  }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], shell: false });
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  const closed = once(child, 'close');
  await waitForReady(`http://127.0.0.1:${port}/api/health`, () => output);
  await waitForReady('http://127.0.0.1:5173', () => output);
  assert.deepEqual((await (await fetch(`http://127.0.0.1:${port}/api/documents`)).json()).documents, []);
  child.send({ type: 'paperdesk-shutdown' });
  timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  const [code, signal] = await closed;
  clearTimeout(timer);
  assert.equal(code, 0, output); assert.equal(signal, null);
  assert.equal(await readFile(path.join(production, 'original.txt'), 'utf8'), 'protected synthetic production fixture');
  assert.equal(await availablePort(port), port);
  assert.equal(await availablePort(5173), 5173);
});
