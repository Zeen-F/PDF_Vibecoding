import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.mjs';
import { CURRENT_SCHEMA } from '../shared/library.mjs';

// All credentials, text and provider responses here are synthetic. Every
// provider request is intercepted; these tests never contact external providers.
const APP_ID = '2026100700001234', KEY = 'synthetic-key+&=不是密码';
const configUrl = '/api/translation/settings', translateUrl = '/api/translation';
const md5 = value => createHash('md5').update(value, 'utf8').digest('hex');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await delay(2); } assert.fail('Expected isolated operation did not start'); }

async function fixture(t, { timeoutMs = 15_000 } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'paperdesk-translation-'));
  let runtime, server, base, handler, sleepHandler;
  let time = Date.parse('2026-10-07T00:00:00Z'), active = 0, peak = 0;
  const calls = [], sleeps = [], receivedRequests = [];
  const fakeFetch = async (url, options) => {
    const fields = new URLSearchParams(options.body);
    const call = { url, options, fields, time }; calls.push(call); active++; peak = Math.max(peak, active);
    try {
      return handler ? await handler(call) : Response.json({ from: fields.get('from') === 'auto' ? 'en' : fields.get('from'), to: fields.get('to'), trans_result: [{ src: fields.get('q'), dst: '原创测试译文' }] });
    } finally { active--; }
  };
  const translationOptions = { fetchImpl: fakeFetch, clock: { now: () => time, sleep: async ms => { sleeps.push(ms); if (sleepHandler) return sleepHandler(ms); time += ms; } }, timeoutMs };
  async function start() {
    runtime = createApp({ dataDir, translationOptions });
    server = runtime.app.listen(0, '127.0.0.1');
    server.on('request', req => req.once('end', () => receivedRequests.push({ path: req.url, method: req.method })));
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = undefined; }
    if (runtime) { await runtime.close(); runtime = undefined; }
  }
  await start(); t.after(async () => { await stop(); await rm(dataDir, { recursive: true, force: true }); });
  const lib = {
    dataDir, calls, sleeps, receivedRequests, get peak() { return peak; }, get runtime() { return runtime; }, get base() { return base; },
    setHandler(value) { handler = value; }, setSleep(value) { sleepHandler = value; }, setTime(value) { time = Date.parse(value); },
    async restart() { await stop(); await start(); },
    request(route, method = 'GET', body, headers = {}) {
      return fetch(base + route, { method, headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    },
    async json(route, method = 'GET', body, status = 200) {
      const response = await this.request(route, method, body); assert.equal(response.status, status, route); return response.json();
    },
    configure(patch = {}) { return this.json(configUrl, 'PUT', { appId: APP_ID, apiKey: KEY, tier: 'standard', monthlyLimit: 50_000, ...patch }); },
    translate(text, extras = {}) { return this.json(translateUrl, 'POST', { text, ...extras }); },
  };
  return lib;
}
async function rejected(response, status, privateValues = []) {
  assert.equal(response.status, status);
  const text = await response.text(), body = JSON.parse(text);
  assert.equal(typeof body.error, 'string');
  assert.deepEqual(Object.keys(body), ['error']);
  for (const value of privateValues) assert.ok(!text.includes(value), 'Errors must not echo credentials, source text, unknown field names or upstream details');
}
function readSidecar(lib, work) {
  const db = new DatabaseSync(path.join(lib.dataDir, 'translation.sqlite'), { readOnly: true });
  try { return work(db); } finally { db.close(); }
}

test('unconfigured, invalid settings, missing credentials and foreign origins cannot send or expose secrets', async t => {
  const lib = await fixture(t);
  const first = await lib.json(configUrl);
  assert.deepEqual(first.settings, { provider: 'baidu', activeProvider: 'baidu', configured: false, appIdHint: null, tier: 'standard', monthlyLimit: 50_000, month: '2026-10', usedCharacters: 0, remainingCharacters: 50_000, maxCharacters: 1000, maxBytes: 6000, endpoint: 'https://fanyi-api.baidu.com/api/trans/vip/translate', region: null, model: null });
  assert.ok(!(await readdir(lib.dataDir)).includes('translation.sqlite'), 'Reading unconfigured defaults must not create a secret store');
  await rejected(await lib.request(translateUrl, 'POST', { text: 'Original text' }), 409);
  for (const body of [
    {}, [], { tier: 'standard', appId: APP_ID }, { tier: 'standard', apiKey: KEY },
    { tier: 'standard', appId: 'private-invalid-id', apiKey: KEY }, { tier: 'other', appId: APP_ID, apiKey: KEY },
    { tier: 'standard', appId: APP_ID, apiKey: KEY, monthlyLimit: -1 },
    { tier: 'standard', appId: APP_ID, apiKey: KEY, monthlyLimit: 50_001 },
    { tier: 'standard', appId: APP_ID, apiKey: KEY, monthlyLimit: null },
    { tier: 'advanced', appId: APP_ID, apiKey: KEY, monthlyLimit: 1_000_001 },
    { tier: 'standard', appId: APP_ID, apiKey: '\u0000secret' },
    { tier: 'standard', appId: APP_ID, apiKey: KEY, 'secret-as-field-name': true },
  ]) await rejected(await lib.request(configUrl, 'PUT', body), 400, [APP_ID, KEY, 'private-invalid-id', 'secret-as-field-name']);
  assert.equal(lib.calls.length, 0);
  for (const [url, method, body] of [[configUrl, 'GET'], [configUrl, 'PUT', { appId: APP_ID, apiKey: KEY, tier: 'standard' }], [configUrl, 'DELETE'], [translateUrl, 'POST', { text: 'blocked' }]]) {
    for (const Origin of ['null', 'https://untrusted.example']) await rejected(await lib.request(url, method, body, { Origin }), 403);
  }
  const configured = await lib.configure();
  assert.equal(configured.settings.appIdHint, '••••1234');
  assert.ok(!JSON.stringify(configured).includes(APP_ID)); assert.ok(!JSON.stringify(configured).includes(KEY));
  const defaults = await lib.json(configUrl, 'PUT', { appId: '', apiKey: ' ', tier: 'advanced' });
  assert.equal(defaults.settings.monthlyLimit, 1_000_000); assert.equal(defaults.settings.maxCharacters, 6000);
  await rejected(await lib.request(configUrl, 'PUT', { appId: '1234567890123456', tier: 'standard' }), 400);
  const privacy = await lib.request(configUrl); assert.equal(privacy.headers.get('cache-control'), 'no-store');
});

test('Baidu POST signing uses the raw UTF-8 query, a fresh salt and form encoding; cache and private permissions survive restart', async t => {
  const lib = await fixture(t); await lib.configure();
  const text = '电路 Ω🧪 + & = 10%\nline two';
  const result = await lib.translate(text, { from: 'en', to: 'zh' });
  assert.deepEqual(result.translation, { provider: 'baidu', translatedText: '原创测试译文', from: 'en', to: 'zh', cached: false, characters: Array.from(text).length });
  assert.equal(result.settings.usedCharacters, Array.from(text).length);
  const call = lib.calls[0];
  assert.equal(call.url, 'https://fanyi-api.baidu.com/api/trans/vip/translate');
  assert.equal(call.options.method, 'POST'); assert.equal(call.options.redirect, 'error');
  assert.match(call.options.headers['Content-Type'], /application\/x-www-form-urlencoded/);
  assert.ok(call.options.signal instanceof AbortSignal);
  assert.equal(call.fields.get('q'), text); assert.equal(call.fields.get('appid'), APP_ID);
  assert.match(call.fields.get('salt'), /^[a-f0-9]{32}$/);
  assert.equal(call.fields.get('sign'), md5(APP_ID + text + call.fields.get('salt') + KEY));
  assert.ok(!call.fields.toString().includes(KEY));
  const replay = await lib.translate(text, { from: 'en', to: 'zh' }); assert.equal(replay.translation.cached, true); assert.equal(lib.calls.length, 1);
  const used = replay.settings.usedCharacters;
  for (const file of ['translation.sqlite', 'translation.sqlite-wal', 'translation.sqlite-shm']) {
    const info = await stat(path.join(lib.dataDir, file)); assert.equal(info.mode & 0o777, 0o600);
  }
  assert.equal((await stat(lib.dataDir)).mode & 0o777, 0o700);
  await lib.restart();
  const resumed = await lib.translate(text, { from: 'en', to: 'zh' }); assert.equal(resumed.translation.cached, true); assert.equal(resumed.settings.usedCharacters, used);
  assert.equal(lib.calls.length, 1);
  await lib.translate('a different query'); assert.equal(lib.calls.length, 2); assert.notEqual(lib.calls[1].fields.get('salt'), call.fields.get('salt'));
  readSidecar(lib, db => {
    assert.ok(db.prepare('PRAGMA table_info(cache)').all().every(column => !['text', 'source', 'q', 'api_key', 'app_id'].includes(column.name)));
    assert.match(db.prepare('SELECT digest FROM cache LIMIT 1').get().digest, /^[a-f0-9]{64}$/);
  });
});

test('Unicode point and byte bounds never truncate; budget reservations serialize and month changes at UTC+8 midnight', async t => {
  const lib = await fixture(t); await lib.configure({ monthlyLimit: 5 });
  const outcomes = await Promise.all(['🧪a', 'Ωb', '电c'].map(text => lib.request(translateUrl, 'POST', { text })));
  assert.deepEqual(outcomes.map(result => result.status).sort(), [200, 200, 429]);
  assert.equal(lib.calls.length, 2); assert.equal(lib.peak, 1);
  assert.ok(lib.calls[1].time - lib.calls[0].time >= 1000);
  assert.equal((await lib.json(configUrl)).settings.usedCharacters, 4);
  await lib.configure();
  for (const body of [{ text: '' }, { text: ' ' }, { text: '\ud800' }, { text: 'x', from: 'jp' }, { text: 'x', from: null }, { text: 'x', to: null }, { text: 'x', endpoint: 'https://untrusted.example' }]) await rejected(await lib.request(translateUrl, 'POST', body), 400);
  await rejected(await lib.request(translateUrl, 'POST', { text: 'a'.repeat(1001) }), 413);
  const beforeBounds = lib.calls.length;
  await lib.configure({ tier: 'advanced', monthlyLimit: 1_000_000 });
  await rejected(await lib.request(translateUrl, 'POST', { text: 'a'.repeat(6001) }), 413);
  await rejected(await lib.request(translateUrl, 'POST', { text: '界'.repeat(2001) }), 413);
  await rejected(await lib.request(translateUrl, 'POST', { text: '🧪'.repeat(1501) }), 413);
  assert.equal(lib.calls.length, beforeBounds);
  assert.equal((await lib.translate('界'.repeat(2000))).translation.characters, 2000);
  assert.equal((await lib.translate('a'.repeat(6000))).translation.characters, 6000);
  lib.setTime('2026-10-31T15:59:59.000Z');
  await lib.translate('last moment');
  assert.equal((await lib.json(configUrl)).settings.month, '2026-10');
  lib.setTime('2026-10-31T16:00:00.000Z');
  assert.equal((await lib.json(configUrl)).settings.month, '2026-11'); assert.equal((await lib.json(configUrl)).settings.usedCharacters, 0);
  await lib.translate('next month'); assert.equal((await lib.json(configUrl)).settings.usedCharacters, 10);
});

test('failures, provider errors and timeouts remain charged with safe messages and no automatic retries', async t => {
  const lib = await fixture(t, { timeoutMs: 70 }); await lib.configure();
  const secretText = 'PRIVATE_SOURCE_FOR_FAILURE';
  const output = [], originalError = console.error;
  console.error = (...values) => output.push(values.join(' ')); t.after(() => { console.error = originalError; });
  lib.setHandler(() => { throw new Error(KEY + APP_ID + secretText); });
  await rejected(await lib.request(translateUrl, 'POST', { text: secretText }), 502, [KEY, APP_ID, secretText]);
  lib.setHandler(() => Response.json({ error_code: '54001', error_msg: KEY + APP_ID + secretText }));
  await rejected(await lib.request(translateUrl, 'POST', { text: 'second' }), 502, [KEY, APP_ID, secretText]);
  lib.setHandler(() => Response.json({ error_code: 'new-error', error_msg: KEY + APP_ID }));
  await rejected(await lib.request(translateUrl, 'POST', { text: 'third' }), 502, [KEY, APP_ID]);
  lib.setHandler(() => new Response(KEY + APP_ID, { status: 500 }));
  await rejected(await lib.request(translateUrl, 'POST', { text: 'fourth' }), 502, [KEY, APP_ID]);
  lib.setHandler(() => new Promise(() => {}));
  await rejected(await lib.request(translateUrl, 'POST', { text: 'timeout' }), 504, [KEY, APP_ID]);
  assert.equal(lib.calls.length, 5); assert.equal(lib.calls.at(-1).options.signal.aborted, true);
  assert.equal((await lib.json(configUrl)).settings.usedCharacters, secretText.length + 6 + 5 + 6 + 7);
  assert.equal(readSidecar(lib, db => db.prepare('SELECT COUNT(*) AS n FROM cache').get().n), 0);
  assert.ok(output.every(line => !line.includes(KEY) && !line.includes(APP_ID) && !line.includes(secretText)));
  await lib.restart(); assert.equal((await lib.json(configUrl)).settings.usedCharacters, secretText.length + 24);
});

test('queued requests expire without late sends, account changes cannot switch a waiting request, and shutdown is bounded', async t => {
  const lib = await fixture(t, { timeoutMs: 100 }); await lib.configure();
  const gate = deferred();
  lib.setHandler(async ({ fields }) => { await gate.promise; return Response.json({ from: 'en', to: 'zh', trans_result: [{ dst: fields.get('q') === 'first' ? '第一' : '第二' }] }); });
  const first = lib.request(translateUrl, 'POST', { text: 'first' });
  await until(() => lib.calls.length === 1);
  const queued = lib.request(translateUrl, 'POST', { text: 'queued' });
  await delay(10);
  await lib.configure({ appId: '2026100700009876', apiKey: 'other-synthetic-key' });
  gate.resolve();
  assert.equal((await first).status, 200); await rejected(await queued, 409); assert.equal(lib.calls.length, 1);
  assert.equal((await lib.json(configUrl)).settings.usedCharacters, 0);
  const beforeWait = lib.sleeps.length;
  // Hold the provider's 1 QPS wait rather than advancing the fake clock. Both
  // a waiting request and a request queued behind it must expire without sends.
  lib.setSleep(() => new Promise(() => {}));
  const waiting = lib.request(translateUrl, 'POST', { text: 'rate limited wait' });
  await until(() => lib.sleeps.length > beforeWait);
  const expiredBehind = lib.request(translateUrl, 'POST', { text: 'never sent after timeout' });
  await rejected(await waiting, 504); await rejected(await expiredBehind, 504);
  assert.equal(lib.calls.length, 1); assert.equal((await lib.json(configUrl)).settings.usedCharacters, 0);
  lib.setSleep(null);
  lib.setHandler(() => new Promise(() => {}));
  const timed = lib.request(translateUrl, 'POST', { text: 'timed' }); await until(() => lib.calls.length === 2);
  const secondQueued = lib.request(translateUrl, 'POST', { text: 'expires in queue' });
  await rejected(await timed, 504); await rejected(await secondQueued, 504);
  // A late timeout result cannot cause queued work to run after its deadline.
  assert.ok(lib.calls.length <= 3);
  const after = lib.calls.length; await delay(30); assert.equal(lib.calls.length, after);
  const active = lib.request(translateUrl, 'POST', { text: 'stop active' }); await until(() => lib.calls.length === after + 1);
  await lib.runtime.close(); await rejected(await active, 503);
  assert.equal(lib.calls.at(-1).options.signal.aborted, true);
});

test('removing credentials preserves per-account usage and never allows an old cache to bypass account scope', async t => {
  const lib = await fixture(t); await lib.configure({ monthlyLimit: 20 });
  await lib.translate('original');
  const removed = await lib.json(configUrl, 'DELETE');
  assert.equal(removed.settings.configured, false); assert.equal(removed.settings.appIdHint, null); assert.equal(removed.settings.monthlyLimit, 20);
  readSidecar(lib, db => {
    const row = db.prepare("SELECT app_id, api_key FROM profiles WHERE provider = 'baidu'").get(); assert.equal(row.app_id, null); assert.equal(row.api_key, null);
    assert.equal(db.prepare('SELECT characters FROM usage').get().characters, 8);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cache').get().n, 0);
  });
  for (const suffix of ['', '-wal']) {
    try { const bytes = await readFile(path.join(lib.dataDir, 'translation.sqlite' + suffix)); assert.ok(!bytes.includes(Buffer.from(KEY))); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
  }
  await rejected(await lib.request(translateUrl, 'POST', { text: 'original' }), 409);
  await lib.restart();
  await lib.configure({ monthlyLimit: 20 }); assert.equal((await lib.json(configUrl)).settings.usedCharacters, 8);
  assert.equal((await lib.translate('original')).translation.cached, false); assert.equal(lib.calls.length, 2);
  await lib.configure({ appId: '2026100700009876', apiKey: 'other-synthetic-key', monthlyLimit: 20 });
  assert.equal((await lib.translate('original')).translation.cached, false); assert.equal(lib.calls.length, 3);
  await lib.configure({ monthlyLimit: 20 }); assert.equal((await lib.translate('original')).translation.cached, true); assert.equal(lib.calls.length, 3);
});

test('a SQLite reservation lock cannot turn a timed-out request into a late provider send', async t => {
  const lib = await fixture(t, { timeoutMs: 60 }); await lib.configure();
  const worker = new Worker(`
    const { DatabaseSync } = require('node:sqlite');
    const { parentPort, workerData } = require('node:worker_threads');
    const db = new DatabaseSync(workerData);
    db.exec('BEGIN IMMEDIATE'); parentPort.postMessage('locked');
    setTimeout(() => { db.exec('ROLLBACK'); db.close(); parentPort.close(); }, 140);
  `, { eval: true, workerData: path.join(lib.dataDir, 'translation.sqlite') });
  t.after(() => worker.terminate());
  await once(worker, 'message');
  await rejected(await lib.request(translateUrl, 'POST', { text: 'must not send after lock wait' }), 504);
  assert.equal(lib.calls.length, 0);
  assert.equal((await lib.json(configUrl)).settings.usedCharacters, 0);
});

test('pending work is bounded and shutdown discards unsent queued requests without charging them', async t => {
  const lib = await fixture(t, { timeoutMs: 2000 }); await lib.configure();
  lib.setHandler(() => new Promise(() => {}));
  const waiting = Array.from({ length: 8 }, (_, i) => lib.request(translateUrl, 'POST', { text: 'pending-' + i }));
  await until(() => lib.calls.length === 1);
  // Wait for every HTTP body to arrive, rather than assuming a scheduling delay.
  await until(() => lib.receivedRequests.filter(req => req.path === translateUrl && req.method === 'POST').length === 8);
  await rejected(await lib.request(translateUrl, 'POST', { text: 'overflow' }), 429);
  await lib.runtime.close();
  for (const response of await Promise.all(waiting)) await rejected(response, 503);
  assert.equal(lib.calls.length, 1);
  assert.equal(readSidecar(lib, db => db.prepare('SELECT characters FROM usage').get().characters), 9);
});

test('cache is bounded to 200 entries and translation cannot change notes, schema, reading position or original PDF', async t => {
  const lib = await fixture(t); await lib.configure();
  const sample = await readFile(new URL('../public/examples/reading-demo.pdf', import.meta.url));
  const form = new FormData(); form.append('file', new Blob([sample], { type: 'application/pdf' }), 'original.pdf');
  const imported = await fetch(lib.base + '/api/documents', { method: 'POST', body: form }); assert.equal(imported.status, 201);
  const doc = (await imported.json()).document;
  await lib.json('/api/documents/' + doc.id, 'PATCH', { notesZh: '原笔记 **保留**', notesEn: 'Original note', lastPage: 2, expectedNotesRevision: doc.notesRevision });
  const before = await lib.json('/api/documents/' + doc.id);
  for (let i = 0; i < 201; i++) await lib.translate('entry-' + i);
  assert.equal(readSidecar(lib, db => db.prepare('SELECT COUNT(*) AS n FROM cache').get().n), 200);
  await lib.json('/api/translation/test', 'POST', { provider: 'baidu' });
  assert.deepEqual(await lib.json('/api/documents/' + doc.id), before);
  assert.deepEqual(await readFile(path.join(lib.dataDir, 'pdfs', doc.id + '.pdf')), sample);
  const primary = new DatabaseSync(path.join(lib.dataDir, 'paperdesk.sqlite'), { readOnly: true });
  try {
    assert.equal(primary.prepare('PRAGMA user_version').get().user_version, CURRENT_SCHEMA);
    assert.deepEqual(primary.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name), ['annotation_requests', 'annotations', 'documents', 'folders', 'library_preferences', 'pages', 'reading_position_writers']);
  } finally { primary.close(); }
});

const AZURE_KEY = 'synthetic-azure-key', DEEPL_KEY = 'synthetic-deepl-key:fx', CUSTOM_KEY = 'synthetic-custom-key';
const customEndpoint = 'https://translation.example/v1/chat/completions';
function jsonCall(call) { return JSON.parse(call.options.body); }
function providerMock(call) {
  if (call.options.headers['Ocp-Apim-Subscription-Key']) return Response.json([{ detectedLanguage: { language: 'en' }, translations: [{ text: 'Azure ' + jsonCall(call)[0].Text, to: new URL(call.url).searchParams.get('to') }] }]);
  if (call.options.headers.Authorization?.startsWith('DeepL-Auth-Key')) return Response.json({ translations: [{ text: 'DeepL ' + jsonCall(call).text[0], detected_source_language: 'EN' }] });
  if (call.options.headers.Authorization?.startsWith('Bearer')) return Response.json({ choices: [{ message: { content: 'Custom ' + jsonCall(call).messages[1].content } }] });
  return Response.json({ from: 'en', to: call.fields.get('to'), trans_result: [{ dst: 'Baidu ' + call.fields.get('q') }] });
}

test('Azure sends only selected text with required headers, full endpoint and language query mapping', async t => {
  const lib = await fixture(t); lib.setHandler(providerMock);
  const settings = (await lib.json(configUrl, 'PUT', { provider: 'azure', apiKey: AZURE_KEY, region: 'eastasia' })).settings;
  assert.equal(settings.provider, 'azure'); assert.equal(settings.activeProvider, 'azure'); assert.equal(settings.configured, true);
  assert.equal(settings.monthlyLimit, 2_000_000); assert.equal(settings.tier, 'standard'); assert.equal(settings.maxCharacters, 10_000); assert.equal(settings.maxBytes, 40_000);
  assert.equal(settings.endpoint, 'https://api.cognitive.microsofttranslator.com/translate'); assert.equal(settings.appIdHint, null);
  const raw = 'EN \n 电路 Ω + ? & =';
  const translated = await lib.translate(raw);
  assert.equal(translated.translation.provider, 'azure'); assert.equal(translated.translation.from, 'en'); assert.equal(translated.translation.to, 'zh');
  const call = lib.calls[0], url = new URL(call.url);
  assert.deepEqual([...url.searchParams], [['api-version', '3.0'], ['to', 'zh-Hans']]);
  assert.deepEqual(jsonCall(call), [{ Text: raw }]);
  assert.deepEqual(call.options.headers, { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': AZURE_KEY, 'Ocp-Apim-Subscription-Region': 'eastasia' });
  assert.equal(call.options.redirect, 'error'); assert.equal(call.options.method, 'POST');
  assert.equal((await lib.translate(raw)).translation.cached, true); assert.equal(lib.calls.length, 1);
  await lib.json(configUrl, 'PUT', { provider: 'azure', endpoint: 'https://translation.example/translator/text/v3.0/translate', apiKey: AZURE_KEY, region: '' });
  lib.setHandler(() => Response.json([{ detectedLanguage: { language: 'zh-Hans' }, translations: [{ text: 'English text', to: 'en' }] }]));
  assert.equal((await lib.translate('中文', { from: 'zh', to: 'en' })).translation.from, 'zh');
  const explicit = lib.calls[1], explicitUrl = new URL(explicit.url);
  assert.equal(explicitUrl.origin, 'https://translation.example'); assert.equal(explicitUrl.pathname, '/translator/text/v3.0/translate');
  assert.equal(explicitUrl.searchParams.get('from'), 'zh-Hans'); assert.equal(explicitUrl.searchParams.get('to'), 'en');
  assert.ok(!Object.hasOwn(explicit.options.headers, 'Ocp-Apim-Subscription-Region'));
});

test('DeepL selects the official endpoint by initial key type and uses JSON/auth without retries', async t => {
  const lib = await fixture(t); lib.setHandler(providerMock);
  const settings = (await lib.json(configUrl, 'PUT', { provider: 'deepl', apiKey: DEEPL_KEY })).settings;
  assert.equal(settings.endpoint, 'https://api-free.deepl.com/v2/translate'); assert.equal(settings.monthlyLimit, 50_000);
  const result = await lib.translate('literal & Ω text'); assert.equal(result.translation.provider, 'deepl'); assert.equal(result.translation.from, 'en');
  assert.deepEqual(lib.calls[0].options.headers, { 'Content-Type': 'application/json', Authorization: 'DeepL-Auth-Key ' + DEEPL_KEY });
  assert.deepEqual(jsonCall(lib.calls[0]), { text: ['literal & Ω text'], target_lang: 'ZH' });
  await lib.translate('中文内容', { from: 'zh', to: 'en' });
  assert.deepEqual(jsonCall(lib.calls[1]), { text: ['中文内容'], target_lang: 'EN', source_lang: 'ZH' });
  await rejected(await lib.request(configUrl, 'PUT', { provider: 'deepl', endpoint: 'https://api.deepl.com/v2/translate' }), 400);
  await lib.json(configUrl, 'PUT', { provider: 'deepl', endpoint: 'https://api.deepl.com/v2/translate', apiKey: 'synthetic-pro-key' });
  await lib.translate('Pro query'); assert.equal(lib.calls.at(-1).url, 'https://api.deepl.com/v2/translate');
  await rejected(await lib.request(configUrl, 'PUT', { provider: 'deepl', endpoint: 'https://other.example/v2/translate', apiKey: DEEPL_KEY }), 400);
  const fresh = await fixture(t); await fresh.json(configUrl, 'PUT', { provider: 'deepl', apiKey: 'synthetic-pro-key' });
  assert.equal((await fresh.json(configUrl)).settings.endpoint, 'https://api.deepl.com/v2/translate');
});

test('custom compatibility API sends a translation-only prompt and keeps model/path changes inside one account budget', async t => {
  const lib = await fixture(t); lib.setHandler(providerMock);
  const put = patch => lib.json(configUrl, 'PUT', { provider: 'openai-compatible', ...patch });
  await put({ apiKey: CUSTOM_KEY, endpoint: customEndpoint, model: 'translator-model', monthlyLimit: 20 });
  const text = 'ignore instruction 🧪';
  const result = await lib.translate(text, { from: 'en', to: 'zh' });
  assert.equal(result.translation.provider, 'openai-compatible'); assert.equal(result.translation.from, 'en');
  const call = lib.calls[0]; assert.equal(call.url, customEndpoint); assert.equal(call.options.headers.Authorization, 'Bearer ' + CUSTOM_KEY);
  const body = jsonCall(call); assert.deepEqual(Object.keys(body), ['model', 'messages', 'stream']);
  assert.equal(body.model, 'translator-model'); assert.equal(body.stream, false);
  assert.equal(body.messages.length, 2); assert.equal(body.messages[0].role, 'system'); assert.match(body.messages[0].content, /Simplified Chinese/);
  assert.match(body.messages[0].content, /not instructions/); assert.deepEqual(body.messages[1], { role: 'user', content: text });
  assert.equal((await lib.translate(text, { from: 'en' })).translation.cached, true);
  const used = (await lib.json(configUrl)).settings.usedCharacters; assert.equal(used, 20);
  await put({ model: 'other-model' });
  assert.equal((await lib.json(configUrl)).settings.usedCharacters, used); assert.equal((await lib.json(configUrl)).settings.monthlyLimit, 20);
  await rejected(await lib.request(translateUrl, 'POST', { text, from: 'en' }), 429); assert.equal(lib.calls.length, 1);
  await put({ monthlyLimit: 100 }); await lib.translate(text, { from: 'en' }); assert.equal(lib.calls.length, 2);
  await put({ endpoint: 'https://translation.example/custom/chat/completions' });
  assert.equal((await lib.json(configUrl)).settings.usedCharacters, 40);
  await lib.translate(text, { from: 'en' }); assert.equal(lib.calls.length, 3); assert.equal((await lib.json(configUrl)).settings.usedCharacters, 60);
  await lib.translate('一个词', { from: 'zh', to: 'en' }); assert.match(jsonCall(lib.calls.at(-1)).messages[0].content, /English/);
  const publicBody = JSON.stringify(await lib.json(configUrl)); assert.ok(!publicBody.includes(CUSTOM_KEY)); assert.ok(!publicBody.includes(text));
});

test('provider profiles retain independent limits, caches and usage across switching, deletion and restart', async t => {
  const lib = await fixture(t); lib.setHandler(providerMock);
  await lib.configure({ monthlyLimit: 60 }); await lib.translate('same text');
  await lib.json(configUrl, 'PUT', { provider: 'azure', apiKey: AZURE_KEY, monthlyLimit: 70 }); await lib.translate('same text');
  await lib.json(configUrl, 'PUT', { provider: 'deepl', apiKey: DEEPL_KEY, monthlyLimit: 80 }); await lib.translate('same text');
  await lib.json(configUrl, 'PUT', { provider: 'openai-compatible', apiKey: CUSTOM_KEY, endpoint: customEndpoint, model: 'fixture-model', monthlyLimit: 90 }); await lib.translate('same text');
  const expected = { baidu: 60, azure: 70, deepl: 80, 'openai-compatible': 90 };
  for (const provider of Object.keys(expected)) {
    const profile = (await lib.json(configUrl + '?provider=' + provider)).settings;
    assert.equal(profile.provider, provider); assert.equal(profile.activeProvider, 'openai-compatible'); assert.equal(profile.monthlyLimit, expected[provider]); assert.equal(profile.usedCharacters, 9);
  }
  await lib.restart();
  for (const provider of Object.keys(expected)) {
    const saved = (await lib.json(configUrl, 'PUT', { provider, apiKey: '' })).settings;
    assert.equal(saved.monthlyLimit, expected[provider]); assert.equal(saved.usedCharacters, 9);
    assert.equal((await lib.translate('same text')).translation.cached, true);
  }
  assert.equal(lib.calls.length, 4);
  const deleted = (await lib.json(configUrl + '?provider=deepl', 'DELETE')).settings;
  assert.equal(deleted.configured, false); assert.equal(deleted.activeProvider, 'openai-compatible');
  assert.equal((await lib.json(configUrl)).settings.configured, true);
  await lib.json(configUrl, 'PUT', { provider: 'deepl', apiKey: DEEPL_KEY });
  assert.equal((await lib.json(configUrl)).settings.usedCharacters, 9);
  assert.equal((await lib.translate('same text')).translation.cached, false); assert.equal(lib.calls.length, 5);
  await lib.json(configUrl, 'PUT', { provider: 'baidu', apiKey: '' }); assert.equal((await lib.translate('same text')).translation.cached, true);
});

test('endpoint and provider validation cannot forward a saved key to a new origin or accept unsafe request shapes', async t => {
  const lib = await fixture(t); lib.setHandler(providerMock);
  const baseline = { provider: 'openai-compatible', apiKey: CUSTOM_KEY, endpoint: customEndpoint, model: 'fixture-model' };
  await lib.json(configUrl, 'PUT', baseline);
  for (const endpoint of ['http://remote.example/v1/chat/completions', 'https://user:private@host.example/v1/chat/completions', customEndpoint + '?secret=1', customEndpoint + '#key', customEndpoint + '?', 'file:///tmp/chat/completions', 'https://host.example/other', 'https://host.example/v1/chat/completions\n', 'https://host.example/v1/chat/completions#']) {
    await rejected(await lib.request(configUrl, 'PUT', { ...baseline, endpoint }), 400, [CUSTOM_KEY, endpoint]);
  }
  await rejected(await lib.request(configUrl, 'PUT', { provider: 'openai-compatible', endpoint: 'https://new-host.example/v1/chat/completions' }), 400);
  await rejected(await lib.request(configUrl, 'PUT', { provider: 'openai-compatible', endpoint: 'https://translation.example:444/v1/chat/completions', apiKey: '' }), 400);
  for (const body of [
    { provider: 'other', apiKey: 'SECRET_UNKNOWN_PROVIDER' }, { provider: null },
    { provider: 'azure', apiKey: AZURE_KEY, monthlyLimit: 10_000_001 }, { provider: 'deepl', apiKey: DEEPL_KEY, monthlyLimit: null },
    { provider: 'azure', apiKey: AZURE_KEY, region: '\nsecret' }, { provider: 'azure', apiKey: AZURE_KEY, endpoint: 'http://localhost/translate' },
    { provider: 'azure', apiKey: AZURE_KEY, appId: '1234' }, { provider: 'deepl', apiKey: DEEPL_KEY, tier: 'advanced' },
    { ...baseline, model: '' }, { ...baseline, model: null }, { ...baseline, apiKey: 'x'.repeat(4097) }, { ...baseline, region: 'eastasia' },
  ]) await rejected(await lib.request(configUrl, 'PUT', body), 400, ['SECRET_UNKNOWN_PROVIDER', CUSTOM_KEY, AZURE_KEY, DEEPL_KEY]);
  for (const query of ['?provider=other', '?provider=azure&provider=deepl', '?private-key=value']) await rejected(await lib.request(configUrl + query), 400, ['private-key']);
  assert.equal(lib.calls.length, 0); assert.equal((await lib.json(configUrl)).settings.endpoint, customEndpoint);
  for (const endpoint of ['http://localhost:8080/v1/chat/completions', 'http://127.0.0.1:8080/chat/completions', 'http://[::1]:8080/v1/chat/completions']) {
    await lib.json(configUrl, 'PUT', { ...baseline, endpoint }); await lib.translate(endpoint);
    assert.equal(lib.calls.at(-1).url, endpoint); assert.equal(lib.calls.at(-1).options.redirect, 'error');
  }
  await lib.json(configUrl, 'PUT', { ...baseline, apiKey: 'x'.repeat(4096) });
  await lib.translate('long key accepted without truncation'); assert.equal(lib.calls.at(-1).options.headers.Authorization.length, 4103);
});

test('switching the active provider cancels queued work while preserving the provider identity of an in-flight result', async t => {
  const lib = await fixture(t); lib.setHandler(providerMock); await lib.configure();
  const gate = deferred(); lib.setHandler(async call => { await gate.promise; return providerMock(call); });
  const first = lib.request(translateUrl, 'POST', { text: 'first' }); await until(() => lib.calls.length === 1);
  const queued = lib.request(translateUrl, 'POST', { text: 'queued' }); await delay(10);
  await lib.json(configUrl, 'PUT', { provider: 'azure', apiKey: AZURE_KEY }); gate.resolve();
  const result = await (await first).json(); assert.equal(result.translation.provider, 'baidu'); assert.equal(result.settings.activeProvider, 'azure');
  await rejected(await queued, 409); assert.equal(lib.calls.length, 1);
  assert.equal((await lib.json(configUrl)).settings.usedCharacters, 0);
  assert.equal((await lib.json(configUrl + '?provider=baidu')).settings.usedCharacters, 5);
});

test('all non-Baidu adapters bound requests and sanitize HTTP, malformed responses and timeout failures', async t => {
  for (const provider of ['azure', 'deepl', 'openai-compatible']) {
    // Valid 40 KB responses use the normal budget, not the deliberately short
    // deadline reserved below for a provider that never settles.
    const lib = await fixture(t); lib.setHandler(providerMock);
    const config = { provider, apiKey: 'synthetic-key', ...(provider === 'openai-compatible' ? { endpoint: customEndpoint, model: 'fixture-model' } : {}) };
    await lib.json(configUrl, 'PUT', config);
    await rejected(await lib.request(translateUrl, 'POST', { text: 'a'.repeat(10_001) }), 413); assert.equal(lib.calls.length, 0);
    assert.equal((await lib.translate('🧪'.repeat(10_000))).translation.characters, 10_000); // Exactly 40,000 UTF-8 bytes.
    for (const status of [401, 403, 429, 456]) {
      lib.setHandler(() => new Response('PRIVATE_UPSTREAM_DETAIL synthetic-key', { status }));
      await rejected(await lib.request(translateUrl, 'POST', { text: 'request-' + status }), [429, 456].includes(status) ? 429 : 502, ['PRIVATE_UPSTREAM_DETAIL', 'synthetic-key', 'request-' + status]);
    }
    lib.setHandler(() => Response.json({ error: 'PRIVATE_UPSTREAM_DETAIL' }));
    await rejected(await lib.request(translateUrl, 'POST', { text: 'malformed' }), 502, ['PRIVATE_UPSTREAM_DETAIL']);
    const timeoutLib = await fixture(t, { timeoutMs: 40 });
    await timeoutLib.json(configUrl, 'PUT', config);
    timeoutLib.setHandler(() => new Promise(() => {}));
    await rejected(await timeoutLib.request(translateUrl, 'POST', { text: 'timeout' }), 504, ['synthetic-key', 'timeout']);
    assert.equal(timeoutLib.calls.length, 1, 'The timeout must cancel a started upstream request');
    assert.equal(timeoutLib.calls[0].options.signal.aborted, true);
    assert.equal(lib.calls.length, 6);
    assert.equal((await lib.json(configUrl)).settings.usedCharacters, 10_053);
    assert.equal((await timeoutLib.json(configUrl)).settings.usedCharacters, 7);
  }
});

function createV1Sidecar(lib, { broken = false, future = false } = {}) {
  const db = new DatabaseSync(path.join(lib.dataDir, 'translation.sqlite'));
  try {
    db.exec(`CREATE TABLE settings (id INTEGER PRIMARY KEY, app_id TEXT, api_key TEXT, tier TEXT, monthly_limit INTEGER${broken ? '' : ', revision TEXT'});
      CREATE TABLE usage(account TEXT, month TEXT, characters INTEGER, PRIMARY KEY(account,month));
      CREATE TABLE cache(id INTEGER PRIMARY KEY, digest TEXT UNIQUE, account TEXT, translated_text TEXT, source_language TEXT, target_language TEXT, characters INTEGER, touched_at INTEGER);
      CREATE TABLE send_clock(id INTEGER PRIMARY KEY, next_at INTEGER); INSERT INTO send_clock VALUES(1,0);
      PRAGMA user_version = ${future ? 99 : 1};`);
    if (broken) return;
    const account = createHash('sha256').update(APP_ID).digest('hex'), text = 'legacy cache';
    const digest = createHash('sha256').update(JSON.stringify([account, 'auto', 'zh', text])).digest('hex');
    db.prepare('INSERT INTO settings VALUES (1,?,?,?,?,?)').run(APP_ID, KEY, 'advanced', 4567, 'v1-revision');
    db.prepare('INSERT INTO usage VALUES (?,?,?)').run(account, '2026-10', 42);
    db.prepare('INSERT INTO cache VALUES (1,?,?,?,?,?,?,?)').run(digest, account, '旧译文', 'en', 'zh', text.length, 1);
  } finally { db.close(); }
}

test('v1 sidecars migrate transactionally with Baidu credentials, limits, usage and source-free cache preserved', async t => {
  const lib = await fixture(t); createV1Sidecar(lib);
  const result = (await lib.json(configUrl)).settings;
  assert.equal(result.provider, 'baidu'); assert.equal(result.configured, true); assert.equal(result.tier, 'advanced'); assert.equal(result.monthlyLimit, 4567); assert.equal(result.usedCharacters, 42);
  const cached = await lib.translate('legacy cache'); assert.equal(cached.translation.cached, true); assert.equal(cached.translation.translatedText, '旧译文'); assert.equal(lib.calls.length, 0);
  readSidecar(lib, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    const profile = db.prepare("SELECT * FROM profiles WHERE provider='baidu'").get(); assert.equal(profile.api_key, KEY); assert.equal(profile.app_id, APP_ID);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='settings'").get().n, 0);
  });
  await lib.restart(); assert.equal((await lib.translate('legacy cache')).translation.cached, true); assert.equal((await lib.json(configUrl)).settings.usedCharacters, 42);
  for (const variant of [{ broken: true }, { future: true }]) {
    const bad = await fixture(t); createV1Sidecar(bad, variant);
    await rejected(await bad.request(configUrl), 500, [APP_ID, KEY]);
    readSidecar(bad, db => {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, variant.future ? 99 : 1);
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='profiles'").get().n, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='settings'").get().n, 1);
    });
  }
});

