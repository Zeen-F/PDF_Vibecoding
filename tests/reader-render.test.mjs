import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createApp } from '../server/app.mjs';
import { createReaderRenderer, readerPageText } from '../server/reader-render.mjs';
import { graphicsOnlyPdf } from './fixtures/scan-browser.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const samplePath = new URL('../public/examples/reading-demo.pdf', import.meta.url);

async function library(t) {
  const temp = await mkdtemp(path.join(tmpdir(), 'paperdesk-reader-render-'));
  const dataDir = path.join(temp, '.local', 'data');
  const runtime = createApp({ dataDir });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await runtime.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  });
  return {
    dataDir, base, runtime,
    async upload(bytes) {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'original-render-example.pdf');
      const response = await fetch(`${base}/api/documents`, { method: 'POST', body: form });
      assert.equal(response.status, 201);
      return (await response.json()).document;
    },
    async get(url) {
      const response = await fetch(`${base}${url}`);
      assert.equal(response.status, 200);
      return response.json();
    },
  };
}

function snapshot(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'paperdesk.sqlite'), { readOnly: true });
  try {
    return {
      version: db.prepare('PRAGMA user_version').get().user_version,
      documents: db.prepare('SELECT * FROM documents ORDER BY id').all(),
      pages: db.prepare('SELECT * FROM pages ORDER BY document_id, page').all(),
      annotations: db.prepare('SELECT * FROM annotations ORDER BY id').all(),
    };
  } finally { db.close(); }
}

async function inspectPng(result) {
  assert.equal(result.mimeType, 'image/png');
  assert.ok(Number.isInteger(result.width) && result.width > 0 && result.width <= 1600);
  assert.ok(Number.isInteger(result.height) && result.height > 0 && result.height <= 2400);
  const png = Buffer.from(result.image, 'base64');
  assert.equal(png.toString('base64'), result.image);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), result.width);
  assert.equal(png.readUInt32BE(20), result.height);
  assert.ok(png.length > 1000 && png.length < result.width * result.height * 4 + 100_000);
  const image = await loadImage(png);
  const canvas = createCanvas(result.width, result.height);
  try {
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, result.width, result.height).data;
    let marked = 0, opaque = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (Math.min(pixels[index], pixels[index + 1], pixels[index + 2]) < 240) marked++;
      if (pixels[index + 3] === 255) opaque++;
    }
    assert.ok(marked > 1000, 'The PNG must contain actual page content, not an empty canvas');
    assert.equal(opaque, result.width * result.height, 'The page has a white background');
  } finally { canvas.width = 1; canvas.height = 1; }
  return png;
}

