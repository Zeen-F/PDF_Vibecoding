import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createApp } from '../server/app.mjs';
import { validatePluginProfile, READER_RESOURCE } from '../server/mcp.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const documentId = '03096871-6d0e-42e0-9d63-ed0c7330ea11';
const libraryId = 'a'.repeat(64);
const rect = { x: .1, y: .2, width: .3, height: .4 };
const sample = await readFile(new URL('../public/examples/reading-demo.pdf', import.meta.url));
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function stop(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
async function clientFor(t, profile, { cached = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'paperdesk-mcp-'));
  const configPath = join(dir, 'profile.json');
  await writeFile(configPath, JSON.stringify({ workspaceRoot: root, ...profile }));
  let launcher = join(root, 'plugins/paperdesk/scripts/start.mjs');
  if (cached) { await cp(join(root, 'plugins/paperdesk'), join(dir, 'cache'), { recursive: true }); launcher = join(dir, 'cache/scripts/start.mjs'); }
  const transport = new StdioClientTransport({ command: process.execPath, args: [launcher], cwd: dir, env: { ...process.env, PAPERDESK_PLUGIN_CONFIG: configPath }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', data => { stderr += data; });
  const client = new Client({ name: 'paperdesk-protocol-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await rm(dir, { recursive: true, force: true }); });
  await client.connect(transport);
  assert.equal(stderr, '', 'stdio must not contain incidental logs');
  return client;
}
function call(client, name, args = {}) { return client.callTool({ name, arguments: args }); }
function value(result) { assert.notEqual(result.isError, true, JSON.stringify(result)); return result.structuredContent; }
function pngPreview() {
  function chunk(type, body) {
    const bytes = Buffer.concat([Buffer.from(type), body]); let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(body.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, bytes, checksum]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 50, 100, 200, 255]))), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

test('plugin refuses remote, credentialed and path-bearing base URLs', () => {
  for (const baseUrl of ['https://127.0.0.1:4317', 'http://example.com', 'http://127.0.0.1.evil.test', 'http://user:secret@localhost:4317', 'http://localhost:4317/api', 'http://localhost:4317/?library=other', 'http://localhost:4317/#hash', 'file:///tmp/x']) {
    assert.throws(() => validatePluginProfile({ baseUrl, libraryId }));
  }
  assert.equal(validatePluginProfile({ baseUrl: 'http://127.0.0.1:4317/', libraryId }).baseUrl, 'http://127.0.0.1:4317');
});

test('cached plugin uses real stdio SDK protocol with the isolated local API', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'paperdesk-plugin-library-'));
  const chatgptRuns = [];
  const runtime = createApp({ dataDir, chatgptRunner: { async run(job, emit, { resume }) {
    chatgptRuns.push({ job: structuredClone(job), resume });
    if (job.selection.kind === 'region' && !resume) return { state: 'needs_user', canResume: true, message: 'Simulated login required.' };
    await emit({ state: 'waiting', dispatchInvoked: true });
    return { state: 'completed', response: `PRIVATE_SIMULATED_REPLY:${job.question}` };
  } } });
  const httpServer = createServer(runtime.app);
  const baseUrl = await listen(httpServer);
  t.after(async () => { await stop(httpServer); await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  const api = async (path, body, method = 'POST') => {
    const response = await fetch(`${baseUrl}${path}`, body === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok(response.ok, `${response.status} ${await response.clone().text()}`);
    return response.json();
  };
  const status = await api('/api/plugin/status');
  const client = await clientFor(t, { baseUrl, libraryId: status.libraryId }, { cached: true });
  const form = new FormData(); form.append('file', new Blob([sample], { type: 'application/pdf' }), 'original-example.pdf');
  const { document: doc } = await (await fetch(`${baseUrl}/api/documents`, { method: 'POST', body: form })).json();
  const sessionId = randomUUID();
  const session = selection => ({ documentId: doc.id, page: 1, selection, notesDirty: false, visible: true });
  let resource;

  await t.test('initialization discovers the exact tool set, read/write hints and UI resource', async () => {
    assert.equal(client.getServerVersion().name, 'paperdesk');
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['paperdesk_status', 'paperdesk_list_documents', 'paperdesk_open_reader', 'paperdesk_read_page', 'paperdesk_get_context', 'paperdesk_get_notes', 'paperdesk_append_note', 'paperdesk_export_notes', 'paperdesk_reader_page', 'paperdesk_reader_get_notes', 'paperdesk_reader_save_notes', 'paperdesk_reader_toc', 'paperdesk_reader_session', 'paperdesk_reader_close', 'paperdesk_reader_chatgpt_submit', 'paperdesk_reader_chatgpt_get', 'paperdesk_reader_chatgpt_resume'].sort());
    assert.equal(tools.filter(tool => tool.name.startsWith('paperdesk_reader_')).length, 9);
    assert.equal(client.getServerVersion().version, '0.5.0');
    assert.equal(READER_RESOURCE, 'ui://paperdesk/reader-v5.html');
    for (const name of ['submit', 'resume', 'get']) {
      const tool = tools.find(tool => tool.name === `paperdesk_reader_chatgpt_${name}`);
      assert.equal(tool.annotations.readOnlyHint, name === 'get');
    }
    assert.equal(tools.find(tool => tool.name === 'paperdesk_append_note').annotations.readOnlyHint, false);
    assert.equal(tools.find(tool => tool.name === 'paperdesk_get_notes').annotations.readOnlyHint, true);
    const open = tools.find(tool => tool.name === 'paperdesk_open_reader');
    assert.deepEqual(open._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
    assert.equal(open._meta.ui.resourceUri, READER_RESOURCE);
    assert.equal((await client.listResources()).resources[0].uri, READER_RESOURCE);
    resource = (await client.readResource({ uri: READER_RESOURCE })).contents[0];
    assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
    assert.deepEqual(resource._meta.ui.csp, { frameDomains: [], resourceDomains: [], connectDomains: [] });
    assert.ok(!/<iframe\b|fetch\(/.test(resource.text), 'Native component must not embed or fetch a loopback website');
    for (const tool of tools.filter(tool => tool.name.startsWith('paperdesk_reader_'))) {
      assert.deepEqual(tool._meta.ui.visibility, ['app']);
      assert.equal(tool._meta['openai/widgetAccessible'], true);
    }
    assert.ok(resource.text.includes(baseUrl));
    assert.ok(!resource.text.includes(root), 'resource must not expose workspace filesystem paths');
    assert.equal(value(await call(client, 'paperdesk_status')).libraryId, status.libraryId);
  });
  await t.test('list/open/export return only metadata or exact local links', async () => {
    await api(`/api/documents/${doc.id}`, { notesZh: 'PRIVATE 中文笔记', notesEn: 'PRIVATE English note' }, 'PATCH');
    const listing = await call(client, 'paperdesk_list_documents');
    assert.equal(value(listing).documents[0].id, doc.id);
    assert.ok(!JSON.stringify(listing).includes('PRIVATE'));
    assert.ok(!Object.hasOwn(value(listing).documents[0], 'notesZh'));
    assert.equal(value(await call(client, 'paperdesk_open_reader')).url, `${baseUrl}/`);
    const opened = value(await call(client, 'paperdesk_open_reader', { documentId: doc.id, page: 2 }));
    assert.equal(opened.url, `${baseUrl}/?document=${doc.id}&page=2`);
    assert.ok(!JSON.stringify(opened).includes('PRIVATE'));
    const exported = value(await call(client, 'paperdesk_export_notes', { documentId: doc.id }));
    assert.equal(exported.url, `${baseUrl}/api/documents/${doc.id}/export`);
    assert.match(await (await fetch(exported.url)).text(), /PRIVATE 中文笔记/);
  });
  await t.test('single page extraction is bounded and invalid schemas cannot widen it', async () => {
    const full = await api(`/api/documents/${doc.id}/pages/1`);
    const first = value(await call(client, 'paperdesk_read_page', { documentId: doc.id, page: 1, limit: 10 }));
    assert.equal(first.text, full.text.slice(0, 10)); assert.equal(first.nextOffset, 10);
    const next = value(await call(client, 'paperdesk_read_page', { documentId: doc.id, page: 1, offset: first.nextOffset, limit: 10 }));
    assert.equal(next.text, full.text.slice(10, 20));
    for (const args of [{ documentId: doc.id, page: 1, limit: 12001 }, { documentId: '../secrets', page: 1 }, { documentId: doc.id, page: 1, allPages: true }]) {
      assert.equal((await call(client, 'paperdesk_read_page', args)).isError, true);
    }
  });
  await t.test('context never contains unshared screenshots/notes and returns shared PNG as an image block', async () => {
    assert.equal((await call(client, 'paperdesk_get_context')).isError, true);
    await api(`/api/reader-sessions/${sessionId}`, session(null));
    const empty = await call(client, 'paperdesk_get_context', { sessionId });
    assert.equal(value(empty).selection, null); assert.equal(empty.content.length, 1);
    assert.ok(!JSON.stringify(empty).includes('PRIVATE'));
    const preview = pngPreview();
    await api(`/api/reader-sessions/${sessionId}`, session({ kind: 'region', text: '', rects: [rect], preview }));
    const shared = await call(client, 'paperdesk_get_context', { sessionId });
    assert.equal(value(shared).selection.kind, 'region');
    assert.deepEqual(shared.content[1], { type: 'image', mimeType: 'image/png', data: preview.split(',')[1] });
    assert.ok(!JSON.stringify(shared.structuredContent).includes('base64'));
    assert.ok(!shared.content[0].text.includes(preview.split(',')[1]));
    await api(`/api/reader-sessions/${sessionId}`, session(null));
    assert.equal((await call(client, 'paperdesk_get_context', { sessionId })).content.length, 1);
  });
  await t.test('multiple tabs require explicit session identity', async () => {
    const second = randomUUID(); await api(`/api/reader-sessions/${second}`, session(null));
    const ambiguous = await call(client, 'paperdesk_get_context');
    assert.equal(ambiguous.isError, true); assert.equal(ambiguous.structuredContent.status, 409);
    assert.equal(ambiguous.structuredContent.sessions.length, 2);
    assert.equal(value(await call(client, 'paperdesk_get_context', { sessionId })).sessionId, sessionId);
    await fetch(`${baseUrl}/api/reader-sessions/${second}`, { method: 'DELETE' });
  });
  await t.test('single notes preserve legacy content and append is revision guarded and idempotent', async () => {
    const notes = value(await call(client, 'paperdesk_get_notes', { documentId: doc.id }));
    assert.equal(notes.notes, 'PRIVATE 中文笔记\n\n---\n\nPRIVATE English note');
    const args = { documentId: doc.id, text: 'Explicitly requested saved answer.', page: 2, expectedNotesRevision: notes.notesRevision, requestId: randomUUID() };
    await api(`/api/reader-sessions/${sessionId}`, { ...session(null), notesDirty: true });
    const dirty = await call(client, 'paperdesk_append_note', args);
    assert.equal(dirty.isError, true); assert.equal(dirty.structuredContent.status, 409);
    await api(`/api/reader-sessions/${sessionId}`, session(null));
    const appended = value(await call(client, 'paperdesk_append_note', args)); assert.equal(appended.appended, true);
    assert.ok(!JSON.stringify(appended).includes('PRIVATE'), 'write receipt must not repeat complete notes');
    assert.equal(value(await call(client, 'paperdesk_append_note', args)).appended, false);
    const conflict = await call(client, 'paperdesk_append_note', { ...args, requestId: randomUUID() });
    assert.equal(conflict.isError, true); assert.equal(conflict.structuredContent.status, 409);
    const saved = value(await call(client, 'paperdesk_get_notes', { documentId: doc.id }));
    assert.equal(saved.notes.split('Explicitly requested saved answer.').length, 2);
    assert.ok(saved.notes.includes('### 第 2 页\n\nExplicitly requested saved answer.'));
    assert.notEqual(saved.notesRevision, notes.notesRevision);
  });
  await t.test('native display data stays private and app sessions/notes use the real SDK', async () => {
    const rendered = await call(client, 'paperdesk_reader_page', { documentId: doc.id, page: 2, width: 1200 });
    assert.deepEqual(value(rendered), { ok: true });
    const image = rendered._meta.readerPage;
    assert.equal(image.documentId, doc.id); assert.equal(image.page, 2);
    assert.equal(image.mimeType, 'image/png');
    assert.ok(Buffer.from(image.image, 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    assert.ok(image.width > 0 && image.width <= 1600 && image.height > 0 && image.height <= 2400);
    assert.ok(image.text.length > 0);
    assert.ok(!JSON.stringify({ content: rendered.content, structuredContent: rendered.structuredContent }).includes(image.image));
    const notesResult = await call(client, 'paperdesk_reader_get_notes', { documentId: doc.id });
    assert.ok(notesResult._meta.notes.notes.includes('PRIVATE'));
    assert.ok(!JSON.stringify({ content: notesResult.content, structuredContent: notesResult.structuredContent }).includes('PRIVATE'));
    const toc = await call(client, 'paperdesk_reader_toc', { documentId: doc.id });
    assert.deepEqual(value(toc), { ok: true }); assert.ok(Array.isArray(toc._meta.toc.entries));
    const saved = await call(client, 'paperdesk_reader_save_notes', {
      documentId: doc.id, notes: 'MANUAL native note', expectedNotesRevision: notesResult._meta.notes.notesRevision,
    });
    assert.equal(saved._meta.notes.notes, 'MANUAL native note');
    assert.ok(!JSON.stringify({ content: saved.content, structuredContent: saved.structuredContent }).includes('MANUAL'));
    const conflict = await call(client, 'paperdesk_reader_save_notes', {
      documentId: doc.id, notes: 'STALE replacement', expectedNotesRevision: notesResult._meta.notes.notesRevision,
    });
    assert.equal(conflict.isError, true); assert.equal(conflict.structuredContent.status, 409);
    assert.equal((await api(`/api/documents/${doc.id}`)).document.notesZh, 'MANUAL native note');
    const nativeId = randomUUID();
    const args = { sessionId: nativeId, ...session(null) };
    const receipt = await call(client, 'paperdesk_reader_session', args);
    assert.equal(receipt._meta.session.sessionId, nativeId);
    assert.ok(!JSON.stringify(receipt).includes('MANUAL'));
    assert.equal(value(await call(client, 'paperdesk_get_context', { sessionId: nativeId })).selection, null);
    await call(client, 'paperdesk_reader_session', { ...args, selection: { kind: 'text', text: 'Explicit text excerpt', rects: [] } });
    const shared = value(await call(client, 'paperdesk_get_context', { sessionId: nativeId }));
    assert.equal(shared.selection.text, 'Explicit text excerpt'); assert.deepEqual(shared.selection.rects, []);
    assert.equal((await call(client, 'paperdesk_reader_session', { ...args, selection: { kind: 'region', text: '', rects: [] } })).isError, true);
    value(await call(client, 'paperdesk_reader_close', { sessionId: nativeId }));
    assert.equal((await call(client, 'paperdesk_get_context', { sessionId: nativeId })).isError, true);
  });
  await t.test('automatic ChatGPT tools expose only private job receipts and preserve frozen selection/idempotency', async () => {
    const before = (await api(`/api/documents/${doc.id}`)).document;
    const privateReceipt = result => {
      assert.deepEqual(value(result), { ok: true });
      assert.ok(result._meta.chatgptJob);
      assert.doesNotMatch(JSON.stringify({ content: result.content, structuredContent: result.structuredContent }), /PRIVATE|selected fragment|data:image|original-example/);
      for (const key of ['selection', 'question', 'preview', 'digest', 'notes', 'notesZh', 'notesEn']) assert.equal(Object.hasOwn(result._meta.chatgptJob, key), false);
      return result._meta.chatgptJob;
    };
    const waitForState = async (id, state) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const job = privateReceipt(await call(client, 'paperdesk_reader_chatgpt_get', { jobId: id }));
        if (job.state === state && (state !== 'needs_user' || job.canResume)) return job;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail(`Simulated job did not reach ${state}`);
    };
    const body = { requestId: randomUUID(), documentId: doc.id, page: 1, question: 'PRIVATE_SHORT_QUESTION', selection: { kind: 'text', text: 'selected fragment' } };
    assert.equal(privateReceipt(await call(client, 'paperdesk_reader_chatgpt_submit', body)).id, body.requestId);
    const completed = await waitForState(body.requestId, 'completed');
    assert.equal(completed.response, 'PRIVATE_SIMULATED_REPLY:PRIVATE_SHORT_QUESTION');
    privateReceipt(await call(client, 'paperdesk_reader_chatgpt_submit', body));
    assert.equal(chatgptRuns.filter(run => run.job.id === body.requestId).length, 1);
    assert.deepEqual(chatgptRuns.find(run => run.job.id === body.requestId).job.selection, body.selection);
    assert.equal((await call(client, 'paperdesk_reader_chatgpt_submit', { ...body, question: 'Different payload' })).structuredContent.status, 409);
    assert.equal((await call(client, 'paperdesk_reader_chatgpt_submit', { ...body, requestId: randomUUID(), notes: 'must not be accepted' })).isError, true);
    const imageBody = { ...body, requestId: randomUUID(), selection: { kind: 'region', text: '', preview: pngPreview() } };
    privateReceipt(await call(client, 'paperdesk_reader_chatgpt_submit', imageBody));
    await waitForState(imageBody.requestId, 'needs_user');
    assert.equal(chatgptRuns.filter(run => run.job.id === imageBody.requestId).length, 1);
    privateReceipt(await call(client, 'paperdesk_reader_chatgpt_resume', { jobId: imageBody.requestId }));
    await waitForState(imageBody.requestId, 'completed');
    const imageRuns = chatgptRuns.filter(run => run.job.id === imageBody.requestId);
    assert.deepEqual(imageRuns.map(run => run.resume), [false, true]);
    assert.deepEqual(imageRuns[1].job.selection, imageBody.selection);
    const after = (await api(`/api/documents/${doc.id}`)).document;
    assert.equal(after.notesRevision, before.notesRevision); assert.equal(after.notesZh, before.notesZh);
  });
});

test('each operation rejects another service/library before requesting private endpoints', async t => {
  let identity = { service: 'paperdesk', apiVersion: 1, instanceId: randomUUID(), libraryId };
  const privatePaths = [];
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/plugin/status') return res.end(JSON.stringify(identity));
    privatePaths.push(req.url); res.end(JSON.stringify({ documents: [] }));
  });
  const baseUrl = await listen(server); t.after(() => stop(server));
  const client = await clientFor(t, { baseUrl, libraryId });
  identity.service = 'other-service';
  assert.equal((await call(client, 'paperdesk_list_documents')).isError, true);
  identity.service = 'paperdesk'; identity.libraryId = 'b'.repeat(64);
  assert.equal((await call(client, 'paperdesk_get_notes', { documentId })).isError, true);
  identity.libraryId = libraryId;
  assert.equal(value(await call(client, 'paperdesk_status')).service, 'paperdesk');
  identity.libraryId = 'b'.repeat(64);
  assert.equal((await call(client, 'paperdesk_append_note', { documentId, text: 'do not write', expectedNotesRevision: 'c'.repeat(64), requestId: randomUUID() })).isError, true);
  assert.equal((await call(client, 'paperdesk_reader_page', { documentId, page: 1 })).isError, true);
  assert.equal((await call(client, 'paperdesk_reader_save_notes', { documentId, notes: 'do not write', expectedNotesRevision: 'c'.repeat(64) })).isError, true);
  assert.equal((await call(client, 'paperdesk_reader_chatgpt_submit', { requestId: randomUUID(), documentId, page: 1, question: 'do not send', selection: { kind: 'text', text: 'private' } })).isError, true);
  assert.equal((await call(client, 'paperdesk_reader_chatgpt_get', { jobId: randomUUID() })).isError, true);
  assert.equal((await call(client, 'paperdesk_reader_chatgpt_resume', { jobId: randomUUID() })).isError, true);
  await assert.rejects(client.readResource({ uri: READER_RESOURCE }));
  assert.deepEqual(privatePaths, []);
});

test('tiny text windows advance across astral characters without splitting them', async t => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/plugin/status'
      ? { service: 'paperdesk', apiVersion: 1, instanceId: randomUUID(), libraryId }
      : { documentId, page: 1, text: '😀文𠮷', textAvailable: true }));
  });
  const baseUrl = await listen(server); t.after(() => stop(server));
  const client = await clientFor(t, { baseUrl, libraryId });
  let offset = 0, combined = '';
  do {
    const part = value(await call(client, 'paperdesk_read_page', { documentId, page: 1, limit: 1, offset }));
    assert.ok(part.text.length > 0);
    assert.ok(part.nextOffset === null || part.nextOffset > offset);
    combined += part.text; offset = part.nextOffset;
  } while (offset !== null);
  assert.equal(combined, '😀文𠮷');
});
