import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { CURRENT_SCHEMA } from '../shared/library.mjs';

const sample = await readFile(new URL('../public/examples/reading-demo.pdf', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function serve(dataDir) {
  const runtime = createApp({ dataDir });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    async request(route, method = 'GET', body, headers = {}) {
      return fetch(base + route, { method, headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    },
    async json(route, method = 'GET', body, expected = 200) {
      const response = await this.request(route, method, body);
      assert.equal(response.status, expected, route);
      return response.json();
    },
    async upload(bytes = sample) {
      const form = new FormData(); form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'original-library-fixture.pdf');
      const response = await fetch(base + '/api/documents', { method: 'POST', body: form });
      assert.equal(response.status, 201); return (await response.json()).document;
    },
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await runtime.close();
    },
  };
}
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'paperdesk-library-'));
  let app = await serve(dataDir);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, get app() { return app; }, async restart() { await app.close(); app = await serve(dataDir); } };
}
async function rejected(response, status = 400) {
  assert.equal(response.status, status);
  assert.equal(typeof (await response.json()).error, 'string');
}
function snapshot(dataDir) {
  const db = new DatabaseSync(join(dataDir, 'paperdesk.sqlite'), { readOnly: true });
  try {
    return {
      version: db.prepare('PRAGMA user_version').get().user_version,
      schema: db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all(),
      documents: db.prepare('SELECT * FROM documents ORDER BY id').all().map(row => ({ ...row })),
      pages: db.prepare('SELECT * FROM pages ORDER BY document_id, page').all(),
      annotations: db.prepare('SELECT * FROM annotations ORDER BY id').all(),
    };
  } finally { db.close(); }
}

test('folder CRUD, reassignment, theme and counts persist; deleting folders never deletes reading content', async t => {
  const lib = await fixture(t), first = await lib.app.upload();
  const second = await lib.app.upload(Buffer.concat([sample, Buffer.from('\n% second original test fixture\n')]));
  assert.equal(first.folderId, null); assert.equal(second.folderId, null);
  assert.deepEqual(await lib.app.json('/api/library'), { folders: [], theme: 'forest' });
  const create = name => lib.app.json('/api/folders', 'POST', { name }, 201);
  const { folder: research } = await create('  Ｒｅｓｅａｒｃｈ  ');
  const { folder: circuits } = await create('电路');
  assert.equal(research.name, 'Ｒｅｓｅａｒｃｈ'); assert.equal(research.documentCount, 0);
  assert.ok(research.createdAt); assert.equal(research.createdAt, research.updatedAt);
  await rejected(await lib.app.request('/api/folders', 'POST', { name: 'research' }), 409);
  await rejected(await lib.app.request('/api/folders/' + circuits.id, 'PATCH', { name: 'RESEARCH' }), 409);
  const rename = await lib.app.json('/api/folders/' + research.id, 'PATCH', { name: 'Research' });
  assert.equal(rename.folder.name, 'Research'); assert.equal(rename.folder.createdAt, research.createdAt);
  const notes = await lib.app.json('/api/documents/' + first.id, 'PATCH', { notesZh: '原始笔记 **保留**', notesEn: 'Evidence', lastPage: 2, expectedNotesRevision: first.notesRevision });
  await lib.app.json(`/api/documents/${first.id}/annotations`, 'POST', { page: 1, quote: 'Preserved original quote', comment: 'Keep annotation', color: 'yellow', rects: [{ x: 0.1, y: 0.2, width: 0.2, height: 0.04 }] }, 201);
  for (const document of [first, second]) {
    const result = await lib.app.json(`/api/documents/${document.id}/folder`, 'PATCH', { folderId: research.id });
    assert.equal(result.document.folderId, research.id);
  }
  assert.equal((await lib.app.json('/api/library')).folders.find(folder => folder.id === research.id).documentCount, 2);
  await lib.app.json(`/api/documents/${second.id}/folder`, 'PATCH', { folderId: circuits.id });
  assert.deepEqual((await lib.app.json('/api/library')).folders.map(folder => folder.documentCount), [1, 1]);
  for (const theme of ['sand', 'slate', 'night']) assert.deepEqual(await lib.app.json('/api/library/theme', 'PATCH', { theme }), { theme });
  await lib.restart();
  const loaded = await lib.app.json('/api/documents/' + first.id);
  assert.equal(loaded.document.folderId, research.id);
  assert.equal(loaded.document.notesRevision, notes.document.notesRevision);
  assert.equal((await lib.app.json('/api/library')).theme, 'night');
  assert.equal((await lib.app.json('/api/documents')).documents.find(doc => doc.id === second.id).folderId, circuits.id);
  const before = snapshot(lib.dataDir);
  assert.deepEqual(await lib.app.json('/api/folders/' + research.id, 'DELETE'), { ok: true });
  const after = snapshot(lib.dataDir);
  assert.deepEqual(after.documents, before.documents.map(row => row.id === first.id ? { ...row, folder_id: null } : row));
  assert.deepEqual(after.pages, before.pages); assert.deepEqual(after.annotations, before.annotations);
  assert.equal(after.version, CURRENT_SCHEMA);
  assert.deepEqual(await readFile(join(lib.dataDir, 'pdfs', first.id + '.pdf')), sample);
  const bytes = await (await lib.app.request(`/api/documents/${first.id}/file`)).arrayBuffer();
  assert.equal(hash(Buffer.from(bytes)), hash(sample));
  const exported = await (await lib.app.request(`/api/documents/${first.id}/export`)).text();
  assert.ok(exported.includes('原始笔记 **保留**')); assert.ok(exported.includes('Preserved original quote'));
  await lib.app.json(`/api/documents/${second.id}/folder`, 'PATCH', { folderId: null });
  assert.equal((await lib.app.json('/api/library')).folders[0].documentCount, 0);
  await rejected(await lib.app.request('/api/folders/' + research.id, 'DELETE'), 404);
});