test('zero limits survive profile switches and credentials/origins cannot borrow another account allowance or cache', async t => {
  const lib = await fixture(t); lib.setHandler(providerMock);
  await lib.json(configUrl, 'PUT', { provider: 'azure', apiKey: 'same-synthetic-key', monthlyLimit: 100 });
  await lib.translate('cached');
  await lib.json(configUrl, 'PUT', { provider: 'azure', monthlyLimit: 0 });
  assert.equal((await lib.translate('cached')).translation.cached, true);
  await rejected(await lib.request(translateUrl, 'POST', { text: 'uncached' }), 429); assert.equal(lib.calls.length, 1);
  await lib.json(configUrl, 'PUT', { provider: 'deepl', apiKey: 'same-synthetic-key', monthlyLimit: 0 });
  assert.equal((await lib.json(configUrl)).settings.usedCharacters, 0);
  await rejected(await lib.request(translateUrl, 'POST', { text: 'cached' }), 429); assert.equal(lib.calls.length, 1);
  await lib.json(configUrl, 'PUT', { provider: 'azure', apiKey: '' });
  assert.equal((await lib.json(configUrl)).settings.monthlyLimit, 0); assert.equal((await lib.json(configUrl)).settings.usedCharacters, 6);
  await rejected(await lib.request(translateUrl, 'POST', { text: 'still stopped' }), 429);
  await lib.restart(); assert.equal((await lib.json(configUrl)).settings.monthlyLimit, 0);
  await lib.json(configUrl, 'PUT', { provider: 'azure', endpoint: 'https://other.example/translate', apiKey: 'same-synthetic-key', monthlyLimit: 100 });
  assert.equal((await lib.json(configUrl)).settings.usedCharacters, 0);
  assert.equal((await lib.translate('cached')).translation.cached, false);
  await lib.json(configUrl, 'PUT', { provider: 'azure', endpoint: 'https://api.cognitive.microsofttranslator.com/translate', apiKey: 'same-synthetic-key' });
  assert.equal((await lib.json(configUrl)).settings.usedCharacters, 6); assert.equal((await lib.translate('cached')).translation.cached, true);
  await lib.json(configUrl, 'PUT', { provider: 'azure', apiKey: 'replacement-synthetic-key' });
  assert.equal((await lib.json(configUrl)).settings.usedCharacters, 0); assert.equal((await lib.translate('cached')).translation.cached, false);
  assert.equal(lib.calls.length, 3);
});

