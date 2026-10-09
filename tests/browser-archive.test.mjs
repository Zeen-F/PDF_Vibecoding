import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { crc32, inflateRawSync } from 'node:zlib';
import { createBrowserArchive } from '../scripts/browser-archive.mjs';
import { inspectArchive } from '../scripts/test-browser-release.mjs';

const topFolder = 'Paperdesk-1.2.0-beta.1-browser';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'paperdesk-zip-'));
  assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const source = path.join(directory, topFolder);
  await mkdir(source);
  return { directory, source, archive: path.join(directory, 'browser.zip') };
}

function contents(bytes) {
  const files = new Map();
  let position = 0;
  while (bytes.readUInt32LE(position) === 0x04034b50) {
    const flags = bytes.readUInt16LE(position + 6), method = bytes.readUInt16LE(position + 8);
    assert.ok(flags & 0x800, 'Every filename explicitly uses UTF-8.');
    assert.equal(method, 8);
    const compressed = bytes.readUInt32LE(position + 18), length = bytes.readUInt32LE(position + 22);
    const nameLength = bytes.readUInt16LE(position + 26), extraLength = bytes.readUInt16LE(position + 28);
    const name = bytes.subarray(position + 30, position + 30 + nameLength).toString('utf8');
    const start = position + 30 + nameLength + extraLength;
    const data = inflateRawSync(bytes.subarray(start, start + compressed));
    assert.equal(data.length, length);
    assert.equal(crc32(data), bytes.readUInt32LE(position + 14));
    files.set(name, data);
    position = start + compressed;
  }
  return files;
}

test('browser ZIP round-trips Unicode names, hidden plugin files and binary bytes with portable headers', async t => {
  const { directory, source, archive } = await fixture(t);
  const expected = new Map([
    ['README.md', Buffer.from('纸间 Windows\n')],
    ['启动纸间.command', Buffer.from('#!/bin/sh\n')],
    ['.agents/plugins/marketplace.json', Buffer.from('{}\n')],
    ['docs/中文 #说明.md', Buffer.from('UTF-8 与空格')],
    ['public/examples/reading-demo.pdf', Buffer.from([0, 1, 2, 127, 128, 255])],
  ]);
  for (const [name, data] of expected) {
    const file = path.join(source, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }
  await createBrowserArchive(source, archive, topFolder);
  const bytes = await readFile(archive);
  const inspected = inspectArchive(bytes);
  assert.equal(inspected.entries.size, expected.size);
  const extracted = contents(bytes);
  for (const [name, data] of expected) assert.deepEqual(extracted.get(`${topFolder}/${name}`), data);
  const repeat = path.join(directory, 'repeat.zip');
  await createBrowserArchive(source, repeat, topFolder);
  assert.deepEqual(await readFile(repeat), bytes, 'Archive is independent of file modification times.');
  await assert.rejects(createBrowserArchive(source, archive, topFolder), { code: 'EEXIST' });
  assert.deepEqual(await readFile(archive), bytes, 'An existing archive is not truncated.');
});

test('browser ZIP rejects links and unsafe names before creating an output file', async t => {
  const { directory, source, archive } = await fixture(t);
  const outside = path.join(directory, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'README.md'), 'private fixture');
  await symlink(outside, path.join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createBrowserArchive(source, archive, topFolder), /links/);
  await assert.rejects(readFile(archive), { code: 'ENOENT' });
  await assert.rejects(createBrowserArchive(source, archive, '../outside'), /Invalid browser archive root/);
});
