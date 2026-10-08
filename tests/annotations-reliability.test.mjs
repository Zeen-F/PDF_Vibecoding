import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { CURRENT_SCHEMA } from '../shared/library.mjs';

const sample = await readFile(new URL('../public/examples/reading-demo.pdf', import.meta.url));
const payload = { page: 1, quote: 'Synthetic annotation evidence', comment: 'Initial comment', color: 'yellow', rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }] };

async function library(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'paperdesk-annotations-reliability-'));
  const file = join(dataDir, 'paperdesk.sqlite');
  let runtime, server, base;
  async function start() {
    runtime = createApp({ dataDir });
    server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server = undefined;
    }
    if (runtime) { await runtime.close(); runtime = undefined; }
  }
  t.after(async () => { await stop(); await rm(dataDir, { recursive: true, force: true }); });
  await start();
  async function request(path, method = 'GET', body) {
    return fetch(`${base}${path}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async function json(path, method, body, status = 200) {
    const response = await request(path, method, body);
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  async function upload(bytes = sample) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'synthetic-demo.pdf');
    const response = await fetch(`${base}/api/documents`, { method: 'POST', body: form });
    assert.equal(response.status, 201);
    return (await response.json()).document;
  }
  function database(work) {
    const db = new DatabaseSync(file);
    try { db.exec('PRAGMA foreign_keys = ON;'); return work(db); } finally { db.close(); }
  }
  return { dataDir, file, stop, start, request, json, upload, database };
}

test('annotation create, edit and delete roll back when the document update fails', async t => {
  const lib = await library(t), doc = await lib.upload();
  const endpoint = `/api/documents/${doc.id}/annotations`;
  const created = (await lib.json(endpoint, 'POST', payload, 201)).annotation;
  const before = await lib.json(`/api/documents/${doc.id}`);
  // Fault only the second statement, after the annotation mutation would run.
  lib.database(db => db.exec("CREATE TRIGGER fail_annotation_touch BEFORE UPDATE OF updated_at ON documents BEGIN SELECT RAISE(ABORT, 'synthetic touch failure'); END;"));
  for (const [path, method, body] of [
    [endpoint, 'POST', { ...payload, comment: 'Must not appear' }],
    [`${endpoint}/${created.id}`, 'PATCH', { comment: 'Must not replace', color: 'green' }],
    [`${endpoint}/${created.id}`, 'DELETE', undefined],
  ]) {
    await lib.json(path, method, body, 500);
    assert.deepEqual(await lib.json(`/api/documents/${doc.id}`), before, `${method} must roll back both changes`);
  }
  lib.database(db => db.exec('DROP TRIGGER fail_annotation_touch;'));
  await lib.stop(); await lib.start();
  assert.deepEqual(await lib.json(`/api/documents/${doc.id}`), before, 'Rollback must survive restart');
});

test('creation IDs deduplicate simultaneous and restarted retries, reject changed payloads and do not resurrect deleted annotations', async t => {
  const lib = await library(t), doc = await lib.upload();
  const endpoint = `/api/documents/${doc.id}/annotations`, requestId = randomUUID();
  const request = { ...payload, requestId };
  const responses = await Promise.all([lib.request(endpoint, 'POST', request), lib.request(endpoint, 'POST', request)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 201]);
  const results = await Promise.all(responses.map(response => response.json()));
  assert.equal(results[0].annotation.id, results[1].annotation.id);
  assert.equal(results.filter(result => result.replayed).length, 1);
  const original = results[0].annotation;
  assert.equal((await lib.json(`/api/documents/${doc.id}`)).annotations.length, 1);
  await lib.json(endpoint, 'POST', { ...request, comment: 'Different operation' }, 409);
  await lib.json(`${endpoint}/${original.id}`, 'PATCH', { comment: 'Later saved comment', color: 'pink' });
  await lib.stop(); await lib.start();
  const beforeRetry = await lib.json(`/api/documents/${doc.id}`);
  const retry = await lib.json(endpoint, 'POST', { rects: payload.rects, color: payload.color, quote: payload.quote, page: 1, comment: payload.comment, kind: 'text', requestId: requestId.toUpperCase() });
  assert.equal(retry.replayed, true);
  assert.equal(retry.annotation.id, original.id);
  assert.equal(retry.annotation.comment, 'Later saved comment', 'A retry returns the current saved annotation');
  assert.deepEqual(await lib.json(`/api/documents/${doc.id}`), beforeRetry, 'A replay must not touch document ordering or annotation dates');
  await lib.json(`${endpoint}/${original.id}`, 'DELETE');
  await lib.json(endpoint, 'POST', request, 409);
  assert.deepEqual((await lib.json(`/api/documents/${doc.id}`)).annotations, []);
});

test('failed creation does not reserve its ID and successful IDs are scoped to their document', async t => {
  const lib = await library(t), doc = await lib.upload();
  const endpoint = `/api/documents/${doc.id}/annotations`, requestId = randomUUID();
  const request = { ...payload, requestId };
  lib.database(db => db.exec("CREATE TRIGGER fail_annotation_touch BEFORE UPDATE OF updated_at ON documents BEGIN SELECT RAISE(ABORT, 'synthetic touch failure'); END;"));
  await lib.json(endpoint, 'POST', request, 500);
  lib.database(db => {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM annotations').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM annotation_requests').get().count, 0);
    db.exec('DROP TRIGGER fail_annotation_touch;');
  });
  const saved = (await lib.json(endpoint, 'POST', request, 201)).annotation;
  const secondId = randomUUID();
  lib.database(db => db.prepare(`INSERT INTO documents(id,sha256,title,filename,page_count,byte_size,created_at,updated_at,text_available)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(secondId, randomUUID(), 'Synthetic second document', 'synthetic.pdf', 1, 0, doc.createdAt, doc.updatedAt, 0));
  const second = (await lib.json(`/api/documents/${secondId}/annotations`, 'POST', request, 201)).annotation;
  assert.notEqual(second.id, saved.id);
  for (const invalid of [null, '', 'invalid-id', 42]) await lib.json(endpoint, 'POST', { ...payload, requestId: invalid }, 400);
  await lib.json(endpoint, 'POST', { ...payload, ignored: true }, 400);
  const legacy = await lib.json(endpoint, 'POST', payload, 201);
  assert.notEqual(legacy.annotation.id, saved.id, 'Omitting the new ID preserves the old create API');
});

