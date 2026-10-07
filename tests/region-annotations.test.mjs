import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';

function scanPdf() {
  const stream = 'q\n0.8 g 50 50 300 500 re f\n0.2 g 80 470 200 40 re f\nQ\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function start(dataDir) {
  const runtime = createApp({ dataDir });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    async request(path, { method = 'GET', body, headers = {} } = {}) {
      return fetch(`${base}${path}`, { method, headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    },
    async upload(bytes) {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'original-scan.pdf');
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

async function expectError(response, status = 400) {
  assert.equal(response.status, status);
  const result = await response.json();
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0);
}

test('a text-free PDF accepts a region and preserves its kind and geometry through editing, export and restart', async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), 'paperdesk-region-'));
  const dataDir = join(tempDir, '.local', 'data');
  let app = await start(dataDir);
  t.after(async () => { await app.close(); await rm(tempDir, { recursive: true, force: true }); });
  const source = scanPdf();
  const doc = await app.upload(source);
  assert.equal(doc.textAvailable, false);
  const endpoint = `/api/documents/${doc.id}/annotations`;
  const rects = [{ x: 0.13, y: 0.19, width: 0.41, height: 0.22 }];
  let response = await app.request(endpoint, { method: 'POST', body: { kind: 'region', page: 1, color: 'yellow', rects } });
  assert.equal(response.status, 201);
  const region = (await response.json()).annotation;
  assert.equal(region.kind, 'region');
  assert.equal(region.quote, '');
  assert.equal(region.comment, '');
  assert.deepEqual(region.rects, rects);
  const comment = '区域证据：核对图片中的示意图，未提取原文。';
  response = await app.request(`${endpoint}/${region.id}`, { method: 'PATCH', body: { comment, color: 'green' } });
  assert.equal(response.status, 200);
  const edited = (await response.json()).annotation;
  assert.equal(edited.kind, 'region');
  assert.equal(edited.quote, '');
  assert.equal(edited.comment, comment);
  assert.equal(edited.color, 'green');
  assert.deepEqual(edited.rects, rects);
  assert.equal(edited.createdAt, region.createdAt);
  const search = await (await app.request(`/api/search?q=${encodeURIComponent('区域证据')}`)).json();
  assert.ok(search.results.some(result => result.documentId === doc.id && result.page === 1 && result.source === 'annotation'));
  const markdown = await (await app.request(`/api/documents/${doc.id}/export`)).text();
  assert.match(markdown, /第 1 页 · 区域批注 · green/);
  assert.ok(markdown.includes('x=0.13, y=0.19, width=0.41, height=0.22'));
  assert.ok(markdown.includes(comment));
  assert.ok(!/^>/m.test(markdown), 'A region must not be exported as a fabricated quotation');
  assert.ok(!/!\[[^\]]*\]\(/.test(markdown), 'Region export does not persist screenshots');

  await app.close();
  app = await start(dataDir);
  const restored = (await (await app.request(`/api/documents/${doc.id}`)).json()).annotations;
  assert.deepEqual(restored, [edited]);
  assert.deepEqual(Buffer.from(await (await app.request(`/api/documents/${doc.id}/file`)).arrayBuffer()), source);
  assert.deepEqual(await readFile(join(dataDir, 'pdfs', `${doc.id}.pdf`)), source);
  assert.deepEqual((await readdir(join(dataDir, 'pdfs'))).sort(), ['.incoming', `${doc.id}.pdf`].sort());
  assert.deepEqual(await readdir(join(dataDir, 'pdfs', '.incoming')), []);

  await t.test('region geometry is immutable through PATCH and origin validation still applies', async () => {
    for (const body of [{ kind: 'text' }, { quote: 'invented quote' }, { page: 1 }, { rects }]) {
      await expectError(await app.request(`${endpoint}/${region.id}`, { method: 'PATCH', body }));
    }
    await expectError(await app.request(`${endpoint}/${region.id}`, { method: 'PATCH', body: { comment: 'foreign write' }, headers: { Origin: 'https://example.com' } }), 403);
    assert.deepEqual((await (await app.request(`/api/documents/${doc.id}`)).json()).annotations, [edited]);
  });
  await t.test('region comment can be cleared and deleting a region does not alter the PDF', async () => {
    const cleared = await (await app.request(`${endpoint}/${region.id}`, { method: 'PATCH', body: { comment: '' } })).json();
    assert.equal(cleared.annotation.comment, '');
    assert.equal(cleared.annotation.kind, 'region');
    assert.deepEqual((await (await app.request(`/api/search?q=${encodeURIComponent('区域证据')}`)).json()).results, []);
    assert.equal((await app.request(`${endpoint}/${region.id}`, { method: 'DELETE' })).status, 200);
    assert.deepEqual((await (await app.request(`/api/documents/${doc.id}`)).json()).annotations, []);
    assert.deepEqual(await readFile(join(dataDir, 'pdfs', `${doc.id}.pdf`)), source);
  });
});

