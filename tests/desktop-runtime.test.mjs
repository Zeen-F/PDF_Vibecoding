import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import fsPromises from 'node:fs/promises';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server/app.mjs';
import { CURRENT_SCHEMA } from '../shared/library.mjs';
import { LAUNCHER_PROTOCOL, PRODUCT_VERSION, SERVICE_API_VERSION } from '../shared/service-identity.mjs';
import { startDesktopRuntime, validateExistingLibrary, validateVaultNoteUri } from '../desktop/runtime.mjs';
import { getVaultConfig } from '../server/vault-config.mjs';

const sample = await readFile(new URL('../public/examples/reading-demo.pdf', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'paperdesk-desktop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function serverAtRandomPort(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((done, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : done());
  }));
  return { server, baseUrl, port: server.address().port };
}

async function json(baseUrl, endpoint, { method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + endpoint, {
    method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(response.ok, `${method} ${endpoint}: ${response.status}`);
  return response.json();
}

async function importSample(baseUrl) {
  const body = new FormData();
  body.append('file', new Blob([sample], { type: 'application/pdf' }), '阅读示例.pdf');
  const response = await fetch(baseUrl + '/api/documents', { method: 'POST', body });
  assert.equal(response.status, 201);
  return (await response.json()).document;
}

async function snapshot(directory) {
  const result = {};
  async function visit(location, prefix = '') {
    for (const name of (await readdir(location)).sort()) {
      const filename = join(location, name), relative = prefix + name;
      const info = await lstat(filename);
      result[relative] = info.isDirectory() ? 'directory' : hash(await readFile(filename));
      if (info.isDirectory()) await visit(filename, relative + '/');
    }
  }
  await visit(directory);
  return result;
}

test('desktop reuses only the exact healthy running library and does not own its shutdown', async t => {
  const dataDir = await temporaryDirectory(t);
  const application = createApp({ dataDir });
  const existing = await serverAtRandomPort(t, application.app);
  t.after(() => application.close());
  const runtime = await startDesktopRuntime({ dataDir: join(dataDir, '.'), preferredPort: existing.port });
  assert.equal(runtime.owned, false);
  assert.equal(runtime.baseUrl, existing.baseUrl);
  assert.equal(runtime.dataDir, resolve(dataDir));
  await runtime.close();
  await runtime.close();
  assert.deepEqual(await json(existing.baseUrl, '/api/health'), { ok: true });
  assert.equal((await json(existing.baseUrl, '/api/plugin/status')).libraryId, hash(resolve(dataDir)));
});

test('different libraries and incompatible or unhealthy services survive desktop fallback', async t => {
  const directory = await temporaryDirectory(t);
  const missing = Symbol('missing');
  for (const [index, mismatch] of [
    { name: 'different service', status: { service: 'other' } },
    { name: 'wrong API version', status: { apiVersion: SERVICE_API_VERSION + 1 } },
    { name: 'missing API version', status: { apiVersion: missing } },
    { name: 'wrong product version', status: { productVersion: `${PRODUCT_VERSION}-other` } },
    { name: 'missing product version', status: { productVersion: missing } },
    { name: 'wrong launcher protocol', status: { launcherProtocol: LAUNCHER_PROTOCOL + 1 } },
    { name: 'missing launcher protocol', status: { launcherProtocol: missing } },
    { name: 'different library', status: { libraryId: 'b'.repeat(64) } },
    { name: 'unhealthy service', healthy: false },
  ].entries()) {
    await t.test(mismatch.name, async t => {
      const dataDir = join(directory, String(index));
      const status = {
        service: 'paperdesk', apiVersion: SERVICE_API_VERSION, libraryId: hash(resolve(dataDir)),
        productVersion: PRODUCT_VERSION, launcherProtocol: LAUNCHER_PROTOCOL,
      };
      for (const [key, value] of Object.entries(mismatch.status ?? {})) {
        if (value === missing) delete status[key];
        else status[key] = value;
      }
      const existing = await serverAtRandomPort(t, (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(request.url === '/api/plugin/status' ? status : { ok: mismatch.healthy !== false }));
      });
      const runtime = await startDesktopRuntime({ dataDir, preferredPort: existing.port });
      t.after(() => runtime.close());
      assert.equal(runtime.owned, true);
      assert.notEqual(runtime.baseUrl, existing.baseUrl);
      assert.deepEqual(await json(runtime.baseUrl, '/api/health'), { ok: true });
      await runtime.close();
      assert.deepEqual(await json(existing.baseUrl, '/api/plugin/status'), status);
    });
  }
});

test('desktop drains an accepted note save before shutdown and reads all persisted data after restart', async t => {
  const dataDir = await temporaryDirectory(t);
  let runtime = await startDesktopRuntime({ dataDir, preferredPort: 0 });
  t.after(() => runtime.close());
  const preferredPort = Number(new URL(runtime.baseUrl).port);
  const document = await importSample(runtime.baseUrl);
  const { annotation } = await json(runtime.baseUrl, `/api/documents/${document.id}/annotations`, {
    method: 'POST', body: { page: 2, quote: 'phase margin', comment: '保留的批注', color: 'green', rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.1 }] },
  });
  const body = JSON.stringify({ notesZh: '退出时继续完成的笔记 Ω', notesEn: '', lastPage: 2, expectedNotesRevision: document.notesRevision });
  const request = httpRequest(runtime.baseUrl + `/api/documents/${document.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  });
  const reply = new Promise((done, reject) => {
    request.once('error', reject);
    request.once('response', response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.once('end', () => done({ status: response.statusCode, body: JSON.parse(text) }));
    });
  });
  request.write(body.slice(0, 12));
  const socket = request.socket || await once(request, 'socket').then(([socket]) => socket);
  if (socket.connecting) await once(socket, 'connect');
  // Send a partial body to keep this accepted save active while close() starts.
  await new Promise(done => setTimeout(done, 40));
  const closing = runtime.close();
  assert.equal(runtime.close(), closing, 'close is idempotent while draining');
  request.end(body.slice(12));
  const saved = await reply;
  assert.equal(saved.status, 200);
  assert.equal(saved.body.document.notesZh, '退出时继续完成的笔记 Ω');
  await closing;
  await assert.rejects(fetch(runtime.baseUrl + '/api/health'));
  runtime = await startDesktopRuntime({ dataDir, preferredPort });
  assert.equal(runtime.owned, true);
  assert.equal(Number(new URL(runtime.baseUrl).port), preferredPort);
  const restored = await json(runtime.baseUrl, `/api/documents/${document.id}`);
  assert.equal(restored.document.notesZh, saved.body.document.notesZh);
  assert.equal(restored.document.notesRevision, saved.body.document.notesRevision);
  assert.equal(restored.document.lastPage, 2);
  assert.equal(restored.annotations[0].id, annotation.id);
  assert.deepEqual(await readFile(join(dataDir, 'pdfs', document.id + '.pdf')), sample);
});

test('desktop bounds stalled active connections during shutdown', async t => {
  const dataDir = await temporaryDirectory(t);
  const runtime = await startDesktopRuntime({ dataDir, preferredPort: 0 });
  t.after(() => runtime.close());
  const socket = connect(Number(new URL(runtime.baseUrl).port), '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write('POST /api/documents HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100000\r\n\r\n');
  socket.on('error', () => {});
  await new Promise(done => setTimeout(done, 40));
  const before = performance.now();
  await runtime.close();
  const elapsed = performance.now() - before;
  assert.ok(elapsed >= 4500 && elapsed < 8000, `stalled request was bounded: ${elapsed}ms`);
});

test('an admitted import finishes safely when slow disk work outlives forced HTTP disconnection', async t => {
  const dataDir = await temporaryDirectory(t);
  let runtime = await startDesktopRuntime({ dataDir, preferredPort: 0 });
  const originalRename = fsPromises.rename;
  let releaseDisk;
  let importReachedDisk;
  const diskBlocked = new Promise(done => { releaseDisk = done; });
  const diskReached = new Promise(done => { importReachedDisk = done; });
  // A controlled disk stall exercises the real PDF parser, commit and restart
  // without requiring a huge fixture or depending on machine processing speed.
  const renameMock = t.mock.method(fsPromises, 'rename', async (source, destination) => {
    if (source.startsWith(join(dataDir, 'pdfs', '.incoming'))) {
      importReachedDisk();
      await diskBlocked;
    }
    return originalRename(source, destination);
  });
  syncBuiltinESMExports();
  t.after(async () => {
    releaseDisk();
    await runtime.close();
    renameMock.mock.restore();
    syncBuiltinESMExports();
  });
  const body = new FormData();
  body.append('file', new Blob([sample], { type: 'application/pdf' }), '阅读示例.pdf');
  const uploadOutcome = fetch(runtime.baseUrl + '/api/documents', { method: 'POST', body })
    .then(response => ({ response }), error => ({ error }));
  await diskReached;
  let closed = false;
  const closing = runtime.close();
  void closing.then(() => { closed = true; });
  const outcome = await uploadOutcome;
  assert.ok(outcome.error, 'the five-second HTTP deadline disconnects this stalled upload');
  await new Promise(done => setImmediate(done));
  assert.equal(closed, false, 'the database must stay open for the admitted import after disconnection');
  releaseDisk();
  await closing;
  runtime = await startDesktopRuntime({ dataDir, preferredPort: 0 });
  const { documents } = await json(runtime.baseUrl, '/api/documents');
  assert.equal(documents.length, 1);
  assert.equal(documents[0].byteSize, sample.length);
  assert.deepEqual(await readFile(join(dataDir, 'pdfs', documents[0].id + '.pdf')), sample);
  assert.deepEqual(await readdir(join(dataDir, 'pdfs', '.incoming')), []);
});

test('existing-library inspection checks original PDFs and leaves a stopped WAL-mode library unchanged', async t => {
  const dataDir = await temporaryDirectory(t);
  const runtime = await startDesktopRuntime({ dataDir, preferredPort: 0 });
  const document = await importSample(runtime.baseUrl);
  await runtime.close();
  const before = await snapshot(dataDir);
  const result = await validateExistingLibrary(dataDir);
  assert.deepEqual(result, {
    dataDir: resolve(dataDir), libraryId: hash(resolve(dataDir)), schemaVersion: CURRENT_SCHEMA,
    documentCount: 1, byteSize: sample.length,
  });
  assert.deepEqual(await snapshot(dataDir), before);
  assert.deepEqual(await readFile(join(dataDir, 'pdfs', document.id + '.pdf')), sample);
});

test('desktop accepts schema 4 without changing files and backs it up before migrating to schema 5', async t => {
  const dataDir = await temporaryDirectory(t);
  let runtime = await startDesktopRuntime({ dataDir, preferredPort: 0 });
  t.after(() => runtime.close());
  const document = await importSample(runtime.baseUrl);
  const saved = await json(runtime.baseUrl, `/api/documents/${document.id}`, {
    method: 'PATCH', body: { notesZh: '旧库升级后保留的笔记 Ω', notesEn: '', lastPage: 2, expectedNotesRevision: document.notesRevision },
  });
  const { annotation } = await json(runtime.baseUrl, `/api/documents/${document.id}/annotations`, {
    method: 'POST', body: { page: 2, quote: 'phase margin', comment: '旧库批注', color: 'green', rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.1 }] },
  });
  await runtime.close();
  const previous = new DatabaseSync(join(dataDir, 'paperdesk.sqlite'));
  previous.exec('DROP TABLE IF EXISTS bookmarks; PRAGMA user_version = 4;');
  previous.close();
  const before = await snapshot(dataDir);
  assert.equal((await validateExistingLibrary(dataDir)).schemaVersion, 4);
  assert.deepEqual(await snapshot(dataDir), before, 'selecting a schema 4 library must only inspect it');

  runtime = await startDesktopRuntime({ dataDir, preferredPort: 0 });
  const restored = await json(runtime.baseUrl, `/api/documents/${document.id}`);
  assert.equal(restored.document.notesZh, saved.document.notesZh);
  assert.equal(restored.document.lastPage, 2);
  assert.equal(restored.annotations[0].id, annotation.id);
  assert.deepEqual(await readFile(join(dataDir, 'pdfs', document.id + '.pdf')), sample);
  await runtime.close();
  const migrated = new DatabaseSync(join(dataDir, 'paperdesk.sqlite'), { readOnly: true });
  try {
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 5);
    assert.deepEqual(migrated.prepare('PRAGMA table_info(bookmarks)').all().map(column => column.name),
      ['id', 'document_id', 'page', 'title', 'created_at', 'updated_at']);
    assert.equal(migrated.prepare('SELECT count(*) AS count FROM bookmarks').get().count, 0);
  } finally { migrated.close(); }
  const backupDir = join(dataDir, 'recoveries', 'migrations');
  const backups = [];
  for (const relative of await readdir(backupDir, { recursive: true })) {
    const filename = join(backupDir, relative);
    if ((await lstat(filename)).isFile() && (await readFile(filename)).subarray(0, 16).toString() === 'SQLite format 3\0') backups.push(filename);
  }
  assert.equal(backups.length, 1, 'schema 4 migration retains one SQLite backup');
  const backupUri = pathToFileURL(backups[0]);
  backupUri.searchParams.set('mode', 'ro');
  backupUri.searchParams.set('immutable', '1');
  const backup = new DatabaseSync(backupUri.href, { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 4);
    assert.equal(backup.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'bookmarks'").get().count, 0);
    assert.equal(backup.prepare('SELECT notes_zh FROM documents WHERE id = ?').get(document.id).notes_zh, saved.document.notesZh);
    assert.equal(backup.prepare('SELECT comment FROM annotations WHERE id = ?').get(annotation.id).comment, '旧库批注');
    assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  } finally { backup.close(); }
  assert.equal((await validateExistingLibrary(dataDir)).schemaVersion, 5);
});

test('existing-library inspection rejects empty, unrelated, older, future and incomplete libraries without changing files', async t => {
  const directory = await temporaryDirectory(t);
  const source = join(directory, 'source');
  const runtime = await startDesktopRuntime({ dataDir: source, preferredPort: 0 });
  const document = await importSample(runtime.baseUrl);
  await runtime.close();
  const missing = join(directory, 'does-not-exist');
  await assert.rejects(validateExistingLibrary(missing), /完整文献库/);
  assert.ok(!(await readdir(directory)).includes('does-not-exist'));
  const cases = [
    ['empty-directory', async folder => mkdir(folder), /完整文献库/],
    ['empty-library', async folder => { const app = createApp({ dataDir: folder }); await app.close(); }, /还没有文献/],
    ['unrelated', async folder => { await mkdir(folder); const db = new DatabaseSync(join(folder, 'paperdesk.sqlite')); db.exec(`CREATE TABLE other(value TEXT); PRAGMA user_version = ${CURRENT_SCHEMA};`); db.close(); }, /结构不兼容/],
    ['corrupt', async folder => { await mkdir(folder); await writeFile(join(folder, 'paperdesk.sqlite'), Buffer.alloc(512, 23)); }, /损坏/],
    ['future', async folder => { await cp(source, folder, { recursive: true }); const db = new DatabaseSync(join(folder, 'paperdesk.sqlite')); db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA + 1}`); db.close(); }, /更新版本/],
    ['older', async folder => { await cp(source, folder, { recursive: true }); const db = new DatabaseSync(join(folder, 'paperdesk.sqlite')); db.exec('PRAGMA user_version = 3'); db.close(); }, /先完整备份.*源码或浏览器版本升级/],
    ['missing-table', async folder => { await cp(source, folder, { recursive: true }); const db = new DatabaseSync(join(folder, 'paperdesk.sqlite')); db.exec('DROP TABLE pages'); db.close(); }, /结构不兼容/],
    ['missing-pdf', async folder => { await cp(source, folder, { recursive: true }); await rm(join(folder, 'pdfs', document.id + '.pdf')); }, /原始 PDF/],
    ['changed-pdf-size', async folder => { await cp(source, folder, { recursive: true }); await writeFile(join(folder, 'pdfs', document.id + '.pdf'), sample.subarray(0, 100)); }, /大小与记录不一致/],
  ];
  for (const [name, prepare, message] of cases) {
    await t.test(name, async () => {
      const folder = join(directory, name);
      await prepare(folder);
      const before = await snapshot(folder);
      await assert.rejects(validateExistingLibrary(folder), message);
      assert.deepEqual(await snapshot(folder), before);
    });
  }
});