test('annotation revision checks preserve another window and accept an uncertain matching save', async t => {
  const lib = await library(t), doc = await lib.upload();
  const endpoint = `/api/documents/${doc.id}/annotations`;
  const initial = (await lib.json(endpoint, 'POST', payload, 201)).annotation;
  const update = { comment: 'Window A saved comment', color: 'green', expectedAnnotationUpdatedAt: initial.updatedAt };
  const saved = (await lib.json(`${endpoint}/${initial.id}`, 'PATCH', update)).annotation;
  assert.notEqual(saved.updatedAt, initial.updatedAt, 'Revision tokens must change even within the same millisecond');
  await lib.json(`${endpoint}/${initial.id}`, 'PATCH', { comment: 'Stale window B', expectedAnnotationUpdatedAt: initial.updatedAt }, 409);
  assert.deepEqual((await lib.json(`${endpoint}/${initial.id}`, 'PATCH', update)).annotation, saved, 'Lost-response retry with already-saved content is a no-op success');
  assert.deepEqual((await lib.json(`/api/documents/${doc.id}`)).annotations, [saved]);
  await lib.json(`${endpoint}/${initial.id}`, 'PATCH', { expectedAnnotationUpdatedAt: null }, 400);
  await lib.json(`${endpoint}/${initial.id}`, 'PATCH', { comment: 'Legacy client remains supported' });
});

