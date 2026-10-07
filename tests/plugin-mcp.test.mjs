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

test('ordinary ChatGPT handoff and browser bridges are absent from active entry points', async () => {
  const removed = /chatgpt-(?:handoff|jobs|browser|ego|native-login)|paperdesk_reader_chatgpt_|\/api\/chatgpt|https:\/\/chatgpt\.com|交给 ChatGPT|向 ChatGPT 提问|手动备用方式/;
  for (const file of ['src/App.jsx', 'server/app.mjs', 'server/index.mjs', 'server/mcp.mjs', 'scripts/setup-plugin.mjs', 'plugins/paperdesk/ui/reader.html']) {
    assert.doesNotMatch(await readFile(join(root, file), 'utf8'), removed, `${file} must not expose or load the removed ordinary ChatGPT feature`);
  }
});

test('cached plugin uses real stdio SDK protocol with the isolated local API', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'paperdesk-plugin-library-'));
  const runtime = createApp({ dataDir });
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
    assert.equal(client.getServerVersion().version, '0.10.0');
    assert.equal(READER_RESOURCE, 'ui://paperdesk/reader-v10.html');
    for (const file of ['plugins/paperdesk/plugin.json', 'plugins/paperdesk/.codex-plugin/plugin.json']) {
      assert.equal(JSON.parse(await readFile(join(root, file), 'utf8')).version, '0.10.0');
    }
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['paperdesk_status', 'paperdesk_list_documents', 'paperdesk_open_reader', 'paperdesk_read_page', 'paperdesk_get_context', 'paperdesk_get_notes', 'paperdesk_append_note', 'paperdesk_export_notes', 'paperdesk_reader_page', 'paperdesk_reader_get_notes', 'paperdesk_reader_save_notes', 'paperdesk_reader_toc', 'paperdesk_reader_session', 'paperdesk_reader_close', 'paperdesk_reader_library', 'paperdesk_reader_organize', 'paperdesk_reader_theme', 'paperdesk_reader_translation'].sort());
    assert.equal(tools.filter(tool => tool.name.startsWith('paperdesk_reader_')).length, 10);
    assert.equal(tools.find(tool => tool.name === 'paperdesk_append_note').annotations.readOnlyHint, false);
    assert.equal(tools.find(tool => tool.name === 'paperdesk_get_notes').annotations.readOnlyHint, true);
    const open = tools.find(tool => tool.name === 'paperdesk_open_reader');
    assert.deepEqual(open._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
    assert.equal(open._meta.ui.resourceUri, READER_RESOURCE);
    assert.equal((await client.listResources()).resources[0].uri, READER_RESOURCE);
    resource = (await client.readResource({ uri: READER_RESOURCE })).contents[0];
    assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
    assert.deepEqual(resource._meta.ui.csp, { frameDomains: [], resourceDomains: [], connectDomains: [] });
    assert.deepEqual(resource._meta['openai/widgetCSP'].redirect_domains, [baseUrl]);
    assert.doesNotMatch(resource.text, /paperdesk_reader_chatgpt_|\/api\/chatgpt|https:\/\/chatgpt\.com|交给 ChatGPT|向 ChatGPT 提问|手动备用方式/);
    assert.ok(!/<iframe\b|fetch\(/.test(resource.text), 'Native component must not embed or fetch a loopback website');
    for (const tool of tools.filter(tool => tool.name.startsWith('paperdesk_reader_'))) {
      assert.deepEqual(tool._meta.ui.visibility, ['app']);
      assert.equal(tool._meta['openai/widgetAccessible'], true);
    }
    assert.ok(resource.text.includes(baseUrl));
    assert.ok(!resource.text.includes(root), 'resource must not expose workspace filesystem paths');
    assert.equal(value(await call(client, 'paperdesk_status')).libraryId, status.libraryId);
  });
  await t.test('removed ordinary ChatGPT endpoints cannot accept jobs or expose a connection service', async () => {
    const missing = [
      await fetch(`${baseUrl}/api/chatgpt/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
      await fetch(`${baseUrl}/api/chatgpt/connection`),
      await fetch(`${baseUrl}/api/chatgpt/jobs/${randomUUID()}`),
    ];
    for (const response of missing) assert.equal(response.status, 404);
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
  await t.test('folder organization and themes use only private UI metadata and preserve notes', async () => {
    const before = (await api(`/api/documents/${doc.id}`)).document;
    const initial = await call(client, 'paperdesk_reader_library');
    assert.equal(initial._meta.library.theme, 'forest');
    const created = await call(client, 'paperdesk_reader_organize', { operation: 'create', name: 'PRIVATE_FOLDER' });
    assert.notEqual(created.isError, true);
    assert.ok(!JSON.stringify({ content: created.content, structuredContent: created.structuredContent }).includes('PRIVATE_FOLDER'));
    const folder = created._meta.library.folders.find(item => item.name === 'PRIVATE_FOLDER');
    assert.ok(folder);
    await call(client, 'paperdesk_reader_organize', { operation: 'move', documentId: doc.id, folderId: folder.id });
    const moved = (await api(`/api/documents/${doc.id}`)).document;
    assert.equal(moved.folderId, folder.id);
    assert.equal(moved.notesZh, before.notesZh);
    assert.equal(moved.notesEn, before.notesEn);
    assert.equal(moved.notesRevision, before.notesRevision);
    assert.equal(moved.lastPage, before.lastPage);
    assert.equal(value(await call(client, 'paperdesk_list_documents')).documents.find(item => item.id === doc.id).folderId, folder.id);
    const renamed = await call(client, 'paperdesk_reader_organize', { operation: 'rename', folderId: folder.id, name: 'PRIVATE_RENAMED' });
    assert.equal(renamed._meta.library.folders.find(item => item.id === folder.id).name, 'PRIVATE_RENAMED');
    for (const theme of ['sand', 'slate', 'night', 'forest']) {
      const result = await call(client, 'paperdesk_reader_theme', { theme });
      assert.notEqual(result.isError, true);
      assert.equal(result._meta.library.theme, theme);
      assert.deepEqual(result.structuredContent, { ok: true });
    }
    assert.equal((await call(client, 'paperdesk_reader_theme', { theme: 'remote-skin' })).isError, true);
    for (const args of [
      { operation: 'remove', folderId: null }, { operation: 'rename', folderId: folder.id },
      { operation: 'move', documentId: doc.id }, { operation: 'create', name: 'unwanted', documentId: doc.id },
    ]) assert.equal((await call(client, 'paperdesk_reader_organize', args)).isError, true);
    const removed = await call(client, 'paperdesk_reader_organize', { operation: 'remove', folderId: folder.id });
    assert.notEqual(removed.isError, true);
    assert.ok(removed._meta.library.folders.every(item => item.id !== folder.id));
    const after = (await api(`/api/documents/${doc.id}`)).document;
    assert.equal(after.folderId, null);
    assert.equal(after.notesRevision, before.notesRevision);
    assert.equal(after.notesZh, before.notesZh);
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
  assert.equal((await call(client, 'paperdesk_reader_library')).isError, true);
  assert.equal((await call(client, 'paperdesk_reader_organize', { operation: 'create', name: 'do not create' })).isError, true);
  assert.equal((await call(client, 'paperdesk_reader_theme', { theme: 'night' })).isError, true);
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

test('translation adapter is app-only, maps strict operations and never exposes private data to model content', async t => {
  const secret = 'TEST_ONLY_KEY_8fe1', account = 'TEST_ONLY_ACCOUNT_7', quote = 'PRIVATE_TRANSLATION_QUOTE';
  const defaults = { configured: false, appIdHint: '', tier: 'standard', monthlyLimit: 50000, month: '2026-10', usedCharacters: 0, remainingCharacters: 50000, maxCharacters: 1000, maxBytes: 6000 };
  const profiles = Object.fromEntries(['baidu', 'azure', 'deepl', 'openai-compatible'].map(provider => [provider, { ...defaults, provider }])); let activeProvider = 'baidu';
  const received = []; let fail = false;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/plugin/status') { response.end(JSON.stringify({ service: 'paperdesk', apiVersion: 1, instanceId: 'test', libraryId })); return; }
    received.push({ path: request.url, method: request.method, body });
    if (fail) { response.statusCode = 502; response.end(JSON.stringify({ error: `${secret} ${quote} upstream private failure` })); return; }
    const url = new URL(request.url, 'http://localhost');
    const selected = body?.provider || url.searchParams.get('provider') || activeProvider;
    if (url.pathname === '/api/translation/settings') {
      if (request.method === 'PUT') { profiles[selected] = { ...profiles[selected], configured: true, appIdHint: 'TEST…7', tier: body.tier || 'standard', monthlyLimit: body.monthlyLimit, endpoint: body.endpoint, region: body.region, model: body.model }; activeProvider = selected; }
      if (request.method === 'DELETE') profiles[selected] = { ...profiles[selected], configured: false, appIdHint: '' };
      const settings = { ...profiles[selected], activeProvider };
      // Deliberately include unexpected private fields: the adapter must pick
      // only the published masked settings, not forward arbitrary API extras.
      response.end(JSON.stringify({ settings: { ...settings, apiKey: secret, appId: account } })); return;
    }
    if (request.url === '/api/translation' && request.method === 'POST') {
      response.end(JSON.stringify({ translation: { provider: activeProvider, translatedText: 'PRIVATE_RESULT', from: body.from, to: body.to, cached: false, characters: [...body.text].length, unexpectedSecret: secret }, settings: { ...profiles[activeProvider], activeProvider } })); return;
    }
    response.statusCode = 404; response.end('{}');
  });
  const baseUrl = await listen(server); t.after(() => stop(server));
  const client = await clientFor(t, { baseUrl, libraryId });
  const item = (await client.listTools()).tools.find(tool => tool.name === 'paperdesk_reader_translation');
  assert.deepEqual(item._meta.ui.visibility, ['app']); assert.equal(item._meta['openai/visibility'], 'private');
  assert.equal(item.annotations.readOnlyHint, false); assert.equal(item.annotations.openWorldHint, true); assert.equal(item.annotations.idempotentHint, false);
  const uiOnly = result => {
    assert.equal(result.structuredContent, undefined);
    assert.doesNotMatch(JSON.stringify(result.content), /TEST_ONLY|PRIVATE_TRANSLATION|PRIVATE_RESULT|upstream/);
    assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes(account));
    return result;
  };
  const status = uiOnly(await call(client, item.name, { operation: 'status' })); assert.equal(status._meta.translationSettings.configured, false);
  const configured = uiOnly(await call(client, item.name, { operation: 'configure', appId: account, apiKey: secret, tier: 'standard', monthlyLimit: 40000 }));
  assert.equal(configured._meta.translationSettings.configured, true);
  assert.deepEqual(received.at(-1), { path: '/api/translation/settings', method: 'PUT', body: { appId: account, apiKey: secret, tier: 'standard', monthlyLimit: 40000 } });
  assert.equal(received.some(request => request.path === '/api/translation'), false, 'Saving settings must not translate or probe the provider');
  await call(client, item.name, { operation: 'configure', tier: 'advanced', monthlyLimit: 50000 });
  assert.deepEqual(received.at(-1).body, { tier: 'advanced', monthlyLimit: 50000 }, 'Omitted credentials stay omitted');
  const result = uiOnly(await call(client, item.name, { operation: 'translate', text: quote, from: 'en', to: 'zh' }));
  assert.equal(result._meta.translation.translatedText, 'PRIVATE_RESULT'); assert.equal(result._meta.translation.unexpectedSecret, undefined);
  assert.deepEqual(received.at(-1), { path: '/api/translation', method: 'POST', body: { text: quote, from: 'en', to: 'zh' } });
  fail = true;
  const failed = uiOnly(await call(client, item.name, { operation: 'translate', text: quote, from: 'auto', to: 'zh' }));
  assert.equal(failed.isError, true); assert.equal(failed._meta.translation.status, 502); assert.match(failed._meta.translation.error, /未完成/);
  fail = false;
  assert.equal(uiOnly(await call(client, item.name, { operation: 'status' }))._meta.translationSettings.configured, true);
  assert.equal(uiOnly(await call(client, item.name, { operation: 'clear' }))._meta.translationSettings.configured, false);
  assert.deepEqual(received.at(-1), { path: '/api/translation/settings', method: 'DELETE', body: undefined });
  const azureBody = { provider: 'azure', apiKey: secret, endpoint: 'https://api.cognitive.microsofttranslator.com/translate', region: 'eastasia', monthlyLimit: 2000000 };
  const azure = uiOnly(await call(client, item.name, { operation: 'configure', ...azureBody }));
  assert.equal(azure._meta.translationSettings.activeProvider, 'azure'); assert.equal(azure._meta.translationSettings.region, 'eastasia');
  assert.deepEqual(received.at(-1), { path: '/api/translation/settings', method: 'PUT', body: azureBody });
  const baiduProfile = uiOnly(await call(client, item.name, { operation: 'status', provider: 'baidu' }));
  assert.equal(baiduProfile._meta.translationSettings.provider, 'baidu'); assert.equal(baiduProfile._meta.translationSettings.activeProvider, 'azure');
  assert.equal(received.at(-1).path, '/api/translation/settings?provider=baidu');
  await call(client, item.name, { operation: 'configure', provider: 'deepl', apiKey: secret, endpoint: 'https://api-free.deepl.com/v2/translate', monthlyLimit: 50000 });
  const customBody = { provider: 'openai-compatible', apiKey: secret.repeat(60), endpoint: 'https://translator.example.invalid/v1/chat/completions', model: 'vendor/actual-model-name', monthlyLimit: 75000 };
  const custom = uiOnly(await call(client, item.name, { operation: 'configure', ...customBody }));
  assert.notEqual(custom.isError, true); assert.equal(custom._meta.translationSettings.model, customBody.model); assert.equal(custom._meta.translationSettings.endpoint, customBody.endpoint);
  assert.deepEqual(received.at(-1).body, customBody); assert.equal(custom._meta.translationSettings.activeProvider, 'openai-compatible');
  const customResult = uiOnly(await call(client, item.name, { operation: 'translate', text: quote, from: 'auto', to: 'en' }));
  assert.equal(customResult._meta.translation.provider, 'openai-compatible');
  await call(client, item.name, { operation: 'clear', provider: 'azure' }); assert.equal(received.at(-1).path, '/api/translation/settings?provider=azure');
  assert.equal((await call(client, item.name, { operation: 'status', provider: 'deepl' }))._meta.translationSettings.configured, true);
  const count = received.length;
  for (const args of [{ operation: 'status', apiKey: secret }, { operation: 'translate', text: quote }, { operation: 'configure', tier: 'standard' }, { operation: 'clear', extra: secret }, { operation: 'status', provider: secret }, { operation: 'translate', text: quote, from: 'auto', to: 'zh', endpoint: 'https://wrong.example.invalid' }]) {
    const invalid = await call(client, item.name, args); assert.equal(invalid.isError, true); assert.ok(!JSON.stringify(invalid).includes(secret));
  }
  assert.equal(received.length, count, 'Invalid operation arguments must not reach the service');
});

test('translation test forwards only candidate settings and returns finite private diagnostics without saving', async t => {
  const secret = 'UNSAVED_TEST_SECRET', sample = 'Hello, Paperdesk.', received = [];
  let failureCategory, malformed = false;
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/plugin/status') { response.end(JSON.stringify({ service: 'paperdesk', apiVersion: 1, instanceId: 'test', libraryId })); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    received.push({ path: request.url, method: request.method, body });
    if (failureCategory) { response.statusCode = 502; response.end(JSON.stringify({ error: `${secret} PRIVATE_UPSTREAM_BODY`, category: failureCategory })); return; }
    response.end(JSON.stringify({ test: { provider: body.provider, sourceText: malformed ? 'PRIVATE_SOURCE' : sample, translatedText: 'PRIVATE_TEST_RESULT', characters: [...sample].length, elapsedMs: 25, apiKey: secret }, settings: { apiKey: secret } }));
  });
  const baseUrl = await listen(server); t.after(() => stop(server));
  const client = await clientFor(t, { baseUrl, libraryId });
  const toolName = 'paperdesk_reader_translation';
  const onlyPrivate = result => {
    assert.equal(result.structuredContent, undefined);
    assert.doesNotMatch(JSON.stringify(result.content), /PRIVATE|Hello|UNSAVED/);
    assert.doesNotMatch(JSON.stringify(result), /UNSAVED_TEST_SECRET|PRIVATE_UPSTREAM_BODY/);
    assert.equal(result._meta.translationSettings, undefined);
    assert.equal(result._meta.translation, undefined);
    return result._meta.translationTest;
  };
  const candidates = [
    { provider: 'baidu', appId: 'synthetic-account', apiKey: secret, tier: 'standard', monthlyLimit: 50000 },
    { provider: 'azure', apiKey: secret, endpoint: 'https://api.cognitive.microsofttranslator.com/translate', region: 'eastasia', monthlyLimit: 2000000 },
    { provider: 'deepl', endpoint: 'https://api-free.deepl.com/v2/translate', monthlyLimit: 50000 },
    { provider: 'openai-compatible', apiKey: secret, endpoint: 'https://test.example.invalid/v1/chat/completions', model: 'candidate-model', monthlyLimit: 50000 },
  ];
  for (const candidate of candidates) {
    const result = await call(client, toolName, { operation: 'test', ...candidate });
    assert.notEqual(result.isError, true);
    assert.deepEqual(onlyPrivate(result), { provider: candidate.provider, sourceText: sample, translatedText: 'PRIVATE_TEST_RESULT', characters: [...sample].length, elapsedMs: 25 });
    assert.deepEqual(received.at(-1), { path: '/api/translation/test', method: 'POST', body: candidate });
  }
  const count = received.length;
  for (const extra of [{ text: 'PRIVATE_ARBITRARY_TEXT' }, { from: 'en' }, { to: 'zh' }, { other: secret }]) {
    const result = await call(client, toolName, { operation: 'test', ...candidates[0], ...extra });
    assert.equal(result.isError, true); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ARBITRARY_TEXT|UNSAVED_TEST_SECRET/);
  }
  assert.equal(received.length, count, 'Test rejects arbitrary translation scope before any provider request');
  for (const category of ['authentication', 'quota', 'timeout', 'connection', 'configuration', 'response', 'changed', 'stopped', 'unknown', secret]) {
    failureCategory = category;
    const result = await call(client, toolName, { operation: 'test', ...candidates[0] });
    assert.equal(result.isError, true);
    const failure = onlyPrivate(result);
    assert.equal(failure.category, category === secret ? 'unknown' : category); assert.equal(failure.status, 502);
    assert.ok(failure.error.length > 0);
  }
  failureCategory = undefined; malformed = true;
  const result = await call(client, toolName, { operation: 'test', ...candidates[0] });
  assert.equal(result.isError, true); assert.equal(onlyPrivate(result).category, 'response');
  assert.ok(received.every(item => item.path === '/api/translation/test' && item.method === 'POST'), 'Tests never save, activate, clear or translate document text');
});