test('schema 5 inspection validates bookmark structure and records without changing files', async t => {
  const directory = await temporaryDirectory(t);
  const source = join(directory, 'source');
  const runtime = await startDesktopRuntime({ dataDir: source, preferredPort: 0 });
  const document = await importSample(runtime.baseUrl);
  await runtime.close();
  const created = new Date().toISOString();
  const insert = (db, { id = randomUUID(), page = 1, title = '书签' } = {}) => db.prepare(
    'INSERT INTO bookmarks(id, document_id, page, title, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)'
  ).run(id, document.id, page, title, created, created);
  const cases = [
    ['valid', db => insert(db, { page: 2, title: '频率响应 Ω' }), null],
    ['missing-table', db => db.exec('DROP TABLE bookmarks'), /结构不兼容/],
    ['missing-column', db => db.exec('ALTER TABLE bookmarks RENAME COLUMN title TO missing_title'), /结构不兼容/],
    ['page-out-of-range', db => insert(db, { page: document.pageCount + 1 }), /无效的页面.*书签/],
    ['invalid-id', db => insert(db, { id: 'not-a-uuid' }), /无效的书签/],
    ['empty-title', db => insert(db, { title: '' }), /无效的书签/],
    ['untrimmed-title', db => insert(db, { title: ' 书签 ' }), /无效的书签/],
    ['multiline-title', db => insert(db, { title: '第一行\n第二行' }), /无效的书签/],
    ['control-title', db => insert(db, { title: '隐形\u200b字符' }), /无效的书签/],
    ['long-title', db => insert(db, { title: '签'.repeat(201) }), /无效的书签/],
    ['duplicate-page', db => { insert(db); insert(db, { title: '同页第二个书签' }); }, /无效的书签/],
  ];
  for (const [name, prepare, message] of cases) {
    await t.test(name, async () => {
      const folder = join(directory, name);
      await cp(source, folder, { recursive: true });
      const db = new DatabaseSync(join(folder, 'paperdesk.sqlite'));
      try {
        if (['empty-title', 'long-title', 'duplicate-page'].includes(name)) {
          // A structurally compatible table without CHECK/UNIQUE constraints
          // makes the inspector, rather than SQLite insertion, reject bad rows.
          db.exec('CREATE TABLE unchecked_bookmarks AS SELECT * FROM bookmarks; DROP TABLE bookmarks; ALTER TABLE unchecked_bookmarks RENAME TO bookmarks;');
        }
        prepare(db);
      } finally { db.close(); }
      const before = await snapshot(folder);
      if (message) await assert.rejects(validateExistingLibrary(folder), message);
      else assert.equal((await validateExistingLibrary(folder)).schemaVersion, 5);
      assert.deepEqual(await snapshot(folder), before);
    });
  }
});

