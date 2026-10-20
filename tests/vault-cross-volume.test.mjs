import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { bookmarkedPdf } from './fixtures/toc-browser.mjs';

test('real separate-volume vault saves, fails closed and rebuilds reading position after restart', {
  skip: !process.env.PAPERDESK_TEST_VAULT_PARENT && 'Set PAPERDESK_TEST_VAULT_PARENT to a synthetic test directory on a second volume.',
}, async t => {
  const parent = fs.realpathSync.native(process.env.PAPERDESK_TEST_VAULT_PARENT);
  const cacheParent = fs.realpathSync.native(tmpdir());
  const vaultBase = fs.mkdtempSync(path.join(parent, 'paperdesk-cross-volume-'));
  const cacheBase = fs.mkdtempSync(path.join(cacheParent, 'paperdesk-cross-volume-'));
  const vaultDir = path.join(vaultBase, 'synthetic-vault'), dataDir = path.join(cacheBase, 'cache');
  let runtime, server;
  const stop = async () => {
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    if (runtime) await runtime.close();
    server = runtime = undefined;
  };
  t.after(async () => {
    await stop();
    for (const [root, expectedParent] of [[vaultBase, parent], [cacheBase, cacheParent]]) {
      assert.equal(path.dirname(fs.realpathSync.native(root)), expectedParent);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  fs.mkdirSync(path.join(vaultDir, '.obsidian'), { recursive: true });
  const probe = path.join(vaultBase, 'volume-probe'); fs.writeFileSync(probe, 'synthetic');
  assert.throws(() => fs.linkSync(probe, path.join(cacheBase, 'volume-probe')), { code: 'EXDEV' }, 'The test must use genuinely different volumes');
  const start = async () => {
    runtime = createApp({ vaultDir, dataDir }); await runtime.ready;
    server = runtime.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  };
  const request = (route, body) => fetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
    method: body ? 'PATCH' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  await start();
  const form = new FormData(); form.append('file', new Blob([bookmarkedPdf()]), 'Synthetic-cross-volume.pdf');
  const uploaded = await fetch(`http://127.0.0.1:${server.address().port}/api/documents`, { method: 'POST', body: form });
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const doc = (await uploaded.json()).document, route = `/documents/${doc.id}`;
  const note = path.join(vaultDir, 'Paperdesk', 'Notes', `${doc.id}.md`), original = fs.readFileSync(note);
  const recovery = path.join(dataDir, 'recoveries', 'originals');
  fs.mkdirSync(path.dirname(recovery), { recursive: true }); fs.writeFileSync(recovery, 'synthetic occupied recovery directory');
  let response = await request(route, { lastPage: 3, positionWriterId: randomUUID(), positionSequence: 1 });
  assert.equal(response.status, 409, await response.clone().text()); assert.deepEqual(fs.readFileSync(note), original);
  fs.unlinkSync(recovery);
  response = await request(route, { lastPage: 3, positionWriterId: randomUUID(), positionSequence: 1 });
  assert.equal(response.status, 200, await response.clone().text());
  const saved = (await response.json()).document; assert.equal(saved.lastPage, 3);
  response = await request(route, { notesZh: '# Synthetic saved note\n', notesEn: '', expectedNotesRevision: saved.notesRevision });
  assert.equal(response.status, 200, await response.clone().text());
  assert.ok(fs.readdirSync(recovery).some(name => name.endsWith('.md')));
  assert.ok(fs.readdirSync(path.dirname(note)).some(name => name.endsWith('.paperdesk-recovery')));
  await stop();
  for (const name of ['paperdesk.sqlite', 'paperdesk.sqlite-wal', 'paperdesk.sqlite-shm']) fs.rmSync(path.join(dataDir, name), { force: true });
  await start();
  const reopened = (await (await request(route)).json()).document;
  assert.equal(reopened.lastPage, 3); assert.equal(reopened.notesZh, '# Synthetic saved note\n');
  t.diagnostic('Verified native EXDEV, failed-save preservation, retry, note save and restart/index reconstruction from synthetic vault Markdown.');
});
