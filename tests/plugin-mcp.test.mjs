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
import { runInNewContext } from 'node:vm';
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
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['paperdesk_status', 'paperdesk_list_documents', 'paperdesk_open_reader', 'paperdesk_read_page', 'paperdesk_get_context', 'paperdesk_get_notes', 'paperdesk_append_note', 'paperdesk_export_notes'].sort());
    assert.equal(tools.find(tool => tool.name === 'paperdesk_append_note').annotations.readOnlyHint, false);
    assert.equal(tools.find(tool => tool.name === 'paperdesk_get_notes').annotations.readOnlyHint, true);
    const open = tools.find(tool => tool.name === 'paperdesk_open_reader');
    assert.deepEqual(open._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
    assert.equal(open._meta.ui.resourceUri, READER_RESOURCE);
    assert.equal((await client.listResources()).resources[0].uri, READER_RESOURCE);
    resource = (await client.readResource({ uri: READER_RESOURCE })).contents[0];
    assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
    assert.deepEqual(resource._meta.ui.csp.frameDomains, [baseUrl]);
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

test('MCP wrapper validates message sources and sends only negotiated modalities', async () => {
  const baseUrl = 'http://127.0.0.1:4317';
  const html = (await readFile(new URL('../plugins/paperdesk/ui/reader.html', import.meta.url), 'utf8')).replace('__PAPERDESK_CONFIG__', JSON.stringify({ baseUrl }));
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const sent = [], handlers = {}, child = {}, parent = { postMessage(message) { sent.push(message); } };
  const nodes = Object.fromEntries(['reader', 'status', 'external', 'share'].map(name => [name, { contentWindow: child, addEventListener(type, fn) { this[type] = fn; } }]));
  const timers = new Set();
  runInNewContext(script, {
    window: { parent, addEventListener(type, fn) { handlers[type] = fn; } },
    document: { referrer: 'https://host.example/conversation', getElementById(id) { return nodes[id]; } },
    location: { protocol: 'https:', origin: 'https://app.example' }, crypto: { randomUUID }, URL, console,
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timers.add(timer); return timer; }, clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const reply = (message, result) => handlers.message({ source: parent, origin: 'https://host.example', data: { jsonrpc: '2.0', id: message.id, result } });
  try {
    const init = sent[0]; assert.equal(init.method, 'ui/initialize');
    reply(init, { hostCapabilities: { serverTools: {}, updateModelContext: { text: {} } } }); await flush();
    const sessionId = new URL(nodes.reader.src).searchParams.get('readerSession');
    assert.ok(sessionId); assert.equal(new URL(nodes.reader.src).searchParams.get('parentOrigin'), 'https://app.example');
    const notification = { type: 'paperdesk-context', context: { sessionId, sharedSelection: true, shareId: randomUUID() } };
    handlers.message({ source: child, origin: 'https://evil.example', data: notification });
    handlers.message({ source: {}, origin: baseUrl, data: notification });
    assert.equal(sent.filter(item => item.method === 'tools/call').length, 0);
    handlers.message({ source: child, origin: baseUrl, data: notification });
    handlers.message({ source: child, origin: baseUrl, data: notification });
    assert.equal(sent.filter(item => item.method === 'tools/call').length, 1, 'heartbeat must not trigger another tool call');
    const getContext = sent.find(item => item.method === 'tools/call');
    assert.equal(getContext.params.arguments.sessionId, sessionId);
    reply(getContext, { content: [{ type: 'text', text: 'selected' }, { type: 'image', data: 'png', mimeType: 'image/png' }], structuredContent: { selection: {} } }); await flush();
    const update = sent.find(item => item.method === 'ui/update-model-context');
    assert.deepEqual(JSON.parse(JSON.stringify(update.params)), { content: [{ type: 'text', text: 'selected' }] });
    handlers.message({ source: child, origin: baseUrl, data: { type: 'paperdesk-context', context: { sessionId, sharedSelection: false, shareId: null } } });
    assert.equal(sent.filter(item => item.method === 'ui/update-model-context').length, 1, 'clear waits for pending injection');
    reply(update, {}); await flush();
    const clear = sent.filter(item => item.method === 'ui/update-model-context')[1];
    assert.deepEqual(JSON.parse(JSON.stringify(clear.params)), { content: [] });
    reply(clear, {}); await flush();
    const original = nodes.reader.src;
    handlers.message({ source: {}, origin: 'https://host.example', data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { url: `${baseUrl}/?document=forged` } } } });
    assert.equal(nodes.reader.src, original);
    handlers.message({ source: parent, origin: 'https://host.example', data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { url: 'https://evil.example/' } } } });
    assert.equal(nodes.reader.src, original);
  } finally { for (const timer of timers) clearTimeout(timer); }
});

test('opaque-origin wrapper disables injection even when the host advertises full support', async () => {
  const baseUrl = 'http://127.0.0.1:4317';
  const html = (await readFile(new URL('../plugins/paperdesk/ui/reader.html', import.meta.url), 'utf8')).replace('__PAPERDESK_CONFIG__', JSON.stringify({ baseUrl }));
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const sent = [], handlers = {}, child = {}, parent = { postMessage(message) { sent.push(message); } };
  const nodes = Object.fromEntries(['reader', 'status', 'external', 'share'].map(name => [name, { contentWindow: child, addEventListener(type, fn) { this[type] = fn; } }]));
  const timers = new Set();
  runInNewContext(script, {
    window: { parent, addEventListener(type, fn) { handlers[type] = fn; } },
    document: { referrer: 'https://host.example/conversation', getElementById(id) { return nodes[id]; } },
    location: { protocol: 'https:', origin: 'null' }, crypto: { randomUUID }, URL, console,
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timers.add(timer); return timer; }, clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
  });
  try {
    handlers.message({ source: parent, origin: 'https://host.example', data: {
      jsonrpc: '2.0', id: sent[0].id, result: { hostCapabilities: { serverTools: {}, updateModelContext: { text: {}, image: {}, structuredContent: {} } } },
    } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(nodes.share.disabled, true);
    assert.match(nodes.status.textContent, /已停用上下文注入/);
    const url = new URL(nodes.reader.src);
    assert.equal(url.searchParams.has('parentOrigin'), false);
    handlers.message({ source: child, origin: baseUrl, data: { type: 'paperdesk-context', context: {
      sessionId: url.searchParams.get('readerSession'), sharedSelection: true, shareId: randomUUID(),
    } } });
    // Programmatic dispatch must not bypass the disabled button's guard.
    nodes.share.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.some(message => ['tools/call', 'ui/update-model-context'].includes(message.method)), false);
    assert.match(nodes.status.textContent, /普通工具读取共享选区/);
  } finally { for (const timer of timers) clearTimeout(timer); }
});
