import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { createCanvas } from '@napi-rs/canvas';
import { createApp } from '../server/app.mjs';
import { bookmarkedPdf } from './fixtures/toc-browser.mjs';

const URL_PATH = '/api/chatgpt/jobs';
const chatUrl = `https://chatgpt.com/c/${randomUUID()}`;
const turn = () => new Promise(resolve => setTimeout(resolve, 5));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate) {
  const deadline = Date.now() + 3000;
  do { const result = await predicate(); if (result) return result; await turn(); } while (Date.now() < deadline);
  assert.fail('Expected task state did not arrive');
}

async function start(dataDir, runner) {
  const runtime = createApp({ dataDir, chatgptRunner: runner });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    request(route, body, method = 'POST', headers = {}) {
      return fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    },
    async get(route) { const response = await fetch(`${base}${route}`); assert.equal(response.status, 200); return response.json(); },
    async job(id) { return (await this.get(`${URL_PATH}/${id}`)).job; },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await runtime.close(); },
  };
}
async function fixture(t, runner) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'paperdesk-chatgpt-jobs-'));
  let current = await start(dataDir, runner);
  const bytes = bookmarkedPdf(), form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'original-job-test.pdf');
  const uploaded = await fetch(`${current.base}/api/documents`, { method: 'POST', body: form });
  assert.equal(uploaded.status, 201);
  const doc = (await uploaded.json()).document;
  t.after(async () => { await current.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, doc, bytes, get app() { return current; }, async restart(nextRunner, beforeStart) { await current.close(); await beforeStart?.(); current = await start(dataDir, nextRunner); } };
}
const payload = (doc, patch = {}) => ({ requestId: randomUUID(), documentId: doc.id, page: 2, question: '解释这个选区。', selection: { kind: 'text', text: '  selected α\n原始引文  ' }, ...patch });
async function submit(app, body) { const response = await app.request(URL_PATH, body); assert.equal(response.status, 202, await response.clone().text()); return (await response.json()).job; }
async function reject(response, status = 400) { assert.equal(response.status, status); const body = await response.json(); assert.equal(typeof body.error, 'string'); assert.ok(!body.job); return body; }
function region() {
  const canvas = createCanvas(17, 9), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fc5'; ctx.fillRect(0, 0, 17, 9); ctx.fillStyle = '#164'; ctx.fillRect(3, 2, 7, 4);
  return { kind: 'region', text: '', preview: `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}` };
}

test('jobs freeze only selected text or PNG, redact internal fields, persist securely, and leave notes/PDF unchanged', async t => {
  const received = [];
  const lib = await fixture(t, { async run(job, emit) {
    received.push(job);
    await emit({ state: 'waiting', dispatchInvoked: true, privateLedger: '/private/ledger', apiKey: 'not-public' });
    return { state: 'completed', response: `回答 ${job.page}`, chatUrl, modelLabel: 'Thinking', depthLabel: 'Extended', privatePath: '/private/hidden' };
  } });
  await lib.app.request(`/api/documents/${lib.doc.id}`, { title: '冻结标题', notesZh: '私密笔记，不可读取或改写', notesEn: 'legacy private notes', lastPage: 4 }, 'PATCH');
  const before = (await lib.app.get(`/api/documents/${lib.doc.id}`)).document;
  for (const selected of [{ kind: 'text', text: ' \n精确选文 α  ' }, region()]) {
    const body = payload(lib.doc, { selection: selected }), queued = await submit(lib.app, body);
    assert.equal(queued.id, body.requestId);
    assert.equal(queued.requestId, body.requestId);
    const done = await until(async () => { const job = await lib.app.job(queued.id); return job.state === 'completed' && job; });
    assert.equal(done.title, before.title);
    assert.equal(done.page, 2); assert.equal(done.response, '回答 2'); assert.equal(done.chatUrl, chatUrl);
    assert.equal(done.dispatchInvoked, true); assert.equal(done.canResume, false);
    for (const key of ['question', 'selection', 'preview', 'digest', 'privatePath', 'apiKey', 'privateLedger', 'notesZh', 'notesEn']) assert.ok(!Object.hasOwn(done, key), key);
    assert.ok(!JSON.stringify(done).includes(lib.dataDir));
    assert.deepEqual(received.at(-1).selection, selected);
    assert.equal(received.at(-1).title, before.title);
    assert.ok(!JSON.stringify(received.at(-1)).includes(before.notesZh));
  }
  assert.deepEqual((await lib.app.get(`/api/documents/${lib.doc.id}`)).document, before);
  assert.deepEqual(await readFile(path.join(lib.dataDir, 'pdfs', `${lib.doc.id}.pdf`)), lib.bytes);
  const dir = path.join(lib.dataDir, 'chatgpt-jobs'), journal = JSON.parse(await readFile(path.join(dir, 'journal.json'), 'utf8'));
  assert.equal(journal.jobs.length, 2); assert.equal(journal.version, 1);
  assert.ok(!JSON.stringify(journal).includes('not-public'));
  if (process.platform !== 'win32') {
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(dir, 'journal.json'))).mode & 0o777, 0o600);
  }
});

