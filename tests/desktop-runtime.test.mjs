import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import fsPromises from 'node:fs/promises';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { CURRENT_SCHEMA } from '../shared/library.mjs';
import { startDesktopRuntime, validateExistingLibrary } from '../desktop/runtime.mjs';

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
  for (const [index, mismatch] of [
    { service: 'other' }, { apiVersion: 2 }, { libraryId: 'b'.repeat(64) }, { healthy: false },
  ].entries()) {
    await t.test(JSON.stringify(mismatch), async t => {
      const dataDir = join(directory, String(index));
      const status = { service: 'paperdesk', apiVersion: 1, libraryId: hash(resolve(dataDir)), ...mismatch };
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
    ['older', async folder => { await cp(source, folder, { recursive: true }); const db = new DatabaseSync(join(folder, 'paperdesk.sqlite')); db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA - 1}`); db.close(); }, /先完整备份.*源码或浏览器版本升级/],
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
