import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';
import { request as httpRequest } from 'node:http';
import { createApp } from '../server/app.mjs';
import { bookmarkedPdf } from './fixtures/toc-browser.mjs';
import { graphicsOnlyPdf as scanPdf } from './fixtures/scan-browser.mjs';
import { MAX_NOTE_LENGTH } from '../shared/notes.mjs';

const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
const revision = (zh, en) => createHash('sha256').update(JSON.stringify([zh, en])).digest('hex');

async function start(dataDir) {
  const runtime = createApp({ dataDir });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    request(url, body, method = 'POST', headers = {}) {
      return fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    },
    async get(url) {
      const response = await fetch(`${base}${url}`);
      assert.equal(response.status, 200);
      return response.json();
    },
    async upload(bytes = bookmarkedPdf()) {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'original-plugin-example.pdf');
      const response = await fetch(`${base}/api/documents`, { method: 'POST', body: form });
      assert.equal(response.status, 201);
      return (await response.json()).document;
    },
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      runtime.close();
    },
  };
}

async function library(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'paperdesk-plugin-'));
  let current = await start(dataDir);
  t.after(async () => { await current.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, get app() { return current; }, async restart() { await current.close(); current = await start(dataDir); } };
}

async function error(response, expected = 400) {
  assert.equal(response.status, expected);
  const body = await response.json();
  assert.equal(typeof body.error, 'string');
  assert.ok(body.error.length > 0);
  assert.ok(!Object.hasOwn(body, 'document'));
  return body;
}

const sessionBody = (doc, patch = {}) => ({ documentId: doc.id, page: 2, selection: null, notesDirty: false, visible: true, ...patch });