test('kind, quote and one-rectangle validation cannot create ambiguous region annotations', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'paperdesk-region-validation-'));
  const app = await start(dataDir);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const doc = await app.upload(scanPdf());
  const endpoint = `/api/documents/${doc.id}/annotations`;
  const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
  const valid = { kind: 'region', page: 1, color: 'yellow', rects: [rect], quote: '' };
  for (const patch of [
    { kind: 'scan' }, { kind: null }, { kind: 0 }, { kind: '' },
    { quote: 'This is not extracted text' }, { quote: ' ' }, { quote: null }, { quote: 1 },
    { rects: [] }, { rects: [rect, rect] }, { rects: null },
    { rects: [{ ...rect, x: -0.1 }] }, { rects: [{ ...rect, x: 0.9 }] },
    { rects: [{ ...rect, width: 0 }] }, { rects: [{ ...rect, height: -0.1 }] },
    { rects: [{ ...rect, y: 0.8 }] }, { rects: [{ ...rect, x: null }] },
    { rects: [{ ...rect, x: '0.1' }] }, { rects: [{ ...rect, extra: 1 }] },
    { page: 0 }, { page: 2 }, { color: 'blue' }, { comment: null },
  ]) await expectError(await app.request(endpoint, { method: 'POST', body: { ...valid, ...patch } }));
  const { kind: omittedKind, ...withoutKind } = valid;
  await expectError(await app.request(endpoint, { method: 'POST', body: withoutKind }));
  await expectError(await app.request(endpoint, { method: 'POST', body: { ...valid, kind: 'text' } }));
  assert.deepEqual((await (await app.request(`/api/documents/${doc.id}`)).json()).annotations, []);
  const explicitEmpty = await app.request(endpoint, { method: 'POST', body: valid });
  assert.equal(explicitEmpty.status, 201);
  assert.equal((await explicitEmpty.json()).annotation.kind, 'region');
  const legacy = await app.request(endpoint, { method: 'POST', body: { page: 1, quote: 'Existing text client', comment: '', color: 'pink', rects: [rect, { x: 0.5, y: 0.6, width: 0.2, height: 0.1 }] } });
  assert.equal(legacy.status, 201);
  const text = (await legacy.json()).annotation;
  assert.equal(text.kind, 'text');
  assert.equal(text.quote, 'Existing text client');
  assert.equal(text.rects.length, 2);
});

function databaseSnapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      version: db.prepare('PRAGMA user_version').get().user_version,
      documents: db.prepare('SELECT * FROM documents ORDER BY id').all().map(row => ({ ...row })),
      pages: db.prepare('SELECT * FROM pages ORDER BY document_id, page').all().map(row => ({ ...row })),
      annotations: db.prepare('SELECT * FROM annotations ORDER BY id').all().map(row => ({ ...row })),
      columns: db.prepare('PRAGMA table_info(annotations)').all(),
      integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
    };
  } finally { db.close(); }
}