test('existing-library inspection refuses nonempty WAL instead of ignoring committed live records', async t => {
  const dataDir = await temporaryDirectory(t);
  const runtime = await startDesktopRuntime({ dataDir, preferredPort: 0 });
  t.after(() => runtime.close());
  await importSample(runtime.baseUrl);
  const before = await snapshot(dataDir);
  await assert.rejects(validateExistingLibrary(dataDir), /正常停止原阅读服务/);
  assert.deepEqual(await snapshot(dataDir), before);
});

test('runtime startup failures release their reserved port and do not downgrade future databases', async t => {
  const dataDir = await temporaryDirectory(t);
  const db = new DatabaseSync(join(dataDir, 'paperdesk.sqlite'));
  db.exec(`CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES('preserved'); PRAGMA user_version = ${CURRENT_SCHEMA + 1};`);
  db.close();
  const reserve = createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise(done => reserve.close(done));
  const before = await readFile(join(dataDir, 'paperdesk.sqlite'));
  await assert.rejects(startDesktopRuntime({ dataDir, preferredPort: port }), /更新版本/);
  assert.deepEqual(await readFile(join(dataDir, 'paperdesk.sqlite')), before);
  await new Promise((done, reject) => {
    const second = createServer();
    second.once('error', reject);
    second.listen(port, '127.0.0.1', () => second.close(done));
  });
});