test('plugin identity and page reads are scoped to one library and preserve original bytes and schema', async t => {
  const lib = await library(t);
  const source = bookmarkedPdf();
  const doc = await lib.app.upload(source);
  assert.equal(doc.notesRevision, revision('', ''));
  const before = await lib.app.get('/api/plugin/status');
  assert.deepEqual(Object.keys(before).sort(), ['apiVersion', 'instanceId', 'libraryId', 'service']);
  assert.equal(before.service, 'paperdesk');
  assert.equal(before.apiVersion, 1);
  assert.equal(before.libraryId, createHash('sha256').update(path.resolve(lib.dataDir)).digest('hex'));
  assert.ok(!JSON.stringify(before).includes(lib.dataDir));
  assert.equal((await lib.app.get('/api/plugin/status')).instanceId, before.instanceId);
  const page = await lib.app.get(`/api/documents/${doc.id}/pages/3`);
  assert.equal(page.documentId, doc.id);
  assert.equal(page.page, 3);
  assert.equal(page.textAvailable, true);
  assert.match(page.text, /1\.1 Scope/);
  assert.ok(!page.text.includes('Methods starts'), 'Reading one page must not return adjacent pages');
  const scan = await lib.app.upload(scanPdf());
  assert.deepEqual(await lib.app.get(`/api/documents/${scan.id}/pages/1`), { documentId: scan.id, page: 1, text: '', textAvailable: false });
  for (const invalid of ['0', '7', '1.5', 'NaN', '-1', '1e0', '01']) {
    await error(await lib.app.request(`/api/documents/${doc.id}/pages/${invalid}`, undefined, 'GET'));
  }
  await error(await lib.app.request(`/api/documents/${randomUUID()}/pages/1`, undefined, 'GET'), 404);
  for (const url of ['/api/plugin/status', `/api/documents/${doc.id}/pages/1`, '/api/reader-context']) {
    await error(await lib.app.request(url, undefined, 'GET', { Origin: 'https://example.com' }), 403);
    const hostStatus = await new Promise((resolve, reject) => {
      const request = httpRequest(`${lib.app.base}${url}`, { headers: { Host: 'foreign.example' } }, response => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(hostStatus, 403);
  }
  await lib.restart();
  const after = await lib.app.get('/api/plugin/status');
  assert.notEqual(after.instanceId, before.instanceId);
  assert.equal(after.libraryId, before.libraryId);
  const db = new DatabaseSync(path.join(lib.dataDir, 'paperdesk.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name), ['annotations', 'documents', 'folders', 'library_preferences', 'pages']);
  } finally { db.close(); }
  assert.deepEqual(await readFile(path.join(lib.dataDir, 'pdfs', `${doc.id}.pdf`)), source);
  assert.deepEqual(Buffer.from(await (await fetch(`${lib.app.base}/api/documents/${doc.id}/file`)).arrayBuffer()), source);
});

test('notes revision protects concurrent PATCH writes without breaking old clients or metadata updates', async t => {
  const { app } = await library(t);
  const doc = await app.upload();
  const url = `/api/documents/${doc.id}`;
  const secret = '私密笔记，错误响应不得包含此内容';
  const results = await Promise.all(['first', secret].map(notesZh => app.request(url, { notesZh, expectedNotesRevision: doc.notesRevision }, 'PATCH')));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const current = (await app.get(url)).document;
  assert.equal(current.notesRevision, revision(current.notesZh, current.notesEn));
  const rejected = await error(await app.request(url, { notesZh: 'stale', expectedNotesRevision: doc.notesRevision }, 'PATCH'), 409);
  assert.ok(!JSON.stringify(rejected).includes(current.notesZh));
  const changedTitle = await app.request(url, { title: 'Renamed only', lastPage: 4, expectedNotesRevision: doc.notesRevision }, 'PATCH');
  assert.equal(changedTitle.status, 200);
  assert.equal((await changedTitle.json()).document.notesRevision, current.notesRevision);
  assert.equal((await app.request(url, { notesEn: 'Legacy English field' }, 'PATCH')).status, 200);
  const legacy = (await app.get(url)).document;
  assert.equal(legacy.notesRevision, revision(current.notesZh, 'Legacy English field'));
  assert.equal((await app.get('/api/documents')).documents[0].notesRevision, legacy.notesRevision);
  for (const bad of [null, 1, '', 'x'.repeat(64), 'A'.repeat(64), []]) {
    await error(await app.request(url, { notesZh: 'must not save', expectedNotesRevision: bad }, 'PATCH'));
  }
  assert.deepEqual((await app.get(url)).document, legacy);
});

test('reader context never guesses across windows, hidden sessions or expired snapshots', async t => {
  const lib = await library(t);
  const doc = await lib.app.upload();
  const other = await lib.app.upload(scanPdf());
  const id = randomUUID(), otherId = randomUUID();
  await error(await lib.app.request('/api/reader-context', undefined, 'GET'), 404);
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const first = await lib.app.request(`/api/reader-sessions/${id}`, sessionBody(doc, { selection: { kind: 'text', text: 'Selected scope', rects: [rect] } }));
  assert.equal(first.status, 200);
  const snapshot = await first.json();
  assert.deepEqual(Object.keys(snapshot.session).sort(), ['documentId', 'page', 'sessionId', 'updatedAt']);
  assert.equal(snapshot.document.notesRevision, doc.notesRevision);
  const context = await lib.app.get('/api/reader-context');
  assert.equal(context.sessionId, id);
  assert.equal(context.documentId, doc.id);
  assert.equal(context.page, 2);
  assert.equal(context.selection.text, 'Selected scope');
  assert.equal(context.notesDirty, false);
  assert.equal(context.updatedAt, new Date().toISOString());
  assert.equal(context.notesRevision, doc.notesRevision);
  assert.equal((await lib.app.request(`/api/reader-sessions/${otherId}`, sessionBody(other, { page: 1 }))).status, 200);
  const ambiguous = await error(await lib.app.request('/api/reader-context', undefined, 'GET'), 409);
  assert.deepEqual(ambiguous.sessions.map(item => item.documentId).sort(), [doc.id, other.id].sort());
  assert.ok(ambiguous.sessions.every(item => !Object.hasOwn(item, 'selection')));
  assert.equal((await lib.app.get(`/api/reader-context?sessionId=${id}`)).documentId, doc.id);
  assert.equal((await lib.app.request(`/api/reader-sessions/${otherId}`, sessionBody(other, { page: 1, visible: false }))).status, 200);
  assert.equal((await lib.app.get('/api/reader-context')).sessionId, id);
  await error(await lib.app.request(`/api/reader-context?sessionId=${otherId}`, undefined, 'GET'), 404);
  t.mock.timers.tick(29_999);
  assert.equal((await lib.app.get('/api/reader-context')).sessionId, id);
  t.mock.timers.tick(1);
  await error(await lib.app.request('/api/reader-context', undefined, 'GET'), 404);
  await error(await lib.app.request(`/api/reader-context?sessionId=${id}`, undefined, 'GET'), 404);
  assert.equal((await lib.app.request(`/api/reader-sessions/${id}`, sessionBody(doc))).status, 200);
  await lib.restart();
  await error(await lib.app.request('/api/reader-context', undefined, 'GET'), 404);
  const ids = Array.from({ length: 8 }, () => randomUUID());
  for (const sessionId of ids) assert.equal((await lib.app.request(`/api/reader-sessions/${sessionId}`, sessionBody(doc))).status, 200);
  await error(await lib.app.request(`/api/reader-sessions/${randomUUID()}`, sessionBody(doc)), 429);
  assert.equal((await lib.app.request(`/api/reader-sessions/${ids[0]}`, sessionBody(doc, { page: 5 }))).status, 200);
  assert.equal((await lib.app.request(`/api/reader-sessions/${ids[0]}`, undefined, 'DELETE')).status, 200);
  assert.equal((await lib.app.request(`/api/reader-sessions/${ids[0]}`, undefined, 'DELETE')).status, 200);
  assert.equal((await lib.app.request(`/api/reader-sessions/${randomUUID()}`, sessionBody(doc))).status, 200);
});

function pngPreview(padding = 0) {
  function chunk(type, body) {
    const bytes = Buffer.concat([Buffer.from(type), body]);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(body.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, bytes, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const chunks = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header)];
  if (padding) chunks.push(chunk('tEXt', Buffer.concat([Buffer.from('Example\0'), Buffer.alloc(padding, 65)])));
  chunks.push(chunk('IDAT', deflateSync(Buffer.from([0, 50, 100, 200, 255]))), chunk('IEND', Buffer.alloc(0)));
  return `data:image/png;base64,${Buffer.concat(chunks).toString('base64')}`;
}

test('reader inputs and transient PNG previews are validated and do not expand ordinary JSON limits', async t => {
  const { app, dataDir } = await library(t);
  const doc = await app.upload();
  const id = randomUUID(), url = `/api/reader-sessions/${id}`;
  for (const invalid of [
    { documentId: 1 }, { documentId: '../file' }, { page: 0 }, { page: 7 }, { page: '1' },
    { notesDirty: 0 }, { visible: 'true' }, { selection: undefined }, { unexpected: true },
    { selection: { kind: 'unknown', text: '', rects: [rect] } },
    { selection: { kind: 'text', text: '', rects: [rect] } },
    { selection: { kind: 'region', text: 'fabricated', rects: [rect] } },
    { selection: { kind: 'region', text: '', rects: [rect, rect] } },
    { selection: { kind: 'text', text: 'too far', rects: [{ ...rect, x: 0.9 }] } },
  ]) await error(await app.request(url, sessionBody(doc, invalid)));
  for (const invalidId of ['bad', '123', '00000000-0000-0000-0000-000000000000']) {
    await error(await app.request(`/api/reader-sessions/${invalidId}`, sessionBody(doc)));
    await error(await app.request(`/api/reader-context?sessionId=${invalidId}`, undefined, 'GET'));
    await error(await app.request(`/api/reader-sessions/${invalidId}`, undefined, 'DELETE'));
  }
  const png = pngPreview();
  const corruptedBytes = Buffer.from(png.split(',')[1], 'base64');
  corruptedBytes[20] ^= 1;
  const corrupted = `data:image/png;base64,${corruptedBytes.toString('base64')}`;
  for (const preview of [null, 1, 'data:image/jpeg;base64,AAAA', 'data:image/png;base64,AAAA', `${png}a`, corrupted, `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}`]) {
    await error(await app.request(url, sessionBody(doc, { selection: { kind: 'region', text: '', rects: [rect], preview } })));
  }
  const largePreview = pngPreview(1_570_000);
  assert.ok(largePreview.length < 2 * 1024 * 1024);
  const body = sessionBody(doc, { selection: { kind: 'text', text: 'Original text '.repeat(3_000), rects: [rect], preview: largePreview } });
  assert.ok(Buffer.byteLength(JSON.stringify(body)) > 2 * 1024 * 1024);
  assert.equal((await app.request(url, body)).status, 200);
  assert.equal((await app.get(`/api/reader-context?sessionId=${id}`)).selection.preview, largePreview);
  const region = { kind: 'region', text: '', rects: [rect], preview: png };
  assert.equal((await app.request(url, sessionBody(doc, { selection: region }))).status, 200);
  assert.deepEqual((await app.get('/api/reader-context')).selection, region);
  await error(await app.request(`/api/documents/${doc.id}`, { notesZh: 'a'.repeat(2 * 1024 * 1024) }, 'PATCH'), 413);
  await error(await app.request(url, { ...body, selection: { ...body.selection, preview: 'a'.repeat(3 * 1024 * 1024) } }), 413);
  await error(await app.request(url, sessionBody(doc), 'POST', { Origin: 'http://127.0.0.1:9999' }), 403);
  await error(await app.request(url, undefined, 'DELETE', { Origin: 'https://example.com' }), 403);
  const db = new DatabaseSync(path.join(dataDir, 'paperdesk.sqlite'), { readOnly: true });
  try {
    assert.deepEqual(db.prepare('SELECT notes_zh, notes_en FROM documents WHERE id = ?').get(doc.id), { __proto__: null, notes_zh: '', notes_en: '' });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM annotations').get().count, 0);
  } finally { db.close(); }
  assert.deepEqual((await readdir(dataDir)).filter(name => !name.startsWith('paperdesk.sqlite')).sort(), ['pdfs']);
});

test('append preserves legacy notes, refuses dirty/conflicting writes and is idempotent across retries', async t => {
  const lib = await library(t);
  const doc = await lib.app.upload();
  const url = `/api/documents/${doc.id}`, append = `${url}/notes/append`;
  const zh = ' \t## 原有笔记\r\n\n电流 µA 与 **中文**。🧪\n';
  const en = '\n## Evidence\n\n- `gm/ID`\n[Source](https://example.com/)  \n';
  assert.equal((await lib.app.request(url, { notesZh: zh, notesEn: en }, 'PATCH')).status, 200);
  const original = (await lib.app.get(url)).document;
  const request = { text: '新增推理\n\n**exact Markdown**  \n', expectedNotesRevision: original.notesRevision, page: 3, requestId: randomUUID() };
  const sessionId = randomUUID();
  assert.equal((await lib.app.request(`/api/reader-sessions/${sessionId}`, sessionBody(doc, { notesDirty: true, visible: false }))).status, 200);
  const dirty = await error(await lib.app.request(append, request), 409);
  assert.ok(!JSON.stringify(dirty).includes(zh));
  assert.deepEqual((await lib.app.get(url)).document, original);
  assert.equal((await lib.app.request(`/api/reader-sessions/${sessionId}`, sessionBody(doc))).status, 200);
  const results = await Promise.all([lib.app.request(append, request), lib.app.request(append, request)]);
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  const responses = await Promise.all(results.map(result => result.json()));
  assert.deepEqual(responses.map(result => result.appended).sort(), [false, true]);
  const saved = (await lib.app.get(url)).document;
  const expected = `${zh}\n\n---\n\n${en}\n\n### 第 3 页\n\n${request.text}`;
  assert.equal(saved.notesZh, expected);
  assert.equal(saved.notesEn, '');
  assert.equal(saved.notesRevision, revision(expected, ''));
  assert.equal((await lib.app.get('/api/reader-context')).notesRevision, saved.notesRevision);
  const heartbeat = await lib.app.request(`/api/reader-sessions/${sessionId}`, sessionBody(doc));
  assert.equal((await heartbeat.json()).document.notesZh, expected);
  const exported = await (await fetch(`${lib.app.base}${url}/export`)).text();
  assert.ok(exported.includes(expected));
  assert.equal((exported.match(/## 笔记/g) || []).length, 1);
  for (const patch of [{ text: 'different' }, { page: 4 }, { expectedNotesRevision: saved.notesRevision }]) {
    await error(await lib.app.request(append, { ...request, ...patch }), 409);
  }
  await error(await lib.app.request(append, { ...request, requestId: randomUUID() }), 409);
  assert.deepEqual((await lib.app.get(url)).document, saved);
  await error(await lib.app.request(append, { ...request, requestId: randomUUID(), expectedNotesRevision: saved.notesRevision }, 'POST', { Origin: 'https://example.com' }), 403);
  await lib.restart();
  assert.equal((await lib.app.get(url)).document.notesZh, expected);
  await error(await lib.app.request(append, request), 409);
  const current = (await lib.app.get(url)).document;
  const concurrent = await Promise.all(['one', 'two'].map(text => lib.app.request(append, { text, requestId: randomUUID(), expectedNotesRevision: current.notesRevision })));
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409]);
  assert.deepEqual(await readFile(path.join(lib.dataDir, 'pdfs', `${doc.id}.pdf`)), bookmarkedPdf());
});

test('append validation, capacity and expired idempotency records cannot silently rewrite notes', async t => {
  const { app } = await library(t);
  const doc = await app.upload(), other = await app.upload(scanPdf());
  const url = `/api/documents/${doc.id}`, append = `${url}/notes/append`;
  const request = { text: 'First append', expectedNotesRevision: doc.notesRevision, requestId: randomUUID() };
  for (const patch of [
    { text: '' }, { text: '  ' }, { text: null }, { text: 'bad\0text' },
    { expectedNotesRevision: undefined }, { expectedNotesRevision: 'x' }, { requestId: undefined }, { requestId: 'bad' },
    { page: null }, { page: 0 }, { page: 7 }, { page: 1.5 }, { page: '1' }, { unknown: true },
  ]) await error(await app.request(append, { ...request, ...patch }));
  assert.deepEqual((await app.get(url)).document, doc);
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  assert.equal((await app.request(`/api/reader-sessions/${randomUUID()}`, sessionBody(doc, { notesDirty: true, visible: false }))).status, 200);
  await error(await app.request(append, request), 409);
  t.mock.timers.tick(30_000);
  assert.equal((await app.request(`/api/reader-sessions/${randomUUID()}`, sessionBody(other, { page: 1, notesDirty: true }))).status, 200);
  assert.equal((await app.request(append, request)).status, 200);
  await error(await app.request(`/api/documents/${other.id}/notes/append`, request), 409);
  await error(await app.request(append, { ...request, page: null }));
  assert.equal((await (await app.request(append, request)).json()).appended, false);
  t.mock.timers.tick(10 * 60_000);
  await error(await app.request(append, request), 409);
  const nearLimit = '界'.repeat(MAX_NOTE_LENGTH - 3);
  assert.equal((await app.request(url, { notesZh: nearLimit, notesEn: '' }, 'PATCH')).status, 200);
  const fullRequest = { text: 'x', expectedNotesRevision: revision(nearLimit, ''), requestId: randomUUID() };
  const full = await app.request(append, fullRequest);
  assert.equal(full.status, 200);
  const saved = (await full.json()).document;
  assert.equal(saved.notesZh.length, MAX_NOTE_LENGTH);
  await error(await app.request(append, { text: 'y', expectedNotesRevision: saved.notesRevision, requestId: randomUUID() }));
  assert.deepEqual((await app.get(url)).document, saved);
});
