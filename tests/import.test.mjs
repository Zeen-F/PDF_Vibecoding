import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createApp } from '../server/app.mjs';

// Original one-page PDF. Large fixtures contain an unreferenced stream with an
// explicit length, like an unused embedded asset. Its xref remains correct and
// PDF.js can skip the asset without lexing megabytes of comment text.
function pdfParts(text, paddingBytes = 0) {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let prefix = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(prefix));
    prefix += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  let afterPadding = '';
  if (paddingBytes) {
    offsets.push(Buffer.byteLength(prefix));
    prefix += `${objects.length + 1} 0 obj\n<< /Length ${paddingBytes} >>\nstream\n`;
    afterPadding = '\nendstream\nendobj\n';
  }
  const objectCount = offsets.length + 1;
  const xref = Buffer.byteLength(prefix) + paddingBytes + Buffer.byteLength(afterPadding);
  const suffix = `${afterPadding}xref\n0 ${objectCount}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { prefix: Buffer.from(prefix), suffix: Buffer.from(suffix) };
}

async function largePdfFixture(path) {
  const chunkSize = 256 * 1024;
  const paddingBytes = 52 * 1024 * 1024;
  const { prefix, suffix } = pdfParts('Original large-file import regression.', paddingBytes);
  const comment = Buffer.alloc(chunkSize, 0x78);
  comment[0] = 0x25;
  comment[comment.length - 1] = 0x0a;
  const hash = createHash('sha256');
  let byteSize = 0;
  async function* chunks() {
    for (const chunk of [prefix]) {
      hash.update(chunk); byteSize += chunk.length; yield chunk;
    }
    for (let remaining = paddingBytes; remaining > 0; remaining -= chunkSize) {
      hash.update(comment); byteSize += comment.length; yield comment;
    }
    hash.update(suffix); byteSize += suffix.length; yield suffix;
  }
  await pipeline(Readable.from(chunks()), createWriteStream(path, { flags: 'wx', mode: 0o600 }));
  return { byteSize, sha256: hash.digest('hex') };
}

async function uploadedFile(base, path, filename = 'original-book.pdf') {
  const boundary = `paperdesk-${randomUUID()}`;
  const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const { size } = await stat(path);
  async function* body() {
    yield prefix;
    yield* createReadStream(path, { highWaterMark: 256 * 1024 });
    yield suffix;
  }
  return fetch(`${base}/api/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(prefix.length + size + suffix.length),
    },
    body: Readable.from(body()),
    duplex: 'half',
  });
}

async function streamFingerprint(response) {
  assert.equal(response.status, 200);
  const hash = createHash('sha256');
  let byteSize = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    byteSize += chunk.length;
  }
  return { byteSize, sha256: hash.digest('hex') };
}

async function filesBelow(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesBelow(root, relative));
    else files.push(relative);
  }
  return files.sort();
}

test('disk-backed PDF imports retain full bytes and clean up every outcome', { timeout: 180000 }, async t => {
  const tempDir = await mkdtemp(join(tmpdir(), 'paperdesk-import-'));
  // The development launcher stores its library under .local; original-file
  // downloads must remain available when an ancestor is a hidden directory.
  const dataDir = join(tempDir, '.local', 'data');
  let runtime;
  let server;
  t.after(async () => {
    try {
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    } finally {
      runtime?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  const largePath = join(tempDir, 'original-large.pdf');
  const expected = await largePdfFixture(largePath);
  assert.ok(expected.byteSize > 50 * 1024 * 1024);
  runtime = createApp({ dataDir });
  server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const documents = async () => (await (await fetch(`${base}/api/documents`)).json()).documents;
  async function assertCleanStorage(expectedDocuments) {
    const allowed = new Set(expectedDocuments.map(document => `pdfs/${document.id}.pdf`));
    const actual = await filesBelow(dataDir);
    const payloads = actual.filter(path => !/^paperdesk\.sqlite(?:-(?:wal|shm))?$/.test(path));
    assert.deepEqual(payloads, [...allowed].sort(), 'Only committed original PDFs may remain; no upload or parsing fragments');
  }
  async function assertRejected(response) {
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(typeof body.error, 'string');
    assert.ok(body.error.trim(), 'Failed uploads must return a readable error');
  }

  let largeDocument;
  await t.test('a valid original PDF above 50 MiB imports with every byte intact', async () => {
    const response = await uploadedFile(base, largePath);
    assert.equal(response.status, 201, await response.clone().text());
    const body = await response.json();
    assert.equal(body.duplicate, false);
    largeDocument = body.document;
    assert.equal(largeDocument.pageCount, 1);
    assert.equal(largeDocument.textAvailable, true);
    assert.equal(largeDocument.byteSize, expected.byteSize);
    const retrieved = await streamFingerprint(await fetch(`${base}/api/documents/${largeDocument.id}/file`));
    assert.deepEqual(retrieved, expected, 'Large originals must never be truncated, recompressed or rewritten');
    await assertCleanStorage(await documents());
  });
  assert.ok(largeDocument, 'The large-file import is required for subsequent deduplication checks');

  await t.test('reuploading the large file keeps exactly one original', async () => {
    const response = await uploadedFile(base, largePath, 'same-bytes-new-name.pdf');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.duplicate, true);
    assert.equal(body.document.id, largeDocument.id);
    assert.equal((await documents()).length, 1);
    await assertCleanStorage(await documents());
  });

  const smallParts = pdfParts('Original concurrent import regression.');
  const smallBytes = Buffer.concat([smallParts.prefix, smallParts.suffix]);
  const smallPath = join(tempDir, 'original-concurrent.pdf');
  await writeFile(smallPath, smallBytes, { flag: 'wx', mode: 0o600 });
  await t.test('concurrent uploads of the same new bytes create one document', async () => {
    const responses = await Promise.all([uploadedFile(base, smallPath), uploadedFile(base, smallPath)]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 201]);
    const bodies = await Promise.all(responses.map(response => response.json()));
    assert.equal(bodies[0].document.id, bodies[1].document.id);
    assert.deepEqual(bodies.map(body => body.duplicate).sort(), [false, true]);
    assert.equal((await documents()).length, 2);
    await assertCleanStorage(await documents());
  });

  const beforeFailures = await documents();
  await t.test('an invalid PDF leaves neither a document nor a temporary file', async () => {
    const path = join(tempDir, 'broken.pdf');
    await writeFile(path, '%PDF-1.4\nThis is not a PDF object tree.\n', { flag: 'wx', mode: 0o600 });
    await assertRejected(await uploadedFile(base, path));
    assert.deepEqual(await documents(), beforeFailures);
    await assertCleanStorage(beforeFailures);
  });

  await t.test('an unexpected multipart field removes the already spooled PDF', async () => {
    const boundary = `paperdesk-${randomUUID()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="candidate.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      smallBytes,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="unexpected"\r\n\r\nnot allowed\r\n--${boundary}--\r\n`),
    ]);
    await assertRejected(await fetch(`${base}/api/documents`, {
      method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body,
    }));
    assert.deepEqual(await documents(), beforeFailures);
    await assertCleanStorage(beforeFailures);
  });

  await t.test('a truncated multipart body cleans up its incomplete upload', async () => {
    const boundary = `paperdesk-${randomUUID()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="truncated.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      smallBytes,
    ]);
    await assertRejected(await fetch(`${base}/api/documents`, {
      method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body,
    }));
    assert.deepEqual(await documents(), beforeFailures);
    await assertCleanStorage(beforeFailures);
  });
});