function tallPdf() {
  const stream = 'q 0.4 0.6 0.3 rg 0 0 400 1600 re f Q\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 1600] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let text = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(text);
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 5\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

test('single-page PNGs contain real text and graphics while the library stays byte-for-byte unchanged', async t => {
  const lib = await library(t);
  const original = await readFile(samplePath);
  const doc = await lib.upload(original);
  const scan = await lib.upload(graphicsOnlyPdf());
  const tall = await lib.upload(tallPdf());
  const saved = await fetch(`${lib.base}/api/documents/${doc.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notesZh: '保留 **中文笔记**', notesEn: 'Keep old English notes.', lastPage: 2 }) });
  assert.equal(saved.status, 200);
  const before = snapshot(lib.dataDir);
  const filesBefore = await readdir(path.join(lib.dataDir, 'pdfs'));
  const first = await lib.get(`/api/documents/${doc.id}/reader-page?page=1`);
  assert.deepEqual(Object.keys(first).sort(), ['documentId', 'height', 'image', 'mimeType', 'page', 'text', 'textTruncated', 'width']);
  assert.equal(first.documentId, doc.id);
  assert.equal(first.page, 1);
  assert.equal(first.width, 1200);
  assert.equal(first.textTruncated, false);
  assert.equal(first.text, before.pages.find(row => row.document_id === doc.id && row.page === 1).text);
  const firstPng = await inspectPng(first);
  const second = await lib.get(`/api/documents/${doc.id}/reader-page?page=2&width=1600`);
  const secondPng = await inspectPng(second);
  assert.equal(second.page, 2);
  assert.equal(second.width, 1600);
  assert.notEqual(sha256(firstPng), sha256(secondPng));
  assert.equal(second.text, before.pages.find(row => row.document_id === doc.id && row.page === 2).text);
  const scanPage = await lib.get(`/api/documents/${scan.id}/reader-page?page=2&width=600`);
  await inspectPng(scanPage);
  assert.equal(scanPage.width, 600);
  assert.equal(scanPage.height, 800);
  assert.equal(scanPage.text, '');
  assert.equal(scanPage.textTruncated, false);
  const tallPage = await lib.get(`/api/documents/${tall.id}/reader-page?page=1&width=1600`);
  await inspectPng(tallPage);
  assert.equal(tallPage.height, 2400);
  assert.equal(tallPage.width, 600, 'Height limiting must preserve the tall page aspect ratio');
  assert.deepEqual(snapshot(lib.dataDir), before, 'Rendering must not touch notes, read position, indexes or schema');
  assert.equal(sha256(await readFile(path.join(lib.dataDir, 'pdfs', `${doc.id}.pdf`))), sha256(original));
  assert.equal(sha256(await readFile(path.join(lib.dataDir, 'pdfs', `${scan.id}.pdf`))), sha256(graphicsOnlyPdf()));
  assert.deepEqual(await readdir(path.join(lib.dataDir, 'pdfs')), filesBefore);
});

test('one-page text truncates safely and never splits an astral character', async t => {
  assert.deepEqual(readerPageText('a'.repeat(11_999) + '🧪tail'), { text: 'a'.repeat(11_999), textTruncated: true });
  assert.deepEqual(readerPageText('a'.repeat(11_998) + '🧪'), { text: 'a'.repeat(11_998) + '🧪', textTruncated: false });
  const lib = await library(t);
  const doc = await lib.upload(graphicsOnlyPdf());
  // Seed an isolated imported text index to exercise the API's UTF-16 boundary.
  const db = new DatabaseSync(path.join(lib.dataDir, 'paperdesk.sqlite'));
  db.prepare('UPDATE pages SET text = ? WHERE document_id = ? AND page = 1').run('中'.repeat(11_999) + '🧪tail', doc.id);
  db.close();
  const before = snapshot(lib.dataDir);
  const rendered = await lib.get(`/api/documents/${doc.id}/reader-page?page=1&width=600`);
  assert.equal(rendered.text, '中'.repeat(11_999));
  assert.equal(rendered.textTruncated, true);
  assert.deepEqual(snapshot(lib.dataDir), before);
});

test('render input, path and origin checks stay strict and a missing original is a retryable error', async t => {
  const lib = await library(t);
  const doc = await lib.upload(graphicsOnlyPdf());
  const endpoint = `/api/documents/${doc.id}/reader-page`;
  async function reject(url, expected, headers = {}) {
    const response = await fetch(`${lib.base}${url}`, { headers });
    assert.equal(response.status, expected);
    const result = await response.json();
    assert.equal(typeof result.error, 'string');
    assert.ok(!JSON.stringify(result).includes(lib.dataDir));
    assert.ok(!Object.hasOwn(result, 'image'));
  }
  for (const query of ['', '?page=0', '?page=-1', '?page=1.2', '?page=01', '?page=1e0', '?page=3', '?page=9007199254740992', '?page=1&page=2', '?page[]=1', '?page=1&width=599', '?page=1&width=1601', '?page=1&width=1.2', '?page=1&width=0600', '?page=1&width=600&width=1200', '?page=1&width=', '?page=1&file=/etc/passwd', '?page=1&url=https://example.com/a.pdf']) {
    await reject(endpoint + query, 400);
  }
  for (const id of [randomUUID(), '..%2F..%2Fetc%2Fpasswd', '%00', 'not-a-document']) await reject(`/api/documents/${id}/reader-page?page=1`, 404);
  for (const origin of ['null', 'https://example.com', 'http://127.0.0.1:9999']) await reject(`${endpoint}?page=1`, 403, { Origin: origin });
  const hostStatus = await new Promise((resolve, rejectPromise) => {
    const request = httpRequest(`${lib.base}${endpoint}?page=1`, { headers: { Host: 'foreign.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', rejectPromise); request.end();
  });
  assert.equal(hostStatus, 403);
  const file = path.join(lib.dataDir, 'pdfs', `${doc.id}.pdf`), held = `${file}.held`;
  await rename(file, held);
  try { await reject(`${endpoint}?page=1`, 422); }
  finally { await rename(held, file); }
  await inspectPng(await lib.get(`${endpoint}?page=1&width=600`));
});

test('render deadlines kill the child, and closing rejects both active and queued work without hanging', { timeout: 8000 }, async () => {
  const file = path.resolve('public/examples/reading-demo.pdf');
  const timed = createReaderRenderer({ timeoutMs: 1 });
  const started = performance.now();
  await assert.rejects(timed.render(file, 1, 600), error => error.status === 504);
  await timed.close();
  assert.ok(performance.now() - started < 2000, 'A timed-out renderer must terminate promptly');
  const renderer = createReaderRenderer({ maxQueue: 1 });
  const outcomes = Promise.allSettled([
    renderer.render(file, 1, 600),
    renderer.render(file, 2, 600),
    renderer.render(file, 1, 600),
  ]);
  const closed = renderer.close();
  assert.equal(renderer.close(), closed);
  await closed;
  const results = await outcomes;
  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected', 'rejected']);
  assert.deepEqual(results.map(result => result.reason.status), [503, 503, 429]);
  await assert.rejects(renderer.render(file, 1, 600), error => error.status === 503);
  const fresh = createReaderRenderer();
  try { await inspectPng(await fresh.render(file, 1, 600)); }
  finally { await fresh.close(); }
});