test('strict job payloads, PNG validation, local origins and route-specific body limits reject unsafe requests', async t => {
  let invoked = 0;
  const { app, doc } = await fixture(t, { async run() { invoked++; return { state: 'completed', response: 'ok' }; } });
  const valid = payload(doc), png = region();
  const badPng = Buffer.from(png.preview.split(',')[1], 'base64'); badPng[badPng.length - 1] ^= 1;
  for (const patch of [
    { requestId: 'bad' }, { documentId: '../outside' }, { page: 0 }, { page: 7 }, { page: 1.5 }, { page: '2' },
    { question: ' \n' }, { question: 'x'.repeat(4001) }, { title: 'do not trust client title' }, { model: 'codex' },
    { selection: { kind: 'text', text: '' } }, { selection: { kind: 'text', text: 'x'.repeat(50001) } },
    { selection: { kind: 'text', text: 'text', preview: png.preview } }, { selection: { kind: 'other', text: 'text' } },
    { selection: { ...png, text: 'invented OCR' } }, { selection: { kind: 'region', text: '' } },
    { selection: { ...png, preview: 'https://example.com/private.png' } },
    { selection: { ...png, preview: `data:image/png;base64,${badPng.toString('base64')}` } },
    { selection: { ...png, rects: [] } },
  ]) await reject(await app.request(URL_PATH, { ...valid, ...patch }));
  await reject(await app.request(URL_PATH, null));
  await reject(await app.request(URL_PATH, { ...valid, documentId: randomUUID() }), 404);
  for (const origin of ['https://example.com', 'null', 'http://127.0.0.1:9999']) await reject(await app.request(URL_PATH, valid, 'POST', { Origin: origin }), 403);
  const foreignHost = await new Promise((resolve, rejectPromise) => {
    const req = httpRequest(`${app.base}${URL_PATH}/${valid.requestId}`, { headers: { Host: 'foreign.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', rejectPromise); req.end();
  });
  assert.equal(foreignHost, 403);
  await reject(await app.request(`${URL_PATH}/not-a-uuid`, undefined, 'GET'));
  await reject(await app.request(`${URL_PATH}/${randomUUID()}`, undefined, 'GET'), 404);
  // A >2 MiB job reaches strict field validation; ordinary APIs keep their 2 MiB parser.
  const padding = 'x'.repeat(2 * 1024 * 1024 + 100);
  await reject(await app.request(URL_PATH, { ...valid, padding }));
  await reject(await app.request(`/api/documents/${doc.id}`, { notesZh: padding }, 'PATCH'), 413);
  assert.equal(invoked, 0);
});

test('one runner executes at a time and identical request IDs never enqueue duplicate sends', async t => {
  const gate = deferred(), calls = []; let concurrent = 0, maximum = 0;
  const { app, doc } = await fixture(t, { async run(job, emit) {
    concurrent++; maximum = Math.max(maximum, concurrent); calls.push(job.id);
    await emit({ state: 'waiting', dispatchInvoked: true });
    if (calls.length === 1) await gate.promise;
    concurrent--; return { state: 'completed', response: job.id, chatUrl };
  } });
  const first = payload(doc), second = payload(doc, { question: '第二个独立问题' });
  const [a, duplicate] = await Promise.all([submit(app, first), submit(app, first)]);
  assert.equal(a.id, duplicate.id);
  await until(() => calls.length === 1);
  await submit(app, second);
  assert.equal((await app.job(second.requestId)).state, 'queued');
  await reject(await app.request(URL_PATH, { ...first, question: '同 ID 不同内容' }), 409);
  gate.resolve();
  await until(async () => (await app.job(second.requestId)).state === 'completed');
  assert.deepEqual(calls, [first.requestId, second.requestId]); assert.equal(maximum, 1);
  assert.equal((await submit(app, first)).state, 'completed'); assert.equal(calls.length, 2);
});

test('needs_user pauses the entire queue; an explicit resume continues the same job before later tasks', async t => {
  const calls = [];
  const { app, doc } = await fixture(t, { async run(job, emit, options) {
    calls.push({ id: job.id, resume: options.resume });
    if (calls.length === 1) return { state: 'needs_user', canResume: true, message: '请登录普通 ChatGPT。' };
    await emit({ state: 'sending', dispatchInvoked: true });
    return { state: 'completed', response: 'continued', chatUrl };
  } });
  const first = payload(doc), second = payload(doc);
  await submit(app, first);
  await until(async () => (await app.job(first.requestId)).canResume);
  await submit(app, second); await turn(); assert.equal(calls.length, 1);
  await reject(await app.request(`${URL_PATH}/${first.requestId}/resume`, { force: true }));
  const resumed = await app.request(`${URL_PATH}/${first.requestId}/resume`, {}); assert.equal(resumed.status, 202);
  await until(async () => (await app.job(second.requestId)).state === 'completed');
  assert.deepEqual(calls, [{ id: first.requestId, resume: false }, { id: first.requestId, resume: true }, { id: second.requestId, resume: false }]);
  await reject(await app.request(`${URL_PATH}/${first.requestId}/resume`, {}), 409);
});

test('unknown delivery pauses queued work, blocks new requests and cannot be resumed or silently retried', async t => {
  const gate = deferred(), calls = [];
  const { app, doc } = await fixture(t, { async run(job, emit) {
    calls.push(job.id); await emit({ state: 'sending', dispatchInvoked: true });
    await emit({ state: 'waiting', dispatchInvoked: false });
    await gate.promise; throw new Error('secret-path /private/runner/internal-token');
  } });
  const first = payload(doc), second = payload(doc);
  await submit(app, first); await until(() => calls.length === 1); await submit(app, second);
  gate.resolve();
  const unknown = await until(async () => { const job = await app.job(first.requestId); return job.state === 'uncertain' && job; });
  assert.equal(unknown.dispatchInvoked, true); assert.equal(unknown.canResume, false);
  assert.ok(!JSON.stringify(unknown).includes('internal-token'));
  assert.equal((await app.job(second.requestId)).state, 'queued'); assert.equal(calls.length, 1);
  assert.equal((await submit(app, first)).state, 'uncertain');
  await reject(await app.request(`${URL_PATH}/${first.requestId}/resume`, {}), 409);
  await reject(await app.request(URL_PATH, payload(doc)), 429); assert.equal(calls.length, 1);
});

test('non-resumable user intervention remains blocked and cannot be forced through resume', async t => {
  let calls = 0;
  const { app, doc } = await fixture(t, { async run() { calls++; return { state: 'needs_user', canResume: false, message: '请先查看已打开的对话。' }; } });
  const body = payload(doc); await submit(app, body);
  await until(async () => (await app.job(body.requestId)).state === 'needs_user');
  await reject(await app.request(`${URL_PATH}/${body.requestId}/resume`, {}), 409);
  assert.equal((await submit(app, body)).canResume, false); assert.equal(calls, 1);
});

test('a completed response still finalizing in the runner cannot be evicted or overlap the next execution', async t => {
  const answerReady = deferred(), cleanupDone = deferred(); let calls = 0;
  const { app, doc } = await fixture(t, { async run(_job, emit) {
    calls++; const first = calls === 1;
    await emit({ state: 'waiting', dispatchInvoked: true });
    if (first) {
      await answerReady.promise;
      await emit({ state: 'completed', response: 'answer is ready' });
      await cleanupDone.promise;
    }
    return { state: 'completed', response: 'finished' };
  } });
  const first = await submit(app, payload(doc)); await until(() => calls === 1);
  let last;
  for (let index = 1; index < 8; index++) last = await submit(app, payload(doc));
  answerReady.resolve(); await until(async () => (await app.job(first.id)).state === 'completed');
  await reject(await app.request(URL_PATH, payload(doc)), 429); assert.equal(calls, 1);
  cleanupDone.resolve(); await until(async () => (await app.job(last.id)).state === 'completed');
  await submit(app, payload(doc)); assert.ok(calls >= 8);
});

test('close and restart preserve uncertainty, ignore late acknowledgements and never execute recovered tasks', async t => {
  const gate = deferred(); let firstCalls = 0, restartedCalls = 0, closeCalls = 0;
  const lib = await fixture(t, { async run(_job, emit) {
    firstCalls++; await emit({ state: 'waiting', dispatchInvoked: true }); await gate.promise;
    try { await emit({ state: 'completed', response: 'late response' }); } catch {}
    return { state: 'completed', response: 'late response' };
  }, close() { closeCalls++; } });
  const first = payload(lib.doc), second = payload(lib.doc);
  await submit(lib.app, first); await until(() => firstCalls === 1); await submit(lib.app, second);
  const journalPath = path.join(lib.dataDir, 'chatgpt-jobs', 'journal.json');
  const beforeCrash = await readFile(journalPath, 'utf8');
  assert.deepEqual(JSON.parse(beforeCrash).jobs.map(job => job.state), ['waiting', 'queued']);
  await lib.restart({ async run() { restartedCalls++; return { state: 'completed', response: 'must never run' }; } }, async () => {
    assert.ok(JSON.parse(await readFile(journalPath, 'utf8')).jobs.every(job => job.state === 'uncertain'), 'Graceful close marks unfinished tasks uncertain');
    // Restore the last in-flight durable record to simulate a process exit
    // before close() could checkpoint. Startup must not replay either task.
    await writeFile(journalPath, beforeCrash, { mode: 0o600 });
  });
  assert.equal(closeCalls, 1);
  gate.resolve(); await turn();
  for (const body of [first, second]) {
    const job = await lib.app.job(body.requestId); assert.equal(job.state, 'uncertain'); assert.equal(job.canResume, false);
    assert.equal((await submit(lib.app, body)).state, 'uncertain');
  }
  assert.equal((await lib.app.job(first.requestId)).dispatchInvoked, true);
  assert.equal((await lib.app.job(second.requestId)).dispatchInvoked, false);
  assert.equal(firstCalls, 1); assert.equal(restartedCalls, 0);
});

test('eight retained jobs evict only safe terminal results and retain permanent lightweight idempotency receipts', async t => {
  for (const initialState of ['completed', 'failed']) await t.test(initialState, async sub => {
    let calls = 0; const forgotten = [];
    const lib = await fixture(sub, { async run() {
      calls++;
      if (calls === 1 && initialState === 'failed') return { state: 'failed', message: '尚未发送。' };
      return { state: 'completed', dispatchInvoked: true, response: `response-${calls}`, chatUrl: 'https://evil.example/c/12345678' };
    }, forget(id) { forgotten.push(id); } });
    const first = payload(lib.doc, { selection: { kind: 'text', text: 'UNIQUE-EVICTED-PRIVATE-QUOTE' } });
    for (let index = 0; index < 9; index++) {
      const body = index === 0 ? first : payload(lib.doc, { question: `question-${index}` });
      await submit(lib.app, body);
      const result = await until(async () => { const job = await lib.app.job(body.requestId); return ['completed', 'failed'].includes(job.state) && job; });
      assert.ok(!result.chatUrl, 'Only a ChatGPT conversation URL may be returned');
    }
    const raw = await readFile(path.join(lib.dataDir, 'chatgpt-jobs', 'journal.json'), 'utf8'), journal = JSON.parse(raw);
    assert.equal(journal.jobs.length, 8); assert.equal(journal.receipts.length, 1);
    assert.deepEqual(forgotten, [first.requestId]);
    assert.deepEqual(Object.keys(journal.receipts[0]).sort(), ['digest', 'dispatchInvoked', 'requestId', 'state']);
    assert.ok(!raw.includes('UNIQUE-EVICTED-PRIVATE-QUOTE'));
    await reject(await lib.app.request(`${URL_PATH}/${first.requestId}`, undefined, 'GET'), 410);
    await reject(await lib.app.request(URL_PATH, first), 410);
    await reject(await lib.app.request(URL_PATH, { ...first, question: 'different' }), 409);
    await lib.restart({ async run() { assert.fail('A recovered terminal job must not run'); } });
    await reject(await lib.app.request(URL_PATH, first), 410); assert.equal(calls, 9);
  });
});

test('pending tasks cannot be evicted to make room and corrupt journals stop automation safely', async t => {
  let calls = 0;
  const lib = await fixture(t, { async run() { calls++; return { state: 'needs_user', canResume: true }; } });
  const first = await submit(lib.app, payload(lib.doc));
  await until(async () => (await lib.app.job(first.id)).canResume);
  for (let index = 1; index < 8; index++) await submit(lib.app, payload(lib.doc));
  await reject(await lib.app.request(URL_PATH, payload(lib.doc)), 429); assert.equal(calls, 1);
  await lib.app.close();
  await writeFile(path.join(lib.dataDir, 'chatgpt-jobs', 'journal.json'), '{interrupted', { mode: 0o600 });
  // restart() closes the already closed runtime harmlessly, then reads the corrupt journal.
  await lib.restart({ async run() { assert.fail('Corrupt journal must never send'); } });
  await reject(await lib.app.request(URL_PATH, payload(lib.doc)), 503);
  assert.equal((await lib.app.get('/api/health')).ok, true);
});