const testUrl = '/api/translation/test', testText = 'Hello, Paperdesk.', testCharacters = Array.from(testText).length;
const testCandidates = {
  baidu: { provider: 'baidu', appId: APP_ID, apiKey: KEY, tier: 'standard' },
  azure: { provider: 'azure', apiKey: AZURE_KEY, region: 'eastasia' },
  deepl: { provider: 'deepl', apiKey: DEEPL_KEY },
  'openai-compatible': { provider: 'openai-compatible', apiKey: CUSTOM_KEY, endpoint: customEndpoint, model: 'fixture-model' },
};
async function rejectedTest(response, status, category, privateValues = []) {
  assert.equal(response.status, status);
  const text = await response.text(), body = JSON.parse(text);
  assert.deepEqual(Object.keys(body).sort(), ['category', 'error']);
  assert.equal(body.category, category); assert.equal(typeof body.error, 'string');
  for (const value of privateValues) assert.ok(!text.includes(value), 'Test diagnostics cannot contain credentials or raw upstream details');
}

test('connection tests use all four adapters with the fixed sample and never save or activate unsaved credentials', async t => {
  for (const [provider, candidate] of Object.entries(testCandidates)) {
    const lib = await fixture(t); lib.setHandler(providerMock);
    const initial = await lib.json(configUrl);
    const primaryBefore = await readFile(path.join(lib.dataDir, 'paperdesk.sqlite'));
    for (let i = 0; i < 2; i++) {
      const result = await lib.json(testUrl, 'POST', candidate);
      assert.deepEqual(Object.keys(result), ['test']);
      assert.deepEqual(Object.keys(result.test).sort(), ['characters', 'elapsedMs', 'provider', 'sourceText', 'translatedText']);
      assert.equal(result.test.provider, provider); assert.equal(result.test.sourceText, testText); assert.equal(result.test.characters, testCharacters);
      assert.equal(typeof result.test.translatedText, 'string'); assert.ok(Number.isInteger(result.test.elapsedMs) && result.test.elapsedMs >= 0);
      assert.ok(!JSON.stringify(result).includes(candidate.apiKey)); assert.ok(!JSON.stringify(result).includes(APP_ID));
    }
    assert.equal(lib.calls.length, 2, 'Repeated tests must perform two fresh provider requests');
    assert.equal(lib.peak, 1); assert.ok(lib.calls[1].time - lib.calls[0].time >= 1000);
    assert.deepEqual(await lib.json(configUrl), initial);
    assert.equal((await lib.json(configUrl + '?provider=' + provider)).settings.configured, false);
    readSidecar(lib, db => {
      assert.equal(db.prepare('SELECT count(*) AS n FROM profiles').get().n, 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM cache').get().n, 0);
      assert.equal(db.prepare('SELECT sum(characters) AS n FROM usage').get().n, testCharacters * 2);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    });
    for (const suffix of ['', '-wal']) {
      try {
        const bytes = await readFile(path.join(lib.dataDir, 'translation.sqlite' + suffix));
        assert.ok(!bytes.includes(Buffer.from(candidate.apiKey))); assert.ok(!bytes.includes(Buffer.from(APP_ID)));
      } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
    }
    assert.deepEqual(await readFile(path.join(lib.dataDir, 'paperdesk.sqlite')), primaryBefore);
    const call = lib.calls[0]; assert.equal(call.options.redirect, 'error');
    if (provider === 'baidu') {
      assert.equal(call.fields.get('q'), testText); assert.equal(call.fields.get('from'), 'en'); assert.equal(call.fields.get('to'), 'zh');
      assert.equal(call.fields.get('sign'), md5(APP_ID + testText + call.fields.get('salt') + KEY));
    } else if (provider === 'azure') {
      assert.deepEqual(jsonCall(call), [{ Text: testText }]); assert.equal(new URL(call.url).searchParams.get('from'), 'en'); assert.equal(new URL(call.url).searchParams.get('to'), 'zh-Hans');
      assert.equal(call.options.headers['Ocp-Apim-Subscription-Key'], AZURE_KEY); assert.equal(call.options.headers['Ocp-Apim-Subscription-Region'], 'eastasia');
    } else if (provider === 'deepl') {
      assert.deepEqual(jsonCall(call), { text: [testText], source_lang: 'EN', target_lang: 'ZH' }); assert.equal(call.options.headers.Authorization, 'DeepL-Auth-Key ' + DEEPL_KEY);
    } else {
      assert.deepEqual(jsonCall(call).messages[1], { role: 'user', content: testText }); assert.equal(jsonCall(call).model, 'fixture-model');
      assert.equal(call.options.headers.Authorization, 'Bearer ' + CUSTOM_KEY);
    }
    await lib.restart(); assert.equal((await lib.json(configUrl + '?provider=' + provider)).settings.configured, false);
    await lib.json(configUrl, 'PUT', candidate); assert.equal((await lib.json(configUrl)).settings.usedCharacters, testCharacters * 2);
  }
});

test('testing an inactive saved profile reuses its key but cannot activate it, mutate its configuration or use its cache', async t => {
  const lib = await fixture(t); lib.setHandler(providerMock);
  await lib.json(configUrl, 'PUT', testCandidates.azure); await lib.translate(testText, { from: 'en' });
  await lib.configure();
  const before = readSidecar(lib, db => ({ profiles: db.prepare('SELECT * FROM profiles ORDER BY provider').all(), active: db.prepare('SELECT * FROM active_settings').all(), cache: db.prepare('SELECT * FROM cache').all() }));
  await lib.json(testUrl, 'POST', { provider: 'azure', apiKey: '', region: 'westus', monthlyLimit: 777 });
  await lib.json(testUrl, 'POST', { provider: 'azure' });
  assert.equal(lib.calls.length, 3); assert.equal(lib.calls[1].options.headers['Ocp-Apim-Subscription-Region'], 'westus');
  assert.equal(lib.calls[2].options.headers['Ocp-Apim-Subscription-Region'], 'eastasia');
  assert.equal(lib.calls[2].options.headers['Ocp-Apim-Subscription-Key'], AZURE_KEY);
  assert.deepEqual(readSidecar(lib, db => ({ profiles: db.prepare('SELECT * FROM profiles ORDER BY provider').all(), active: db.prepare('SELECT * FROM active_settings').all(), cache: db.prepare('SELECT * FROM cache').all() })), before);
  assert.equal((await lib.json(configUrl)).settings.activeProvider, 'baidu');
  assert.equal((await lib.json(configUrl + '?provider=azure')).settings.usedCharacters, testCharacters * 3);
  await rejectedTest(await lib.request(testUrl, 'POST', { provider: 'azure', endpoint: 'https://other.example/translate' }), 400, 'configuration');
  assert.equal(lib.calls.length, 3, 'A saved key cannot be forwarded to a different origin');
  await lib.json(testUrl, 'POST', { provider: 'azure', endpoint: 'https://other.example/translate', apiKey: 'ephemeral-key' });
  assert.equal(new URL(lib.calls.at(-1).url).origin, 'https://other.example');
  assert.equal((await lib.json(configUrl + '?provider=azure')).settings.endpoint, 'https://api.cognitive.microsofttranslator.com/translate');
});

test('connection tests obey the candidate monthly limit and reserve failures without borrowing other accounts or caches', async t => {
  const lib = await fixture(t); lib.setHandler(providerMock); await lib.configure({ monthlyLimit: 0 });
  await rejectedTest(await lib.request(testUrl, 'POST', { provider: 'baidu' }), 429, 'quota'); assert.equal(lib.calls.length, 0);
  assert.equal((await lib.json(configUrl)).settings.monthlyLimit, 0);
  const candidate = { ...testCandidates.azure, monthlyLimit: testCharacters * 2 };
  lib.setHandler(() => new Response('secret upstream body', { status: 401 }));
  await rejectedTest(await lib.request(testUrl, 'POST', candidate), 502, 'authentication', ['secret upstream body']);
  lib.setHandler(providerMock); await lib.json(testUrl, 'POST', candidate);
  await rejectedTest(await lib.request(testUrl, 'POST', candidate), 429, 'quota'); assert.equal(lib.calls.length, 2);
  await lib.restart();
  await rejectedTest(await lib.request(testUrl, 'POST', candidate), 429, 'quota'); assert.equal(lib.calls.length, 2);
  await lib.json(testUrl, 'POST', { ...candidate, apiKey: 'different-ephemeral-account' }); assert.equal(lib.calls.length, 3);
  assert.equal((await lib.json(configUrl)).settings.activeProvider, 'baidu'); assert.equal((await lib.json(configUrl)).settings.monthlyLimit, 0);
  readSidecar(lib, db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM profiles').get().n, 1);
    assert.equal(db.prepare('SELECT sum(characters) AS n FROM usage').get().n, testCharacters * 3);
  });
});