test('creation ID storage is bounded without evicting valid IDs and expiry frees capacity atomically', async t => {
  const lib = await library(t), doc = await lib.upload();
  const endpoint = `/api/documents/${doc.id}/annotations`, requestId = randomUUID();
  const request = { ...payload, requestId };
  const original = (await lib.json(endpoint, 'POST', request, 201)).annotation;
  lib.database(db => {
    const insert = db.prepare('INSERT INTO annotation_requests(document_id,request_id,request_hash,annotation_id,created_at) VALUES (?,?,?,?,?)');
    db.exec('BEGIN IMMEDIATE;');
    try {
      for (let i = 1; i < 10000; i++) insert.run(doc.id, randomUUID(), 'synthetic-hash', randomUUID(), Date.now());
      db.exec('COMMIT;');
    } catch (error) { db.exec('ROLLBACK;'); throw error; }
  });
  assert.equal((await lib.json(endpoint, 'POST', request)).annotation.id, original.id, 'Valid matching retry still works at capacity');
  await lib.json(endpoint, 'POST', { ...payload, requestId: randomUUID() }, 429);
  assert.equal((await lib.json(`/api/documents/${doc.id}`)).annotations.length, 1, 'Capacity failure cannot mutate annotations');
  lib.database(db => db.prepare('UPDATE annotation_requests SET created_at = ? WHERE request_id <> ?').run(Date.now() - 31 * 86400_000, requestId));
  await lib.json(endpoint, 'POST', { ...payload, requestId: randomUUID() }, 201);
  lib.database(db => assert.equal(db.prepare('SELECT COUNT(*) AS count FROM annotation_requests').get().count, 2));
  assert.equal((await lib.json(endpoint, 'POST', request)).annotation.id, original.id);
});

function records(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries(['documents', 'pages', 'annotations'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))]));
  } finally { db.close(); }
}

test('schema 4 adds only retry metadata, preserves old records and PDF bytes, and migration failure restores schema 3', async t => {
  const lib = await library(t), doc = await lib.upload();
  await lib.json(`/api/documents/${doc.id}`, 'PATCH', { notesZh: '合成旧库笔记', notesEn: 'Legacy English notes', lastPage: 2 });
  await lib.json(`/api/documents/${doc.id}/annotations`, 'POST', payload, 201);
  await lib.stop();
  lib.database(db => db.exec('DROP TABLE IF EXISTS annotation_requests; DROP TABLE IF EXISTS reading_position_writers; PRAGMA user_version = 3;'));
  const before = records(lib.file), pdfFile = join(lib.dataDir, 'pdfs', `${doc.id}.pdf`);
  const backup = await mkdtemp(join(tmpdir(), 'paperdesk-schema3-cold-backup-'));
  t.after(() => rm(backup, { recursive: true, force: true }));
  await cp(lib.dataDir, join(backup, 'library'), { recursive: true });
  await lib.start();
  assert.equal(CURRENT_SCHEMA, 5);
  lib.database(db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, CURRENT_SCHEMA);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM annotation_requests').get().count, 0);
  });
  assert.deepEqual(records(lib.file), before);
  assert.deepEqual(await readFile(pdfFile), sample);
  await lib.stop(); await lib.start();
  assert.deepEqual(records(lib.file), before, 'Repeated startup does not rewrite old rows');
  await lib.stop();
  assert.deepEqual(records(join(backup, 'library', 'paperdesk.sqlite')), before, 'Cold backup remains a complete pre-migration recovery source');
  assert.deepEqual(await readFile(join(backup, 'library', 'pdfs', `${doc.id}.pdf`)), sample);
  lib.database(db => db.exec('DROP TABLE reading_position_writers; DROP TABLE annotation_requests; CREATE TABLE annotation_requests (incompatible TEXT); PRAGMA user_version = 3;'));
  const schemaBefore = lib.database(db => db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all());
  assert.throws(() => createApp({ dataDir: lib.dataDir }), /created_at/);
  assert.deepEqual(records(lib.file), before);
  lib.database(db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
    assert.deepEqual(db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(), schemaBefore);
    db.exec('BEGIN IMMEDIATE; ROLLBACK;');
  });
  assert.deepEqual(await readFile(pdfFile), sample);
});