test('strict folder/theme inputs and local-origin rules reject unsafe changes without side effects', async t => {
  const lib = await fixture(t), doc = await lib.app.upload();
  const { folder } = await lib.app.json('/api/folders', 'POST', { name: 'a'.repeat(80) }, 201);
  const invalidNames = ['', '   ', 'a'.repeat(81), '\nHeading', 'a\u0000b', 'a\u007fb', 'a\u202Eb', 3, null];
  for (const name of invalidNames) await rejected(await lib.app.request('/api/folders', 'POST', { name }));
  for (const body of [{}, { name: 'Safe', parentId: folder.id }, [], { name: 'Safe', id: randomUUID() }]) await rejected(await lib.app.request('/api/folders', 'POST', body));
  for (const body of [{}, { theme: 'system' }, { theme: null }, { theme: 'forest', notesZh: 'must not write' }]) await rejected(await lib.app.request('/api/library/theme', 'PATCH', body));
  for (const body of [{}, { folderId: '' }, { folderId: '../pdfs' }, { folderId: 0 }, { folderId: null, notesZh: 'must not write' }]) await rejected(await lib.app.request(`/api/documents/${doc.id}/folder`, 'PATCH', body));
  await rejected(await lib.app.request('/api/documents/not-a-uuid/folder', 'PATCH', { folderId: null }));
  await rejected(await lib.app.request('/api/folders/not-a-uuid', 'PATCH', { name: 'Safe' }));
  await rejected(await lib.app.request('/api/folders/not-a-uuid', 'DELETE'));
  await rejected(await lib.app.request('/api/folders/' + randomUUID(), 'PATCH', { name: 'Safe' }), 404);
  await rejected(await lib.app.request(`/api/documents/${doc.id}/folder`, 'PATCH', { folderId: randomUUID() }), 404);
  await rejected(await lib.app.request(`/api/documents/${randomUUID()}/folder`, 'PATCH', { folderId: folder.id }), 404);
  await rejected(await lib.app.request('/api/folders/' + folder.id, 'DELETE', { recursive: true }));
  const operations = [
    ['/api/library', 'GET'], ['/api/folders', 'POST', { name: 'Untrusted' }],
    ['/api/folders/' + folder.id, 'PATCH', { name: 'Untrusted' }], ['/api/folders/' + folder.id, 'DELETE'],
    [`/api/documents/${doc.id}/folder`, 'PATCH', { folderId: folder.id }], ['/api/library/theme', 'PATCH', { theme: 'night' }],
  ];
  for (const [url, method, body] of operations) {
    await rejected(await lib.app.request(url, method, body, { Origin: 'https://untrusted.example' }), 403);
    await rejected(await lib.app.request(url, method, body, { Origin: 'null' }), 403);
  }
  const library = await lib.app.json('/api/library');
  assert.equal(library.theme, 'forest'); assert.deepEqual(library.folders, [folder]);
  assert.deepEqual((await lib.app.json('/api/documents/' + doc.id)).document, doc);
});

test('moving a document and saving a note are independent, including overlapping requests and stale note conflicts', async t => {
  const lib = await fixture(t), doc = await lib.app.upload();
  const { folder } = await lib.app.json('/api/folders', 'POST', { name: 'Concurrent reading' }, 201);
  const url = '/api/documents/' + doc.id;
  const [save, move] = await Promise.all([
    lib.app.request(url, 'PATCH', { notesZh: 'Saved concurrent draft', expectedNotesRevision: doc.notesRevision }),
    lib.app.request(url + '/folder', 'PATCH', { folderId: folder.id }),
  ]);
  assert.equal(save.status, 200); assert.equal(move.status, 200);
  const current = (await lib.app.json(url)).document;
  assert.equal(current.notesZh, 'Saved concurrent draft'); assert.equal(current.folderId, folder.id);
  const moved = (await lib.app.json(url + '/folder', 'PATCH', { folderId: null })).document;
  assert.equal(moved.notesRevision, current.notesRevision);
  assert.equal(moved.notesZh, current.notesZh);
  const [stale, reassign] = await Promise.all([
    lib.app.request(url, 'PATCH', { notesZh: 'Stale must never win', expectedNotesRevision: doc.notesRevision }),
    lib.app.request(url + '/folder', 'PATCH', { folderId: folder.id }),
  ]);
  await rejected(stale, 409); assert.equal(reassign.status, 200);
  assert.equal((await lib.app.json(url)).document.notesZh, current.notesZh);
  assert.equal((await lib.app.json(url)).document.folderId, folder.id);
});

