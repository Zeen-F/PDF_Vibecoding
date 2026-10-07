import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readDesktopSettings, writeDesktopSettings } from '../desktop/settings.mjs';

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