test('connection-test errors are finite safe categories while the existing translation error response remains unchanged', async t => {
  const lib = await fixture(t, { timeoutMs: 70 });
  const secrets = [KEY, APP_ID, 'PRIVATE_UPSTREAM_DETAIL'];
  const captured = [], originalError = console.error; console.error = (...values) => captured.push(values.join(' ')); t.after(() => { console.error = originalError; });
  const upstream = [
    ['52003', 'authentication', 502], ['54001', 'authentication', 502], ['54004', 'quota', 502], ['54003', 'quota', 429],
    ['52001', 'timeout', 504], ['52002', 'connection', 502], ['UNKNOWN_PROVIDER_CODE', 'response', 502],
  ];
  for (const [code, category, status] of upstream) {
    lib.setHandler(() => Response.json({ error_code: code, error_msg: secrets.join(' ') }));
    await rejectedTest(await lib.request(testUrl, 'POST', testCandidates.baidu), status, category, [...secrets, code]);
  }
  for (const status of [400, 401, 403, 404, 429, 456]) {
    lib.setHandler(() => new Response(secrets.join(' '), { status }));
    await rejectedTest(await lib.request(testUrl, 'POST', testCandidates.azure), status < 429 ? 502 : 429, [400, 404].includes(status) ? 'configuration' : status < 429 ? 'authentication' : 'quota', secrets);
  }
  lib.setHandler(() => new Response('{"not-json": PRIVATE_UPSTREAM_DETAIL', { status: 200 }));
  await rejectedTest(await lib.request(testUrl, 'POST', testCandidates.azure), 502, 'response', secrets);
  lib.setHandler(() => Response.json({ choices: [{ message: { content: { private: KEY } } }] }));
  await rejectedTest(await lib.request(testUrl, 'POST', testCandidates['openai-compatible']), 502, 'response', secrets);
  lib.setHandler(() => { throw new Error(secrets.join(' ')); });
  await rejectedTest(await lib.request(testUrl, 'POST', testCandidates.deepl), 502, 'connection', secrets);
  lib.setHandler(() => new Promise(() => {}));
  await rejectedTest(await lib.request(testUrl, 'POST', testCandidates.deepl), 504, 'timeout', secrets);
  assert.equal(lib.calls.length, 17);
  assert.equal(readSidecar(lib, db => db.prepare('SELECT sum(characters) AS n FROM usage').get().n), testCharacters * 17);
  assert.equal(readSidecar(lib, db => db.prepare('SELECT count(*) AS n FROM cache').get().n), 0);
  assert.ok(captured.every(line => secrets.every(value => !line.includes(value))));
  await lib.configure(); lib.setHandler(() => new Response('PRIVATE_UPSTREAM_DETAIL', { status: 401 }));
  await rejected(await lib.request(translateUrl, 'POST', { text: 'normal translation still has only error' }), 502, secrets);
});