test('ordinary desktop settings ignore inherited production vault variables without touching its files', async t => {
  const root = await temporaryDirectory(t);
  const vaultDir = join(root, 'production-vault');
  await mkdir(join(vaultDir, '.obsidian'), { recursive: true });
  await writeFile(join(vaultDir, 'original.md'), 'Production fixture remains untouched.');
  const before = await snapshot(vaultDir);
  const previous = Object.fromEntries(['PAPERDESK_VAULT_DIR', 'PAPERDESK_VAULT_SUBDIR'].map(key => [key, process.env[key]]));
  process.env.PAPERDESK_VAULT_DIR = vaultDir;
  process.env.PAPERDESK_VAULT_SUBDIR = 'Formal';
  let runtime;
  try {
    const dataDir = join(root, 'ordinary-library');
    runtime = await startDesktopRuntime({ dataDir, preferredPort: 0 });
    assert.equal((await json(runtime.baseUrl, '/api/storage')).mode, 'library');
    assert.equal((await json(runtime.baseUrl, '/api/plugin/status')).libraryId, hash(dataDir));
    assert.deepEqual(await snapshot(vaultDir), before);
  } finally {
    await runtime?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('desktop vault identity uses the managed directory, independent of its local cache', async t => {
  const root = await temporaryDirectory(t);
  const vaultDir = join(root, '知识库'), dataDir = join(root, 'cache');
  await mkdir(join(vaultDir, '.obsidian'), { recursive: true });
  const config = getVaultConfig({ vaultDir, dataDir });
  const runtime = await startDesktopRuntime({ vaultDir, dataDir, preferredPort: 0 });
  t.after(() => runtime.close());
  assert.equal(runtime.vaultDir, config.vaultDir);
  assert.equal(runtime.vaultSubdir, 'Paperdesk');
  assert.equal(runtime.libraryDir, config.libraryDir);
  assert.equal((await json(runtime.baseUrl, '/api/plugin/status')).libraryId, hash(config.libraryDir));
  assert.equal((await json(runtime.baseUrl, '/api/storage')).mode, 'vault');
  const reused = await startDesktopRuntime({ vaultDir, dataDir: join(root, 'other-cache'), preferredPort: Number(new URL(runtime.baseUrl).port) });
  assert.equal(reused.owned, false);
  assert.equal(reused.baseUrl, runtime.baseUrl);
  await reused.close();
  assert.ok(!(await readdir(root)).includes('other-cache'));
  assert.deepEqual(await json(runtime.baseUrl, '/api/health'), { ok: true });
});

test('desktop vault restarts from official PDF and Markdown after cache removal', async t => {
  const root = await temporaryDirectory(t);
  const vaultDir = join(root, 'vault'), dataDir = join(root, 'cache');
  await mkdir(join(vaultDir, '.obsidian'), { recursive: true });
  let runtime = await startDesktopRuntime({ vaultDir, dataDir, preferredPort: 0 });
  t.after(() => runtime.close());
  const relativePdf = '参考资料/原始 阅读 # 1.pdf', originalPdf = join(vaultDir, ...relativePdf.split('/'));
  await mkdir(join(vaultDir, '参考资料'), { recursive: true });
  await writeFile(originalPdf, sample);
  const opened = await fetch(runtime.baseUrl + '/api/vault/pdfs/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: relativePdf }),
  });
  assert.equal(opened.status, 201);
  const { document } = await opened.json();
  const { document: saved } = await json(runtime.baseUrl, `/api/documents/${document.id}`, {
    method: 'PATCH', body: { notesZh: '正式 Markdown 笔记 Ω', notesEn: '', expectedNotesRevision: document.notesRevision },
  });
  const { uri } = await json(runtime.baseUrl, `/api/documents/${document.id}/vault-note`);
  const markdown = new URL(uri).searchParams.get('path');
  assert.match(await readFile(markdown, 'utf8'), /正式 Markdown 笔记 Ω/);
  await runtime.close();
  const before = await snapshot(vaultDir);
  assert.equal(hash(await readFile(originalPdf)), hash(sample));
  assert.ok(!Object.hasOwn(before, 'Paperdesk/PDFs'), 'Opening the original PDF must not create a copy directory');
  await rm(dataDir, { recursive: true, force: true });
  runtime = await startDesktopRuntime({ vaultDir, dataDir, preferredPort: 0 });
  const restored = await json(runtime.baseUrl, `/api/documents/${document.id}`);
  assert.equal(restored.document.notesZh, saved.notesZh);
  assert.equal((await json(runtime.baseUrl, '/api/documents')).documents.length, 1);
  assert.equal(hash(Buffer.from(await (await fetch(runtime.baseUrl + `/api/documents/${document.id}/file`)).arrayBuffer())), hash(sample));
  assert.deepEqual(await snapshot(vaultDir), before);
});

test('Obsidian URI validation permits only an existing Markdown file inside the active managed directory', async t => {
  const root = await temporaryDirectory(t);
  const libraryDir = join(root, 'vault', 'Paperdesk'), note = join(libraryDir, '论文笔记.md');
  await mkdir(libraryDir, { recursive: true });
  await writeFile(note, '笔记');
  const valid = `obsidian://open?path=${encodeURIComponent(note)}`;
  assert.equal(await validateVaultNoteUri(valid, libraryDir), `obsidian://open?path=${encodeURIComponent(await realpath(note))}`);
  const outside = join(root, 'outside.md');
  await writeFile(outside, '外部文件');
  await symlink(outside, join(libraryDir, 'outside.md'));
  const cases = [
    'https://example.com', 'obsidian://advanced-uri?vault=anything', `${valid}&file=anything`, `${valid}#anything`,
    `obsidian://open?path=${encodeURIComponent(outside)}`, `obsidian://open?path=${encodeURIComponent(join(libraryDir, 'outside.md'))}`,
    'obsidian://open?path=relative.md', `obsidian://open?path=${encodeURIComponent(join(libraryDir, 'missing.md'))}`,
  ];
  for (const value of cases) await assert.rejects(validateVaultNoteUri(value, libraryDir));
});
