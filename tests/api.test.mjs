import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.mjs';

const sample = await readFile(new URL('../public/examples/reading-demo.pdf', import.meta.url));

function pdfFixture(objects) {
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf);
}

// Deliberately text-free: a PDF can be valid even when its page is a scan or drawing.
function imageOnlyPdf() {
  const stream = 'q\n0.5 g 10 10 100 100 re f\nQ\n';
  return pdfFixture([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ]);
}

function mixedFontPdf() {
  const stream = 'BT /F1 12 Tf 72 720 Td (micro) Tj /F2 12 Tf (electronics) Tj ET\nBT /F1 12 Tf 72 690 Td (field) Tj 60 0 Td /F2 12 Tf (study) Tj ET\n';
  return pdfFixture([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ]);
}

test('Paperdesk preserves a complete local reading workflow', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'paperdesk-api-'));
  let runtime;
  let server;
  let base;
  let documentId;
  let annotationId;

  async function start() {
    runtime = await createApp({ dataDir });
    server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server = undefined;
    }
    if (runtime) { await runtime.close(); runtime = undefined; }
  }
  async function request(path, { method = 'GET', body, headers } = {}) {
    return fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function upload(bytes = sample, filename = '阅读示例.pdf') {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), filename);
    return fetch(`${base}/api/documents`, { method: 'POST', body: form });
  }
  async function expectError(response, expectedStatus) {
    assert.ok(expectedStatus.includes(response.status), `Unexpected status ${response.status}`);
    assert.match(response.headers.get('content-type') || '', /json/);
    const body = await response.json();
    assert.equal(typeof body.error, 'string');
    assert.ok(body.error.trim().length > 0, 'Readable error is required');
    return body;
  }

  await start();
  t.after(async () => { await stop(); await rm(dataDir, { recursive: true, force: true }); });

  await t.test('health and a fresh empty library', async () => {
    assert.deepEqual(await (await request('/api/health')).json(), { ok: true });
    const body = await (await request('/api/documents')).json();
    assert.deepEqual(body.documents, []);
  });

  await t.test('real bilingual PDF import retains original bytes and metadata', async () => {
    const response = await upload();
    assert.equal(response.status, 201);
    const { document, duplicate } = await response.json();
    assert.equal(duplicate, false);
    assert.equal(document.pageCount, 2);
    assert.equal(document.filename, '阅读示例.pdf');
    assert.match(document.title, /主动阅读示例/);
    assert.equal(document.textAvailable, true);
    assert.equal(document.byteSize, sample.length);
    assert.equal(document.notesZh, '');
    assert.equal(document.notesEn, '');
    documentId = document.id;
    assert.match(documentId, /^[\da-f-]{36}$/i);
    const file = await request(`/api/documents/${documentId}/file`);
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-type'), /application\/pdf/);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), sample);
  });

  await t.test('reimport deduplicates by content even with a new filename', async () => {
    const response = await upload(sample, 'renamed-copy.pdf');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.duplicate, true);
    assert.equal(body.document.id, documentId);
    assert.equal((await (await request('/api/documents')).json()).documents.length, 1);
  });

  await t.test('search reaches the second page in English and Chinese', async () => {
    for (const query of ['PHASE MARGIN', '相位裕度']) {
      const response = await request(`/api/search?q=${encodeURIComponent(query)}`);
      assert.equal(response.status, 200);
      const { results } = await response.json();
      assert.ok(results.some(result => result.documentId === documentId && result.page === 2 && result.source === 'text'));
      assert.ok(results.some(result => result.snippet.toLowerCase().includes(query.toLowerCase())));
    }
    const literal = await (await request('/api/search?q=%5Bnot%20a%20regular%20expression')).json();
    assert.deepEqual(literal.results, []);
    assert.deepEqual((await (await request('/api/search?q=')).json()).results, []);
  });

  await t.test('search phrases survive visual PDF line wrapping in both languages', async () => {
    for (const [query, page] of [['can express', 2], ['论文的研究结论', 1]]) {
      const { results } = await (await request(`/api/search?q=${encodeURIComponent(query)}`)).json();
      assert.ok(results.some(result => result.documentId === documentId && result.page === page && result.source === 'text'), `Missing line-wrapped phrase: ${query}`);
      assert.ok(results.some(result => result.snippet.includes(query)), `Snippet omits phrase: ${query}`);
    }
  });

  await t.test('malformed or missing uploads fail cleanly without adding documents', async () => {
    await expectError(await upload(Buffer.from('%PDF-1.7\nnot a real PDF\n')), [400, 422]);
    await expectError(await upload(Buffer.from('Hello, I am a text file.')), [400, 415, 422]);
    await expectError(await fetch(`${base}/api/documents`, { method: 'POST', body: new FormData() }), [400]);
    assert.equal((await (await request('/api/documents')).json()).documents.length, 1);
  });

  await t.test('password-protected PDF returns an actionable error', async () => {
    const encrypted = await readFile(new URL('./fixtures/password-protected.pdf', import.meta.url));
    const body = await expectError(await upload(encrypted, 'protected.pdf'), [400, 422]);
    assert.match(body.error, /password|encrypt|密码|加密/i);
    assert.equal((await (await request('/api/documents')).json()).documents.length, 1);
  });

  const notesZh = '## 我的理解\n\n相位裕度需要结合条件。\n\n- 先问问题\n- 再核对证据';
  const notesEn = '## My understanding\n\n**Local-first notes** retain their Markdown.\n\nReview the operating conditions.';
  await t.test('bilingual notes update independently, preserve Markdown, and can be cleared', async () => {
    const path = `/api/documents/${documentId}`;
    let response = await request(path, { method: 'PATCH', body: { notesZh, notesEn, lastPage: 2 } });
    assert.equal(response.status, 200);
    response = await request(path, { method: 'PATCH', body: { notesZh: '' } });
    assert.equal(response.status, 200);
    let { document } = await response.json();
    assert.equal(document.notesZh, '');
    assert.equal(document.notesEn, notesEn);
    assert.equal(document.lastPage, 2);
    response = await request(path, { method: 'PATCH', body: { notesZh, title: '主动阅读 / Reading 🧪' } });
    assert.equal(response.status, 200);
    for (const body of [{ lastPage: 0 }, { lastPage: 3 }, { lastPage: 1.5 }, { notesEn: null }, { title: '' }]) {
      await expectError(await request(path, { method: 'PATCH', body }), [400, 422]);
    }
    const results = (await (await request('/api/search?q=Local-first')).json()).results;
    assert.ok(results.some(result => result.documentId === documentId && result.source === 'notes'));
  });

  const annotation = {
    page: 2,
    quote: 'search for phase margin',
    comment: '需要核对定义与工作条件。',
    color: 'yellow',
    rects: [{ x: 0.14, y: 0.37, width: 0.3, height: 0.021 }],
  };
  await t.test('normalized highlights retain quote, comment, page and geometry', async () => {
    const response = await request(`/api/documents/${documentId}/annotations`, { method: 'POST', body: annotation });
    assert.equal(response.status, 201);
    const body = await response.json();
    annotationId = body.annotation.id;
    assert.equal(body.annotation.documentId, documentId);
    for (const key of ['page', 'quote', 'comment', 'color', 'rects']) assert.deepEqual(body.annotation[key], annotation[key]);
    const results = (await (await request(`/api/search?q=${encodeURIComponent('需要核对')}`)).json()).results;
    assert.ok(results.some(result => result.source === 'annotation' && result.page === 2));
    const update = await request(`/api/documents/${documentId}/annotations/${annotationId}`, { method: 'PATCH', body: { comment: '', color: 'green' } });
    assert.equal(update.status, 200);
    const changed = (await update.json()).annotation;
    assert.equal(changed.comment, '');
    assert.equal(changed.color, 'green');
    assert.deepEqual(changed.rects, annotation.rects);
    assert.equal((await request(`/api/documents/${documentId}/annotations/${annotationId}`, { method: 'PATCH', body: { comment: annotation.comment } })).status, 200);
  });

  await t.test('invalid page, color, and out-of-page geometry cannot create highlights', async () => {
    const invalid = [
      { page: 0 }, { page: 3 }, { page: 1.2 }, { color: 'purple' }, { rects: [] },
      { rects: [{ x: -0.1, y: 0.2, width: 0.3, height: 0.02 }] },
      { rects: [{ x: 0.9, y: 0.2, width: 0.3, height: 0.02 }] },
      { rects: [{ x: 0.1, y: 0.99, width: 0.3, height: 0.02 }] },
      { rects: [{ x: 0.1, y: 0.2, width: 0, height: 0.02 }] },
    ];
    for (const patch of invalid) {
      await expectError(await request(`/api/documents/${documentId}/annotations`, { method: 'POST', body: { ...annotation, ...patch } }), [400, 422]);
    }
    const body = await (await request(`/api/documents/${documentId}`)).json();
    assert.equal(body.annotations.length, 1);
  });

  await t.test('Markdown export includes both notes and source-linked annotations', async () => {
    const response = await request(`/api/documents/${documentId}/export`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/markdown.*charset=utf-8/i);
    const disposition = response.headers.get('content-disposition');
    assert.match(disposition, /attachment/i);
    assert.ok(!/[\r\n]/.test(disposition));
    const markdown = await response.text();
    assert.ok(markdown.includes('主动阅读'));
    assert.ok(markdown.includes('阅读示例.pdf'));
    assert.ok(markdown.includes(notesZh));
    assert.ok(markdown.includes(notesEn));
    assert.ok(markdown.includes(annotation.quote));
    assert.ok(markdown.includes(annotation.comment));
    assert.match(markdown, /2/);
  });

  await t.test('foreign origin, invalid identifiers, and traversal are rejected', async () => {
    await expectError(await request(`/api/documents/${documentId}`, { method: 'PATCH', body: { notesZh: 'must not persist' }, headers: { Origin: 'https://untrusted.example' } }), [403]);
    await expectError(await request('/api/documents/%2e%2e%2f%2e%2e%2fetc%2fpasswd/file'), [400, 404]);
    await expectError(await request('/api/documents/not-a-document/file'), [400, 404]);
    const body = await (await request(`/api/documents/${documentId}`)).json();
    assert.equal(body.document.notesZh, notesZh);
  });

  await t.test('valid PDF without extractable text remains readable and accepts manual notes', async () => {
    const response = await upload(imageOnlyPdf(), 'scan.pdf');
    assert.equal(response.status, 201);
    const { document } = await response.json();
    assert.equal(document.pageCount, 1);
    assert.equal(document.textAvailable, false);
    assert.equal((await request(`/api/documents/${document.id}/file`)).status, 200);
    const updated = await request(`/api/documents/${document.id}`, { method: 'PATCH', body: { notesZh: '扫描件手动笔记' } });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).document.notesZh, '扫描件手动笔记');
    await expectError(await request(`/api/documents/${document.id}/annotations/${annotationId}`, { method: 'PATCH', body: { comment: 'wrong document' } }), [404]);
  });

  await t.test('font changes inside words do not add false spaces, while real word gaps survive', async () => {
    const response = await upload(mixedFontPdf(), 'mixed-font.pdf');
    assert.equal(response.status, 201);
    const { document } = await response.json();
    for (const query of ['microelectronics', 'field study']) {
      const { results } = await (await request(`/api/search?q=${encodeURIComponent(query)}`)).json();
      assert.ok(results.some(result => result.documentId === document.id && result.source === 'text'), `Missing PDF text: ${query}`);
    }
    for (const query of ['micro electronics', 'fieldstudy']) {
      const { results } = await (await request(`/api/search?q=${encodeURIComponent(query)}`)).json();
      assert.ok(!results.some(result => result.documentId === document.id && result.source === 'text'), `Invented text boundary: ${query}`);
    }
  });

  await t.test('restart restores original PDF, notes, reading position and annotations', async () => {
    await stop();
    await start();
    const body = await (await request(`/api/documents/${documentId}`)).json();
    assert.equal(body.document.notesZh, notesZh);
    assert.equal(body.document.notesEn, notesEn);
    assert.equal(body.document.lastPage, 2);
    assert.equal(body.annotations.length, 1);
    assert.equal(body.annotations[0].id, annotationId);
    assert.equal(body.annotations[0].comment, annotation.comment);
    assert.equal(body.annotations[0].color, 'green');
    assert.deepEqual(body.annotations[0].rects, annotation.rects);
    assert.deepEqual(Buffer.from(await (await request(`/api/documents/${documentId}/file`)).arrayBuffer()), sample);
    const search = (await (await request(`/api/search?q=${encodeURIComponent('相位裕度')}`)).json()).results;
    assert.ok(search.some(result => result.page === 2 && result.source === 'text'));
  });

  await t.test('deleting one annotation is permanent without removing the document', async () => {
    const path = `/api/documents/${documentId}/annotations/${annotationId}`;
    const response = await request(path, { method: 'DELETE' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    await stop();
    await start();
    const body = await (await request(`/api/documents/${documentId}`)).json();
    assert.deepEqual(body.annotations, []);
    assert.equal(body.document.notesZh, notesZh);
  });
});
