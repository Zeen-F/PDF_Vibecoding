import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'paperdesk-position-api-'));
  const file = join(dataDir, 'paperdesk.sqlite'), documentId = randomUUID();
  let runtime, server, base;
  async function start() {
    runtime = createApp({ dataDir });
    server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = undefined; }
    if (runtime) { await runtime.close(); runtime = undefined; }
  }
  function database(work) { const db = new DatabaseSync(file); try { return work(db); } finally { db.close(); } }
  t.after(async () => { await stop(); await rm(dataDir, { recursive: true, force: true }); });
  await start();
  database(db => db.prepare(`INSERT INTO documents(id,sha256,title,filename,page_count,byte_size,created_at,updated_at,text_available,notes_zh)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(documentId, randomUUID(), 'Synthetic position fixture', 'synthetic.pdf', 3, 0, '2025-01-01', '2025-01-01', 0, 'Preserved notes'));
  async function patch(body, status = 200, id = documentId) {
    const response = await fetch(`${base}/api/documents/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result;
  }
  async function read(id = documentId) { return (await (await fetch(`${base}/api/documents/${id}`)).json()).document; }
  return { documentId, patch, read, stop, start, database };
}

test('newer reading positions survive late writes and service restart without modifying notes', async t => {
  const lib = await fixture(t), writerId = randomUUID();
  const newer = await lib.patch({ lastPage: 3, positionWriterId: writerId, positionSequence: 2 });
  assert.equal(newer.positionStale, false); assert.equal(newer.positionReplayed, false);
  const old = await lib.patch({ lastPage: 2, positionWriterId: writerId, positionSequence: 1 });
  assert.equal(old.positionStale, true); assert.equal(old.document.lastPage, 3);
  assert.deepEqual(await lib.read(), newer.document, 'Stale arrival cannot touch notes, ordering or position');
  await lib.stop(); await lib.start();
  const oldAfterRestart = await lib.patch({ lastPage: 2, positionWriterId: writerId, positionSequence: 1 });
  assert.equal(oldAfterRestart.positionStale, true);
  const replay = await lib.patch({ lastPage: 3, positionWriterId: writerId.toUpperCase(), positionSequence: 2 });
  assert.equal(replay.positionReplayed, true); assert.equal(replay.positionStale, false);
  assert.deepEqual(replay.document, newer.document);
  await lib.patch({ lastPage: 1, positionWriterId: writerId, positionSequence: 2 }, 409);
  assert.deepEqual(await lib.read(), newer.document);
  await lib.patch({ lastPage: 1, positionWriterId: randomUUID(), positionSequence: 1 });
  assert.equal((await lib.read()).lastPage, 1, 'Independent windows can intentionally save their own positions');
  assert.equal((await lib.read()).notesZh, 'Preserved notes');
});

test('reading sequence validation and failed document writes leave both position and tracker intact', async t => {
  const lib = await fixture(t), writerId = randomUUID();
  const body = { lastPage: 2, positionWriterId: writerId, positionSequence: 1 };
  for (const invalid of [
    { ...body, positionWriterId: 'bad' }, { ...body, positionSequence: 0 }, { ...body, positionSequence: 1.1 },
    { ...body, positionSequence: Number.MAX_SAFE_INTEGER + 1 }, { lastPage: 2, positionWriterId: writerId },
    { lastPage: 2, positionSequence: 1 }, { positionWriterId: writerId, positionSequence: 1 },
    { ...body, notesZh: 'Cannot mix into a possibly stale write' }, { ...body, title: 'Mixed metadata' },
  ]) await lib.patch(invalid, 400);
  lib.database(db => db.exec("CREATE TRIGGER fail_position BEFORE UPDATE OF last_page ON documents BEGIN SELECT RAISE(ABORT, 'synthetic position failure'); END;"));
  await lib.patch(body, 500);
  assert.equal((await lib.read()).lastPage, 1);
  lib.database(db => { assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reading_position_writers').get().count, 0); db.exec('DROP TRIGGER fail_position;'); });
  const saved = await lib.patch(body);
  assert.equal(saved.document.lastPage, 2);
  await lib.patch({ lastPage: 3 });
  assert.equal((await lib.read()).lastPage, 3, 'The legacy unsequenced API stays compatible');
});

test('reading writer records have finite retention and capacity failures preserve valid sequence protection', async t => {
  const lib = await fixture(t), writerId = randomUUID();
  await lib.patch({ lastPage: 3, positionWriterId: writerId, positionSequence: 2 });
  lib.database(db => {
    const insert = db.prepare('INSERT INTO reading_position_writers(document_id,writer_id,sequence,page,updated_at) VALUES (?,?,?,?,?)');
    db.exec('BEGIN IMMEDIATE;');
    try {
      for (let i = 1; i < 10000; i++) insert.run(lib.documentId, randomUUID(), 1, 1, Date.now());
      db.exec('COMMIT;');
    } catch (error) { db.exec('ROLLBACK;'); throw error; }
  });
  await lib.patch({ lastPage: 2, positionWriterId: randomUUID(), positionSequence: 1 }, 429);
  assert.equal((await lib.read()).lastPage, 3);
  const stale = await lib.patch({ lastPage: 1, positionWriterId: writerId, positionSequence: 1 });
  assert.equal(stale.positionStale, true, 'At capacity, an old writer still cannot replace its latest page');
  lib.database(db => db.prepare('UPDATE reading_position_writers SET updated_at = ? WHERE writer_id <> ?').run(Date.now() - 31 * 86400_000, writerId));
  await lib.patch({ lastPage: 2, positionWriterId: randomUUID(), positionSequence: 1 });
  lib.database(db => assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reading_position_writers').get().count, 2));
  await lib.patch({ lastPage: 3, positionWriterId: writerId, positionSequence: 3 });
  assert.equal((await lib.read()).lastPage, 3);
});