test('connection-test configuration, JSON and foreign-origin errors never send arbitrary text or echo private fields', async t => {
  const lib = await fixture(t);
  for (const body of [
    {}, [], { ...testCandidates.baidu, text: 'PRIVATE_SELECTED_TEXT' }, { ...testCandidates.azure, from: 'auto' },
    { ...testCandidates.deepl, to: 'en' }, { provider: 'openai-compatible', apiKey: CUSTOM_KEY, endpoint: customEndpoint },
    { ...testCandidates['openai-compatible'], endpoint: 'https://user:secret@example.com/chat/completions' },
    { ...testCandidates.azure, monthlyLimit: -1 }, { ...testCandidates.baidu, PRIVATE_SECRET_FIELD: 'secret' },
  ]) await rejectedTest(await lib.request(testUrl, 'POST', body), 400, 'configuration', ['PRIVATE_SELECTED_TEXT', 'PRIVATE_SECRET_FIELD', CUSTOM_KEY]);
  for (const Origin of ['null', 'https://foreign.example']) {
    await rejected(await lib.request(testUrl, 'POST', testCandidates.azure, { Origin }), 403);
  }
  const malformed = await fetch(lib.base + testUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"apiKey":"PRIVATE_JSON_SECRET", bad' });
  await rejectedTest(malformed, 400, 'configuration', ['PRIVATE_JSON_SECRET']);
  const oversized = await fetch(lib.base + testUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: 'x'.repeat(4_000_000) }) });
  await rejectedTest(oversized, 413, 'configuration');
  assert.equal(lib.calls.length, 0); assert.ok(!(await readdir(lib.dataDir)).includes('translation.sqlite'));
});

