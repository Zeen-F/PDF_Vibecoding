import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isolatedTestEnvironment } from '../scripts/test-isolated.mjs';

const execute = promisify(execFileCallback);
const script = fileURLToPath(new URL('../scripts/release-checksums.mjs', import.meta.url));
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const winName = `Paperdesk-${version}-win-x64.exe`;
const macNames = ['dmg', 'zip'].map(extension => `Paperdesk-${version}-mac-arm64.${extension}`);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const invoke = (args, cwd) => execute(process.execPath, [script, ...args], { cwd, env: isolatedTestEnvironment(), timeout: 10_000 });

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'paperdesk-checksums-'));
  assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const releaseDir = path.join(directory, '合成 安装包');
  await mkdir(releaseDir);
  return { directory, releaseDir };
}

test('Windows checksums include only the current x64 portable and preserve Mac/browser manifests', async t => {
  const { directory, releaseDir } = await fixture(t);
  const bytes = Buffer.from('synthetic Windows portable bytes\n中文');
  await writeFile(path.join(releaseDir, winName), bytes);
  await writeFile(path.join(releaseDir, 'SHA256SUMS'), 'existing Mac checksum\n');
  await writeFile(path.join(releaseDir, 'SHA256SUMS-browser'), 'existing browser checksum\n');
  await invoke([releaseDir, '--platform', 'win32'], directory);
  assert.equal(await readFile(path.join(releaseDir, 'SHA256SUMS-win'), 'utf8'), `${sha256(bytes)}  ${winName}\n`);
  assert.equal(await readFile(path.join(releaseDir, 'SHA256SUMS'), 'utf8'), 'existing Mac checksum\n');
  assert.equal(await readFile(path.join(releaseDir, 'SHA256SUMS-browser'), 'utf8'), 'existing browser checksum\n');
  assert.deepEqual((await readdir(releaseDir)).sort(), [winName, 'SHA256SUMS', 'SHA256SUMS-browser', 'SHA256SUMS-win'].sort());
});

test('explicit Mac checksums retain the legacy directory argument and DMG/ZIP manifest format', async t => {
  const { directory, releaseDir } = await fixture(t);
  const expected = [];
  for (const filename of macNames) {
    const bytes = Buffer.from(`synthetic ${filename}\n`);
    await writeFile(path.join(releaseDir, filename), bytes);
    expected.push(`${sha256(bytes)}  ${filename}`);
  }
  await writeFile(path.join(releaseDir, 'SHA256SUMS-win'), 'existing Windows checksum\n');
  await invoke(['--platform', 'darwin', releaseDir], directory);
  assert.equal(await readFile(path.join(releaseDir, 'SHA256SUMS'), 'utf8'), `${expected.join('\n')}\n`);
  assert.equal(await readFile(path.join(releaseDir, 'SHA256SUMS-win'), 'utf8'), 'existing Windows checksum\n');
  assert.ok(!(await readdir(releaseDir)).some(filename => filename.endsWith('.tmp')));
});

test('Windows ZIP checksums select the requested release format and reject unknown formats', async t => {
  const { directory, releaseDir } = await fixture(t);
  const zipName = `Paperdesk-${version}-win-x64.zip`;
  const bytes = Buffer.from('synthetic Windows directory archive');
  await writeFile(path.join(releaseDir, zipName), bytes);
  await writeFile(path.join(releaseDir, winName), 'unselected portable');
  await invoke([releaseDir, '--platform', 'win32', '--windows-format', 'zip'], directory);
  const expected = `${sha256(bytes)}  ${zipName}\n`;
  assert.equal(await readFile(path.join(releaseDir, 'SHA256SUMS-win'), 'utf8'), expected);
  await assert.rejects(invoke([releaseDir, '--platform', 'win32', '--windows-format', 'other'], directory));
  assert.equal(await readFile(path.join(releaseDir, 'SHA256SUMS-win'), 'utf8'), expected);
});

test('the original single directory argument selects the current host platform', async t => {
  const { directory, releaseDir } = await fixture(t);
  const windows = process.platform === 'win32', filenames = windows ? [winName] : macNames;
  const lines = [];
  for (const filename of filenames) {
    const bytes = Buffer.from(`synthetic host installer ${filename}`);
    await writeFile(path.join(releaseDir, filename), bytes);
    lines.push(`${sha256(bytes)}  ${filename}`);
  }
  await invoke([releaseDir], directory);
  assert.equal(await readFile(path.join(releaseDir, windows ? 'SHA256SUMS-win' : 'SHA256SUMS'), 'utf8'), `${lines.join('\n')}\n`);
});

test('missing or empty installers fail before replacing existing manifests on either platform', async t => {
  const { directory, releaseDir } = await fixture(t);
  const sentinels = { SHA256SUMS: 'previous Mac checksum\n', 'SHA256SUMS-win': 'previous Windows checksum\n', 'SHA256SUMS-browser': 'previous browser checksum\n' };
  for (const [name, text] of Object.entries(sentinels)) await writeFile(path.join(releaseDir, name), text);
  // Mac has the DMG but no ZIP, so partial inputs cannot publish half a manifest.
  await writeFile(path.join(releaseDir, macNames[0]), 'synthetic DMG');
  for (const platform of ['win32', 'darwin']) await assert.rejects(invoke([releaseDir, '--platform', platform], directory), error => error.code === 1);
  await writeFile(path.join(releaseDir, winName), Buffer.alloc(0));
  await assert.rejects(invoke([releaseDir, '--platform', 'win32'], directory), error => error.code === 1 && /missing or empty/.test(error.stderr));
  for (const [name, text] of Object.entries(sentinels)) assert.equal(await readFile(path.join(releaseDir, name), 'utf8'), text);
  assert.ok(!(await readdir(releaseDir)).some(filename => filename.endsWith('.tmp')));
});

test('a blocked manifest replacement preserves the occupant and removes its temporary checksum file', async t => {
  const { directory, releaseDir } = await fixture(t);
  await writeFile(path.join(releaseDir, winName), 'synthetic portable');
  const occupied = path.join(releaseDir, 'SHA256SUMS-win');
  await mkdir(occupied);
  await writeFile(path.join(occupied, 'keep.txt'), 'existing occupant');
  await assert.rejects(invoke([releaseDir, '--platform', 'win32'], directory), error => error.code === 1);
  assert.equal(await readFile(path.join(occupied, 'keep.txt'), 'utf8'), 'existing occupant');
  assert.deepEqual((await readdir(releaseDir)).sort(), [winName, 'SHA256SUMS-win'].sort());
});
