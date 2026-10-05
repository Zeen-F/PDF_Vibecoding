import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureReaderRuntime } from '../server/plugin-runtime.mjs';

const libraryId = 'a'.repeat(64);
const profile = { baseUrl: 'http://127.0.0.1:4317', libraryId, workspaceRoot: '/unconfigured-workspace', autoStart: true };
function offline() { throw new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }); }
function reply(value, status = 200) { return new Response(JSON.stringify(value), { status }); }

test('runtime reuses only an identity-matched live service without accessing or launching a workspace', async t => {
  t.mock.method(globalThis, 'fetch', async () => reply({ service: 'paperdesk', apiVersion: 1, libraryId }));
  assert.deepEqual(await ensureReaderRuntime(profile), { started: false });
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => reply({ service: 'paperdesk', apiVersion: 1, libraryId: 'b'.repeat(64) }));
  await assert.rejects(ensureReaderRuntime(profile), /身份.*不一致/);
});

test('runtime does not launch over a different service, malformed response, redirect or timeout', async t => {
  for (const make of [
    () => reply({ service: 'other', apiVersion: 1, libraryId }),
    () => new Response('not json'),
    () => reply({ service: 'paperdesk', apiVersion: 1, libraryId }, 503),
    () => { throw new Error('timeout'); },
  ]) {
    t.mock.restoreAll();
    t.mock.method(globalThis, 'fetch', async () => make());
    await assert.rejects(ensureReaderRuntime(profile), /不是兼容|无法核对/);
  }
});

test('runtime refuses implicit startup, remote targets and custom ports while offline', async t => {
  t.mock.method(globalThis, 'fetch', offline);
  await assert.rejects(ensureReaderRuntime({ ...profile, autoStart: false }), /尚未启动/);
  await assert.rejects(ensureReaderRuntime({ ...profile, autoStart: undefined }), /尚未启动/);
  await assert.rejects(ensureReaderRuntime({ ...profile, baseUrl: 'https://example.org' }), /loopback/);
  await assert.rejects(ensureReaderRuntime({ ...profile, baseUrl: 'http://127.0.0.1:4318' }), /4317/);
});

test('runtime requires the bound existing default library and built reader before creating logs or launching', async t => {
  t.mock.method(globalThis, 'fetch', offline);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'paperdesk-runtime-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bound = { ...profile, workspaceRoot: root, libraryId: createHash('sha256').update(join(root, 'data')).digest('hex') };
  await assert.rejects(ensureReaderRuntime({ ...bound, libraryId }), /只连接已绑定/);
  await assert.rejects(ensureReaderRuntime(bound), /ENOENT/);
  await assert.rejects(access(join(root, 'data')));
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'data', 'paperdesk.sqlite'), Buffer.alloc(128));
  await assert.rejects(ensureReaderRuntime(bound), /ENOENT/);
  await assert.rejects(access(join(root, '.local')));
});