test('queued tests bind the saved tested profile revision, ignore unrelated active switches and never send after expiry', async t => {
  const lib = await fixture(t); lib.setHandler(providerMock); await lib.configure();
  let gate = deferred(); lib.setHandler(async call => { await gate.promise; return providerMock(call); });
  const first = lib.request(translateUrl, 'POST', { text: 'hold one' }); await until(() => lib.calls.length === 1);
  const tested = lib.request(testUrl, 'POST', testCandidates.azure); await delay(10);
  await lib.json(configUrl, 'PUT', testCandidates.deepl); gate.resolve();
  assert.equal((await first).status, 200); assert.equal((await tested).status, 200); assert.equal(lib.calls.length, 2);
  assert.equal((await lib.json(configUrl)).settings.activeProvider, 'deepl');
  await lib.json(configUrl, 'PUT', testCandidates.azure);
  await lib.json(configUrl, 'PUT', testCandidates.deepl);
  gate = deferred(); const before = lib.calls.length;
  const second = lib.request(translateUrl, 'POST', { text: 'hold two' }); await until(() => lib.calls.length === before + 1);
  const stale = lib.request(testUrl, 'POST', testCandidates.azure); await delay(10);
  await lib.json(configUrl, 'PUT', { ...testCandidates.azure, apiKey: 'new-saved-key' }); gate.resolve();
  assert.equal((await second).status, 200); await rejectedTest(await stale, 409, 'changed'); assert.equal(lib.calls.length, before + 1);
  const expiring = await fixture(t, { timeoutMs: 80 }); expiring.setHandler(() => new Promise(() => {})); expiring.setSleep(() => new Promise(() => {}));
  const timed = expiring.request(testUrl, 'POST', testCandidates.azure); await until(() => expiring.calls.length === 1);
  const queued = expiring.request(testUrl, 'POST', testCandidates.deepl);
  await rejectedTest(await timed, 504, 'timeout'); await rejectedTest(await queued, 504, 'timeout');
  await delay(30); assert.equal(expiring.calls.length, 1); assert.equal(readSidecar(expiring, db => db.prepare('SELECT sum(characters) AS n FROM usage').get().n), testCharacters);
});

test('test and translation queues share their capacity and close cancels only unsent tests without late provider calls', async t => {
  const lib = await fixture(t, { timeoutMs: 2000 }); await lib.configure(); lib.setHandler(() => new Promise(() => {}));
  const first = lib.request(translateUrl, 'POST', { text: 'active' }); await until(() => lib.calls.length === 1);
  const pending = Array.from({ length: 7 }, () => lib.request(testUrl, 'POST', testCandidates.azure));
  await until(() => lib.receivedRequests.filter(req => req.path === testUrl && req.method === 'POST').length === 7);
  await rejectedTest(await lib.request(testUrl, 'POST', testCandidates.deepl), 429, 'quota');
  await lib.runtime.close(); await rejected(await first, 503);
  for (const response of await Promise.all(pending)) await rejectedTest(response, 503, 'stopped');
  assert.equal(lib.calls.length, 1); assert.equal(readSidecar(lib, db => db.prepare('SELECT sum(characters) AS n FROM usage').get().n), 6);
});
