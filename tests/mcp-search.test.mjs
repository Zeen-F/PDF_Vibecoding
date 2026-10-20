import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../server/app.mjs';
import { createPaperdeskMcpServer } from '../server/mcp.mjs';
import { validateSearchGrant, searchAllowed, searchPage } from '../server/mcp-search.mjs';

const id = '03096871-6d0e-42e0-9d63-ed0c7330ea11';
const grant = { documentIds: [id], sources: ['text'], expiresAt: new Date(Date.now() + 60000).toISOString() };
test('content grants deny implicit documents, private scopes, expired and malformed grants', () => {
  assert.equal(searchAllowed(undefined, [], ['title']), true);
  assert.equal(searchAllowed(undefined, [id], ['text']), false);
  assert.equal(searchAllowed(grant, [], ['text']), false);
  assert.equal(searchAllowed(grant, [id], ['notes']), false);
  assert.equal(searchAllowed(grant, [id], ['annotation']), false);
  assert.equal(searchAllowed(grant, [id], ['text']), true);
  assert.equal(searchAllowed(grant, [id], ['text'], Date.parse(grant.expiresAt)), false);
  for (const invalid of [{}, { ...grant, documentIds: ['*'] }, { ...grant, sources: ['all'] }, { ...grant, expiresAt: 'bad' }]) assert.throws(() => validateSearchGrant(invalid));
});
test('response UTF-8 budget, Unicode, geometry cap and resumable offsets', () => {
  const rows = Array.from({ length: 50 }, (_, index) => ({ documentId: id, title: '🙂'.repeat(500), pdfSha256: 'a'.repeat(64), page: index + 1, source: 'annotation', annotationId: id, snippet: '🙂'.repeat(500), rects: Array(200).fill({ x: .1, y: .2, width: .3, height: .4 }), private: 'SECRET' }));
  let offset = 0;
  while (offset < rows.length) {
    const page = searchPage(rows.slice(offset), { offset, limit: 50, maxBytes: 4096, libraryId: 'b'.repeat(64), hasMore: false });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4096);
    assert.ok(page.results.length > 0);
    assert.equal(page.results[0].rects.length, 8);
    assert.equal(page.results[0].rectsTruncated, true);
    assert.doesNotMatch(JSON.stringify(page), /SECRET|\\ud[89ab][0-9a-f]{2}/i);
    offset += page.results.length;
    assert.equal(page.nextOffset, offset < rows.length ? offset : null);
  }
});
test('oversized or malformed backend items cannot create nonadvancing continuation tokens', () => {
  const row = { documentId: id, title: 'title', pdfSha256: 'a'.repeat(64), page: 1, source: 'annotation', annotationId: id, snippet: 'body', rects: [{ x: 0, y: 0, width: .5, height: .5 }] };
  const options = { offset: 7, limit: 1, maxBytes: 4096, libraryId: 'b'.repeat(64), hasMore: true };
  assert.throws(() => searchPage([row], { ...options, maxBytes: 10 }), /budget/);
  assert.throws(() => searchPage([{ ...row, documentId: 'x'.repeat(20000) }], options), /identity/);
  for (const x of ['x'.repeat(20000), Infinity, NaN, -1, 2]) {
    assert.throws(() => searchPage([{ ...row, rects: [{ x, y: 0, width: .5, height: .5 }] }], options), /geometry/);
  }
});
test('real FTS MCP search denies ungranted content, rereads revocations, and separates source scopes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'paperdesk-mcp-search-'));
  const runtime = createApp({ dataDir: dir }); await runtime.ready;
  const http = runtime.app.listen(0, '127.0.0.1'); await once(http, 'listening');
  const baseUrl = `http://127.0.0.1:${http.address().port}`;
  const form = new FormData(); form.append('file', new Blob([await readFile(new URL('../public/examples/reading-demo.pdf', import.meta.url))]), 'private-fixture.pdf');
  const { document } = await (await fetch(`${baseUrl}/api/documents`, { method: 'POST', body: form })).json();
  await fetch(`${baseUrl}/api/documents/${document.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notesZh: 'PRIVATE_SEARCH_MARKER', notesEn: '' }) });
  const { libraryId } = await (await fetch(`${baseUrl}/api/plugin/status`)).json();
  let profile = { baseUrl, libraryId };
  const server = createPaperdeskMcpServer(profile, { readProfile: async () => profile });
  const client = new Client({ name: 'search-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  const call = args => client.callTool({ name: 'paperdesk_search_library', arguments: args });
  const titles = await call({ query: 'PRIVATE_SEARCH_MARKER' });
  assert.deepEqual(titles.structuredContent.results, []);
  assert.doesNotMatch(JSON.stringify(titles), /PRIVATE_SEARCH_MARKER/);
  assert.equal((await call({ query: '相位裕度', sources: ['text'], documentIds: [document.id] })).isError, true);
  profile = { ...profile, searchGrant: { documentIds: [document.id], sources: ['text'], expiresAt: new Date(Date.now() + 60000).toISOString() } };
  const pages = await call({ query: '相位裕度', sources: ['text'], documentIds: [document.id], limit: 1 });
  assert.notEqual(pages.isError, true);
  assert.equal(pages.structuredContent.results[0].source, 'text');
  assert.equal(pages.structuredContent.results[0].pdfSha256, document.pdfSha256);
  assert.equal(pages.structuredContent.results[0].documentId, document.id);
  assert.equal((await call({ query: 'PRIVATE_SEARCH_MARKER', sources: ['notes'], documentIds: [document.id] })).isError, true);
  assert.equal((await call({ query: '相位裕度', sources: ['text'] })).isError, true);
  assert.equal((await call({ query: '相位裕度', sources: ['text'], documentIds: [id] })).isError, true);
  profile.searchGrant.sources = ['notes'];
  const notes = await call({ query: 'PRIVATE_SEARCH_MARKER', sources: ['notes'], documentIds: [document.id] });
  assert.match(notes.structuredContent.results[0].snippet, /PRIVATE_SEARCH_MARKER/);
  assert.equal(notes.structuredContent.results[0].page, null, 'Document notes must not invent a physical page');
  profile.searchGrant.expiresAt = new Date(0).toISOString();
  assert.equal((await call({ query: 'PRIVATE_SEARCH_MARKER', sources: ['notes'], documentIds: [document.id] })).isError, true);
  delete profile.searchGrant;
  assert.equal((await call({ query: '相位裕度', sources: ['text'], documentIds: [document.id] })).isError, true);
  assert.equal((await client.listTools()).tools.find(tool => tool.name === 'paperdesk_search_library').annotations.readOnlyHint, true);
});