test('v1 migration preserves complete old records and original bytes, is idempotent, and defaults old-client annotations to text', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'paperdesk-region-v1-'));
  let app;
  t.after(async () => { await app?.close(); await rm(dataDir, { recursive: true, force: true }); });
  const file = join(dataDir, 'paperdesk.sqlite');
  const docId = randomUUID(), annotationId = randomUUID();
  const source = await readFile(new URL('../public/examples/reading-demo.pdf', import.meta.url));
  await mkdir(join(dataDir, 'pdfs'));
  await writeFile(join(dataDir, 'pdfs', `${docId}.pdf`), source);
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      filename TEXT NOT NULL, page_count INTEGER NOT NULL, byte_size INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, text_available INTEGER NOT NULL,
      notes_zh TEXT NOT NULL DEFAULT '', notes_en TEXT NOT NULL DEFAULT '', last_page INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE pages (document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, page INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(document_id,page));
    CREATE TABLE annotations (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      page INTEGER NOT NULL, quote TEXT NOT NULL, comment TEXT NOT NULL, color TEXT NOT NULL,
      rects TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    PRAGMA user_version = 1;
  `);
  old.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(docId, createHash('sha256').update(source).digest('hex'), 'Old title', 'old.pdf', 2, source.length, '2025-01-01', '2025-02-02', 1, '原有中文笔记', 'Original English note', 2);
  old.prepare('INSERT INTO pages VALUES (?,?,?)').run(docId, 1, 'Legacy indexed text');
  const rawRects = '[{ "x": 0.14, "y": 0.37, "width": 0.3, "height": 0.021 }]';
  old.prepare('INSERT INTO annotations VALUES (?,?,?,?,?,?,?,?,?)').run(annotationId, docId, 2, 'An exact old quote\n保留换行', 'Old comment', 'green', rawRects, '2025-01-01', '2025-02-02');
  old.close();
  const before = databaseSnapshot(file);
  app = await start(dataDir);
  const migrated = databaseSnapshot(file);
  assert.equal(migrated.version, 3);
  assert.equal(migrated.integrity, 'ok');
  assert.deepEqual(migrated.documents, before.documents.map(row => ({ ...row, folder_id: null })));
  assert.deepEqual(migrated.pages, before.pages);
  assert.deepEqual(migrated.annotations.map(({ kind, ...row }) => row), before.annotations);
  assert.equal(migrated.annotations[0].kind, 'text');
  assert.equal(migrated.annotations[0].rects, rawRects);
  const kindColumn = migrated.columns.filter(column => column.name === 'kind');
  assert.equal(kindColumn.length, 1);
  assert.equal(kindColumn[0].notnull, 1);
  assert.equal(kindColumn[0].dflt_value, "'text'");
  assert.deepEqual(await readFile(join(dataDir, 'pdfs', `${docId}.pdf`)), source);
  const restored = await (await app.request(`/api/documents/${docId}`)).json();
  assert.equal(restored.annotations[0].kind, 'text');
  assert.equal(restored.annotations[0].quote, before.annotations[0].quote);
  assert.deepEqual(restored.annotations[0].rects, JSON.parse(rawRects));
  const markdown = await (await app.request(`/api/documents/${docId}/export`)).text();
  assert.ok(markdown.includes('> An exact old quote\n> 保留换行'));
  assert.ok(!markdown.includes('区域批注'));
  await app.close();
  app = await start(dataDir);
  assert.deepEqual(databaseSnapshot(file), migrated, 'Opening the current schema again must not rewrite prior content or duplicate columns');
  const created = await app.request(`/api/documents/${docId}/annotations`, { method: 'POST', body: { page: 2, quote: 'Old client remains compatible', comment: '', color: 'yellow', rects: JSON.parse(rawRects) } });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).annotation.kind, 'text');
});

test('schema migration rollback and future-version refusal leave versioned data intact', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'paperdesk-region-migration-safety-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const brokenDir = join(temp, 'broken');
  await mkdir(brokenDir);
  const brokenFile = join(brokenDir, 'paperdesk.sqlite');
  let db = new DatabaseSync(brokenFile);
  db.exec("CREATE TABLE annotations (id TEXT PRIMARY KEY); INSERT INTO annotations VALUES ('preserve-me'); PRAGMA user_version = 1;");
  const originalSchema = db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();
  db.close();
  assert.throws(() => createApp({ dataDir: brokenDir }), /column/i);
  db = new DatabaseSync(brokenFile);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.deepEqual(db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(), originalSchema);
  assert.equal(db.prepare('SELECT id FROM annotations').get().id, 'preserve-me');
  db.exec('BEGIN IMMEDIATE; ROLLBACK;'); // Failed initialization must release its lock.
  db.close();

  const futureDir = join(temp, 'future');
  await mkdir(futureDir);
  const futureFile = join(futureDir, 'paperdesk.sqlite');
  db = new DatabaseSync(futureFile);
  db.exec("CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('keep'); PRAGMA user_version = 4;");
  db.close();
  assert.throws(() => createApp({ dataDir: futureDir }), /更新版本/);
  db = new DatabaseSync(futureFile, { readOnly: true });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
  assert.equal(db.prepare('SELECT value FROM future_data').get().value, 'keep');
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name), ['future_data']);
  db.close();
});
