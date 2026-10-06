import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { retainImageSnapshot } from '../server/chatgpt-ego.mjs';

// Original tiny PNGs and isolated local files only; no EGO or account access.
const canvas = createCanvas(3, 2);
const context = canvas.getContext('2d'); context.fillStyle = '#3567ab'; context.fillRect(0, 0, 3, 2);
const png = canvas.toBuffer('image/png');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'paperdesk-snapshot-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'selection.png') };
}

test('an original snapshot is read-only and identical bytes reuse its inode without rewriting', async t => {
  const { file } = await fixture(t);
  assert.equal(await retainImageSnapshot(file, png), sha256(png));
  const original = await stat(file, { bigint: true });
  assert.deepEqual(await readFile(file), png);
  if (process.platform !== 'win32') assert.equal(original.mode & 0o777n, 0o400n);
  assert.equal(await retainImageSnapshot(file, Buffer.from(png)), sha256(png));
  const reused = await stat(file, { bigint: true });
  assert.equal(reused.ino, original.ino); assert.equal(reused.dev, original.dev);
  assert.equal(reused.mtimeNs, original.mtimeNs, 'Same-byte reuse must not open the read-only snapshot for rewriting');
  assert.deepEqual(await readFile(file), png);
});

test('different bytes are rejected and the original read-only snapshot is preserved', async t => {
  const { file } = await fixture(t);
  await retainImageSnapshot(file, png);
  const original = await stat(file, { bigint: true });
  await assert.rejects(retainImageSnapshot(file, Buffer.concat([png, Buffer.from('different-bytes')])));
  assert.deepEqual(await readFile(file), png);
  const after = await stat(file, { bigint: true });
  assert.equal(after.ino, original.ino); assert.equal(after.mtimeNs, original.mtimeNs);
  if (process.platform !== 'win32') assert.equal(after.mode & 0o777n, 0o400n);
});

test('a symlink is rejected even when its target has identical PNG bytes', async t => {
  const { directory, file } = await fixture(t);
  const target = path.join(directory, 'original.png');
  await writeFile(target, png, { mode: 0o600 });
  await symlink(target, file);
  const original = await stat(target, { bigint: true });
  await assert.rejects(retainImageSnapshot(file, png));
  assert.equal((await lstat(file)).isSymbolicLink(), true);
  assert.deepEqual(await readFile(target), png);
  const after = await stat(target, { bigint: true });
  assert.equal(after.ino, original.ino); assert.equal(after.mode, original.mode); assert.equal(after.mtimeNs, original.mtimeNs);
});
