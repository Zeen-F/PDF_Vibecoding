import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { codexCommand } from '../scripts/codex-command.mjs';

test('Windows Codex installation supports npm and native paths without a command shell', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'paperdesk-plugin-中文 空格 &-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const npm = path.join(root, 'npm'), native = path.join(root, 'native');
  const cli = path.join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  await mkdir(path.dirname(cli), { recursive: true });
  await mkdir(native);
  await writeFile(cli, '');
  await writeFile(path.join(npm, 'codex.cmd'), '');
  await writeFile(path.join(native, 'codex.exe'), '');
  const resolve = value => codexCommand({ platform: 'win32', environment: { Path: value }, node: process.execPath });
  assert.deepEqual(resolve(`"${npm}";${native}`), { command: process.execPath, args: [cli] });
  assert.deepEqual(resolve(`${native};${npm}`), { command: path.join(native, 'codex.exe'), args: [] });
  assert.throws(() => resolve(path.join(root, 'missing')), /Codex CLI/);
  assert.deepEqual(codexCommand({ platform: 'darwin' }), { command: 'codex', args: [] });
});

test('setup preserves a matching Windows path binding and refuses a different library', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'paperdesk-plugin-setup-中文 空格-'));
  const profilePath = path.join(root, 'plugin.json');
  const libraryId = 'a'.repeat(64);
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ service: 'paperdesk', apiVersion: 1, libraryId }));
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  async function setup() {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/setup-plugin.mjs', import.meta.url)), '--base-url', `http://127.0.0.1:${server.address().port}`, '--config', profilePath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    const [code] = await once(child, 'close'); return { code, output };
  }
  assert.equal((await setup()).code, 0);
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  assert.equal(profile.libraryId, libraryId);
  assert.equal(profile.autoStart, false, 'Custom ports require a user-started service');
  profile.workspaceRoot += path.sep;
  await writeFile(profilePath, JSON.stringify(profile));
  assert.equal((await setup()).code, 0, 'A trailing separator must not look like a different workspace');
  profile.libraryId = 'b'.repeat(64);
  await writeFile(profilePath, JSON.stringify(profile));
  const before = await readFile(profilePath);
  const refused = await setup();
  assert.equal(refused.code, 1); assert.match(refused.output, /另一份工作区或文献库/);
  assert.deepEqual(await readFile(profilePath), before);
});
