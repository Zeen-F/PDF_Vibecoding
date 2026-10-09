import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readDesktopSettings, writeDesktopSettings } from '../desktop/settings.mjs';
import { getVaultConfig } from '../server/vault-config.mjs';

test('desktop settings remember a library and port outside application files', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'paperdesk-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userData = path.join(root, 'profile'), dataDir = path.join(root, 'external-library');
  assert.equal(await readDesktopSettings(userData), null);
  await mkdir(dataDir);
  await writeFile(path.join(dataDir, 'paperdesk.sqlite'), Buffer.alloc(1024));
  await writeDesktopSettings(userData, { dataDir, port: 4317 });
  assert.deepEqual(await readDesktopSettings(userData), { version: 1, dataDir, port: 4317 });
  assert.deepEqual(await readdir(userData), ['desktop-settings.json']);
});

test('missing selected library never falls back to a newly created empty library', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'paperdesk-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'missing-library');
  await writeDesktopSettings(root, { dataDir, port: 4317 });
  const before = await readFile(path.join(root, 'desktop-settings.json'));
  await assert.rejects(readDesktopSettings(root), /未创建替代/);
  assert.deepEqual(await readFile(path.join(root, 'desktop-settings.json')), before);
  assert.deepEqual(await readdir(root), ['desktop-settings.json']);
});

test('corrupt settings remain unchanged instead of overwriting the chosen path', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'paperdesk-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = '{broken settings';
  await writeFile(path.join(root, 'desktop-settings.json'), content);
  await assert.rejects(readDesktopSettings(root), /无法读取/);
  assert.equal(await readFile(path.join(root, 'desktop-settings.json'), 'utf8'), content);
});

test('desktop remembers an existing vault when its rebuildable cache is absent', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'paperdesk-settings-vault-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userData = path.join(root, 'profile'), vaultDir = path.join(root, '知识库'), dataDir = path.join(root, 'missing-cache');
  await mkdir(path.join(vaultDir, '.obsidian'), { recursive: true });
  const config = getVaultConfig({ vaultDir, dataDir });
  await writeDesktopSettings(userData, { vaultDir, dataDir, port: 4317 });
  assert.deepEqual(await readDesktopSettings(userData), {
    version: 1, vaultDir: config.vaultDir, vaultSubdir: 'Paperdesk', dataDir: config.dataDir, port: 4317,
  });
  assert.deepEqual(await readdir(vaultDir), ['.obsidian']);
  assert.deepEqual((await readdir(root)).sort(), ['profile', '知识库']);
});

test('missing remembered vault fails without creating a substitute or rewriting settings', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'paperdesk-settings-vault-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultDir = path.join(root, 'vault'), dataDir = path.join(root, 'cache');
  await mkdir(path.join(vaultDir, '.obsidian'), { recursive: true });
  await writeDesktopSettings(root, { vaultDir, dataDir, port: 4317 });
  await rm(vaultDir, { recursive: true });
  const before = await readFile(path.join(root, 'desktop-settings.json'));
  await assert.rejects(readDesktopSettings(root), /未创建替代/);
  assert.deepEqual(await readFile(path.join(root, 'desktop-settings.json')), before);
  assert.deepEqual(await readdir(root), ['desktop-settings.json']);
});

test('vault settings reject a cache inside the vault before writing any settings', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'paperdesk-settings-vault-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultDir = path.join(root, 'vault'), profile = path.join(root, 'profile');
  await mkdir(path.join(vaultDir, '.obsidian'), { recursive: true });
  await assert.rejects(writeDesktopSettings(profile, { vaultDir, dataDir: path.join(vaultDir, 'cache'), port: 4317 }), /知识库之外/);
  assert.deepEqual(await readdir(vaultDir), ['.obsidian']);
  assert.deepEqual(await readdir(root), ['vault']);
});

test('Windows vault cache defaults to the roaming application directory outside the source vault', { skip: process.platform !== 'win32' }, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'paperdesk-settings-win-')));
  const previous = process.env.APPDATA;
  t.after(async () => {
    if (previous === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previous;
    await rm(root, { recursive: true, force: true });
  });
  const vaultDir = path.join(root, '知识库'), roaming = path.join(root, 'Roaming with spaces');
  await mkdir(path.join(vaultDir, '.obsidian'), { recursive: true });
  process.env.APPDATA = roaming;
  const config = getVaultConfig({ vaultDir });
  assert.equal(path.dirname(config.dataDir), path.join(roaming, 'Paperdesk', 'vault-cache'));
  assert.equal(path.relative(vaultDir, config.dataDir).split(path.sep)[0], '..');
  assert.deepEqual(await readdir(root), ['知识库'], 'Resolving settings must not create the cache or rewrite the source vault');
});