async function legacyLibrary(dataDir) {
  await mkdir(join(dataDir, 'pdfs'), { recursive: true });
  const id = randomUUID(), file = join(dataDir, 'paperdesk.sqlite');
  await writeFile(join(dataDir, 'pdfs', id + '.pdf'), sample);
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE documents (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      filename TEXT NOT NULL, page_count INTEGER NOT NULL, byte_size INTEGER NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, text_available INTEGER NOT NULL, notes_zh TEXT NOT NULL DEFAULT '', notes_en TEXT NOT NULL DEFAULT '', last_page INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE pages (document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, page INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(document_id,page));
    CREATE TABLE annotations (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      page INTEGER NOT NULL, quote TEXT NOT NULL, comment TEXT NOT NULL, color TEXT NOT NULL, rects TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','region')));
    CREATE INDEX annotations_document ON annotations(document_id,page);
    PRAGMA user_version = 2;
  `);
  db.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id, hash(sample), 'Legacy document', 'original.pdf', 2, sample.length, '2025-01-01', '2025-02-02', 1, ' \t**旧笔记**\n', '\nOriginal English Ω🧪', 2);
  db.prepare('INSERT INTO pages VALUES (?,?,?)').run(id, 1, 'Original indexed text\n第二行');
  for (const kind of ['text', 'region']) db.prepare('INSERT INTO annotations VALUES (?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), id, 2, kind === 'text' ? 'exact old quote\n原文' : '', 'Existing comment', 'green', '[{ "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.1 }]', '2025-01-01', '2025-02-02', kind);
  db.close(); return id;
}

test('schema 2 migration retains every legacy field, PDF byte and note revision, and is idempotent', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'paperdesk-library-v2-'));
  let app;
  t.after(async () => { await app?.close(); await rm(dataDir, { recursive: true, force: true }); });
  const id = await legacyLibrary(dataDir), before = snapshot(dataDir);
  app = await serve(dataDir);
  const after = snapshot(dataDir);
  assert.equal(after.version, CURRENT_SCHEMA);
  assert.deepEqual(after.documents.map(({ folder_id, ...row }) => row), before.documents.map(row => ({ ...row })));
  assert.equal(after.documents[0].folder_id, null);
  assert.deepEqual(after.pages, before.pages); assert.deepEqual(after.annotations, before.annotations);
  const current = (await app.json('/api/documents/' + id)).document;
  assert.equal(current.notesRevision, hash(JSON.stringify([before.documents[0].notes_zh, before.documents[0].notes_en])));
  assert.equal(current.lastPage, 2); assert.equal(current.folderId, null);
  assert.deepEqual(await app.json('/api/library'), { folders: [], theme: 'forest' });
  assert.deepEqual(await readFile(join(dataDir, 'pdfs', id + '.pdf')), sample);
  const check = new DatabaseSync(join(dataDir, 'paperdesk.sqlite'), { readOnly: true });
  try {
    assert.equal(check.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(), []);
    const foreign = check.prepare('PRAGMA foreign_key_list(documents)').all().find(key => key.from === 'folder_id');
    assert.equal(foreign.table, 'folders'); assert.equal(foreign.on_delete, 'SET NULL');
  } finally { check.close(); }
  await app.close(); app = await serve(dataDir);
  assert.deepEqual(snapshot(dataDir), after);
});

test('failed schema 3 migration rolls back its columns/tables and a future schema is never downgraded', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'paperdesk-library-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const broken = join(directory, 'broken');
  const id = await legacyLibrary(broken);
  let db = new DatabaseSync(join(broken, 'paperdesk.sqlite'));
  db.exec('CREATE TABLE library_preferences (id INTEGER PRIMARY KEY, incompatible TEXT);'); db.close();
  const before = snapshot(broken);
  assert.throws(() => createApp({ dataDir: broken }), /theme/i);
  assert.deepEqual(snapshot(broken), before);
  assert.deepEqual(await readFile(join(broken, 'pdfs', id + '.pdf')), sample);
  db = new DatabaseSync(join(broken, 'paperdesk.sqlite'));
  db.exec('BEGIN IMMEDIATE; ROLLBACK;'); db.close();
  const future = join(directory, 'future');
  await mkdir(future);
  db = new DatabaseSync(join(future, 'paperdesk.sqlite'));
  db.exec(`CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('preserve'); PRAGMA user_version = ${CURRENT_SCHEMA + 1};`);
  const schema = db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(); db.close();
  assert.throws(() => createApp({ dataDir: future }), /更新版本/);
  db = new DatabaseSync(join(future, 'paperdesk.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, CURRENT_SCHEMA + 1);
    assert.deepEqual(db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(), schema);
    assert.equal(db.prepare('SELECT value FROM future_data').get().value, 'preserve');
  } finally { db.close(); }
});
