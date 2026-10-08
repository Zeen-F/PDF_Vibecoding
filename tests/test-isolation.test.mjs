import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedTestEnvironment } from '../scripts/test-isolated.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrapper = path.join(root, 'scripts/test-isolated.mjs');

async function run(args, environment = process.env) {
  const child = spawn(process.execPath, [wrapper, ...args], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try { const [code, signal] = await once(child, 'close'); return { code, signal, stdout, stderr }; }
  finally { clearTimeout(timer); }
}

test('isolated test environment removes production storage without mutating its caller or fixture settings', () => {
  const production = { PAPERDESK_VAULT_DIR: '/synthetic/vault', PAPERDESK_VAULT_SUBDIR: 'Formal',
    PAPERDESK_DATA_DIR: '/synthetic/cache', paperdesk_vault_dir: '/synthetic/windows-case', PATH: '/runtime',
    PAPERDESK_DESKTOP_USER_DATA: '/explicit/test-profile', PAPERDESK_PLUGIN_CONFIG: '/explicit/test-plugin' };
  const before = { ...production }, isolated = isolatedTestEnvironment(production);
  for (const key of ['PAPERDESK_VAULT_DIR', 'PAPERDESK_VAULT_SUBDIR', 'PAPERDESK_DATA_DIR', 'paperdesk_vault_dir']) assert.equal(isolated[key], undefined);
  assert.equal(isolated.PATH, production.PATH);
  assert.equal(isolated.PAPERDESK_DESKTOP_USER_DATA, production.PAPERDESK_DESKTOP_USER_DATA);
  assert.equal(isolated.PAPERDESK_PLUGIN_CONFIG, production.PAPERDESK_PLUGIN_CONFIG);
  assert.deepEqual(production, before);
});

test('real isolated test child cannot initialize inherited production vault or cache', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'paperdesk-test-isolation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const vaultDir = path.join(directory, 'production-vault'), productionCache = path.join(directory, 'production-cache');
  await mkdir(path.join(vaultDir, '.obsidian'), { recursive: true });
  await writeFile(path.join(vaultDir, 'original.txt'), 'production fixture remains unchanged');
  const fixture = path.join(directory, 'isolated-library');
  const script = `import assert from 'node:assert/strict';
    import {createApp} from ${JSON.stringify(new URL('../server/app.mjs', import.meta.url).href)};
    for (const key of ['PAPERDESK_VAULT_DIR','PAPERDESK_VAULT_SUBDIR','PAPERDESK_DATA_DIR']) assert.equal(process.env[key],undefined);
    const runtime=createApp({dataDir:process.argv[1]}); await runtime.ready; await runtime.close();
    console.log('isolated library closed');`;
  const result = await run(['--input-type=module', '--eval', script, fixture], { ...process.env,
    PAPERDESK_VAULT_DIR: vaultDir, PAPERDESK_VAULT_SUBDIR: 'Formal', PAPERDESK_DATA_DIR: productionCache });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /isolated library closed/);
  await access(path.join(fixture, 'paperdesk.sqlite'));
  assert.deepEqual((await readdir(vaultDir)).sort(), ['.obsidian', 'original.txt']);
  assert.equal(await readFile(path.join(vaultDir, 'original.txt'), 'utf8'), 'production fixture remains unchanged');
  await assert.rejects(access(productionCache), { code: 'ENOENT' });
});

test('test wrapper forwards argument values, Node test globs and failing exit codes', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'paperdesk-test-arguments-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const probe = path.join(directory, 'arguments.mjs');
  await writeFile(probe, 'console.log(JSON.stringify(process.argv.slice(2)));');
  const result = await run([probe, '--packaged', path.join(directory, 'Paperdesk 中文.app')]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['--packaged', path.join(directory, 'Paperdesk 中文.app')]);
  assert.equal((await run(['--input-type=module', '--eval', 'process.exit(7)'])).code, 7);
  await writeFile(path.join(directory, 'probe-one.test.mjs'), "import test from 'node:test'; test('one',()=>{});");
  await writeFile(path.join(directory, 'probe-two.test.mjs'), "import test from 'node:test'; test('two',()=>{});");
  const glob = await run(['--test', '--test-reporter=tap', path.join(directory, 'probe-*.test.mjs')]);
  assert.equal(glob.code, 0, glob.stderr);
  assert.match(glob.stdout, /# tests 2/);
});

test('test wrapper relays termination and waits for child cleanup', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'paperdesk-test-signal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, 'cleaned.txt');
  const script = `import {writeFileSync} from 'node:fs';
    process.on('SIGTERM',()=>{writeFileSync(process.argv[1],'cleaned');process.exit(0)});
    console.log('ready');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, [wrapper, '--input-type=module', '--eval', script, marker], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'), timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  t.after(() => clearTimeout(timer));
  await once(child.stdout, 'data');
  child.kill('SIGTERM');
  assert.equal((await exited)[0], 143);
  assert.equal(await readFile(marker, 'utf8'), 'cleaned');
});
