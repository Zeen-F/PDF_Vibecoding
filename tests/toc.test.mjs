import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rename, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { extractToc } from '../server/toc.mjs';
import { bookmarkedPdf, unverifiedContentsPdf, verifiedContentsPdf } from './fixtures/toc-browser.mjs';

function literal(text) { return `(${text.replace(/[\\()]/g, '\\$&')})`; }
function flatten(entries) { return entries.flatMap(entry => [entry, ...flatten(entry.children)]); }

// All fixtures are original, self-contained PDF objects. Drawing order and
// destination dictionaries are deliberately varied, rather than mocking PDF.js.
function fixture({ pages = [['Cover'], ['Second'], ['Third'], ['Fourth']], outline = [], named = {}, labels = '' } = {}) {
  const objects = ['', ''];
  const add = value => { objects.push(value); return objects.length; };
  const set = (id, value) => { objects[id - 1] = value; };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const allText = pages.flat().map(line => typeof line === 'string' ? line : line.text).join('');
  let unicodeFont;
  if (/[^\x00-\x7f]/.test(allText)) {
    const chars = [...new Set([...allText])].map(char => char.charCodeAt(0).toString(16).padStart(4, '0'));
    const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Fixture-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange ${chars.length} beginbfchar\n${chars.map(char => `<${char}> <${char}>`).join('\n')}\nendbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
    const mapId = add(`<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`);
    const descriptor = add('<< /Type /FontDescriptor /FontName /FixtureCJK /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>');
    const cid = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /FixtureCJK /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 1000 /CIDToGIDMap /Identity >>`);
    unicodeFont = add(`<< /Type /Font /Subtype /Type0 /BaseFont /FixtureCJK /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${mapId} 0 R >>`);
  }
  const pageIds = pages.map(() => add(''));
  pages.forEach((lines, page) => {
    const stream = lines.map((value, index) => {
      const item = typeof value === 'string' ? { text: value, x: 72, y: 730 - index * 28 } : value;
      const unicode = /[^\x00-\x7f]/.test(item.text);
      const text = unicode ? `<${[...item.text].map(char => char.charCodeAt(0).toString(16).padStart(4, '0')).join('')}>` : literal(item.text);
      return `BT /${unicode ? 'F2' : 'F1'} 12 Tf ${item.x} ${item.y} Td ${text} Tj ET`;
    }).join('\n') + '\n';
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
    set(pageIds[page], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R ${unicodeFont ? `/F2 ${unicodeFont} 0 R` : ''} >> >> /Contents ${content} 0 R >>`);
  });
  set(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`);
  let extras = labels ? `/PageLabels << /Nums [${labels}] >>` : '';
  if (Object.keys(named).length) {
    const names = add(`<< /Names [${Object.entries(named).map(([name, page]) => `${literal(name)} [${pageIds[page - 1]} 0 R /Fit]`).join(' ')}] >>`);
    extras += ` /Names << /Dests ${names} 0 R >>`;
  }
  if (outline.length) {
    const outlineId = add('');
    function nodes(entries, parent) {
      const ids = entries.map(() => add(''));
      entries.forEach((entry, index) => {
        const children = entry.children?.length ? nodes(entry.children, ids[index]) : null;
        const destination = entry.url ? `/A << /S /URI /URI ${literal(entry.url)} >>`
          : entry.named ? `/Dest ${literal(entry.named)}`
            : entry.page ? `/Dest [${pageIds[entry.page - 1]} 0 R /Fit]`
              : entry.numeric !== undefined ? `/Dest [${entry.numeric} /Fit]` : '';
        set(ids[index], `<< /Title ${literal(entry.title)} /Parent ${parent} 0 R ${destination} ${index ? `/Prev ${ids[index - 1]} 0 R` : ''} ${index + 1 < ids.length ? `/Next ${ids[index + 1]} 0 R` : ''} ${children ? `/First ${children.first} 0 R /Last ${children.last} 0 R /Count ${children.count}` : ''} >>`);
      });
      return { first: ids[0], last: ids.at(-1), count: entries.length };
    }
    const children = nodes(outline, outlineId);
    set(outlineId, `<< /Type /Outlines /First ${children.first} 0 R /Last ${children.last} 0 R /Count ${children.count} >>`);
    extras += ` /Outlines ${outlineId} 0 R`;
  }
  set(1, `<< /Type /Catalog /Pages 2 0 R ${extras} >>`);
  let pdf = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('native PDF outline keeps containers, resolves names/references/numbers and rejects unsafe destinations', async () => {
  const bytes = fixture({
    named: { scope: 3 },
    outline: [
      { title: 'A container', children: [
        { title: 'Named destination', named: 'scope' }, { title: 'Numeric destination', numeric: 1 },
        { title: 'Outside the PDF', numeric: 999 }, { title: 'Negative destination', numeric: -1 },
        { title: 'Missing named destination', named: 'missing' }, { title: 'External link', url: 'https://example.com/' },
      ] },
      { title: 'Page reference', page: 4 },
    ],
  });
  const result = await extractToc(bytes);
  assert.equal(result.source, 'bookmarks');
  assert.equal(result.scannedPages, 0);
  assert.equal(result.entries[0].page, null);
  assert.deepEqual(result.entries[0].children.map(entry => entry.page), [3, 2, null, null, null, null]);
  assert.equal(result.entries[1].page, 4);
  assert.equal(new Set(flatten(result.entries).map(entry => entry.id)).size, 8);
});

test('native directory limits bound title length, depth and total entries', async () => {
  let nested = { title: 'Deep leaf', page: 1 };
  for (let level = 0; level < 14; level++) nested = { title: 'x'.repeat(520), page: 1, children: [nested] };
  const deep = await extractToc(fixture({ outline: [nested] }));
  assert.equal(flatten(deep.entries).length, 12);
  assert.ok(flatten(deep.entries).every(entry => entry.title.length <= 500));
  assert.equal(deep.truncated, true);
  const broad = await extractToc(fixture({ outline: Array.from({ length: 2002 }, (_, index) => ({ title: `Chapter ${index + 1}`, page: 1 })) }));
  assert.equal(broad.entries.length, 2000);
  assert.equal(broad.truncated, true);
});

test('external-only and untargeted bookmarks do not suppress a real printed contents page', async () => {
  const bytes = fixture({
    pages: [['Contents', '1 Introduction .... 1', '2 Methods .... 2'], ['Unrelated body'], ['Another body']],
    outline: [{ title: 'Web page', url: 'https://example.com/' }, { title: 'Empty container' }],
  });
  const result = await extractToc(bytes);
  assert.equal(result.source, 'contents');
  assert.equal(result.entries.length, 2);
  assert.ok(result.entries.every(entry => entry.page === null));
  const none = await extractToc(fixture({ outline: [{ title: 'Only external', url: 'https://example.com/' }] }));
  assert.equal(none.source, 'none');
  assert.deepEqual(none.entries, []);
});

test('geometry reconstructs shuffled text and standalone page numbers; reliable PDF labels map Roman and Arabic pages', async () => {
  const bytes = fixture({
    pages: [
      ['Cover'],
      [{ text: '1', x: 520, y: 650 }, { text: '3', x: 520, y: 610 }, { text: 'i', x: 520, y: 690 },
        { text: '2 Methods', x: 72, y: 610 }, { text: 'Contents', x: 72, y: 730 },
        { text: 'Preface', x: 72, y: 690 }, { text: '1 Introduction', x: 72, y: 650 }],
      ['Preface'], ['Body A'], ['Continuation'], ['Body B'],
    ],
    labels: '0 << /P (cover) >> 1 << /P (toc) >> 2 << /S /r >> 3 << /S /D >>',
  });
  const result = await extractToc(bytes);
  assert.equal(result.source, 'contents');
  assert.deepEqual(result.entries.map(entry => entry.title), ['Preface', '1 Introduction', '2 Methods']);
  assert.deepEqual(result.entries.map(entry => entry.printedPage), ['i', '1', '3']);
  assert.deepEqual(result.entries.map(entry => entry.page), [3, 4, 6]);
  assert.equal(result.pageOffset, 3);
  assert.equal(result.offsetVerified, true);
});

test('explicit Chinese headings, multilevel numbers, wrapped titles and continuous contents pages are retained', async () => {
  const bytes = fixture({ pages: [
    ['封面'], ['目录', '第一章 引言 .... 1', '1.1 基本概念 .... 2'],
    ['iii Contents', '2 Methods .... 3', '2.1 A heading that wraps', 'onto a second line .... 4'],
    ['Ordinary chapter', 'A measurement is 42'],
    ['Unrelated list', 'Another number 50'],
  ] });
  const result = await extractToc(bytes);
  assert.equal(result.source, 'contents');
  assert.equal(result.entries[0].title, '第一章 引言');
  assert.equal(result.entries[0].children[0].title, '1.1 基本概念');
  assert.equal(result.entries[1].title, '2 Methods');
  assert.equal(result.entries[1].children[0].title, '2.1 A heading that wraps onto a second line');
  assert.equal(flatten(result.entries).length, 4);
  assert.equal(result.scannedPages, 4);
  assert.equal(result.pageOffset, null);
});

test('two independent chapter headings verify a cover offset, while weak or conflicting anchors cannot guess', async () => {
  const bytes = verifiedContentsPdf();
  const strong = await extractToc(bytes, { getPageTexts: () => [{ page: 3, text: '1\n1\nIntroduction' }, { page: 5, text: '3\n2\nMethods' }] });
  assert.equal(strong.pageOffset, 2);
  assert.equal(strong.offsetVerified, true);
  assert.deepEqual(strong.entries.map(entry => entry.page), [3, 5]);
  for (const pages of [
    [{ page: 3, text: '1 Introduction' }],
    [{ page: 3, text: '1 Introduction' }, { page: 6, text: '2 Methods' }],
    [{ page: 3, text: '1 Introduction' }, { page: 4, text: '1 Introduction' }, { page: 5, text: '2 Methods' }],
    [{ page: 2, text: '1 Introduction\n2 Methods' }],
  ]) {
    const unverified = await extractToc(bytes, { getPageTexts: () => pages });
    assert.equal(unverified.pageOffset, null);
    assert.equal(unverified.offsetVerified, false);
    assert.ok(unverified.entries.every(entry => entry.page === null));
  }
});

test('Roman numerals without labels remain unresolved; nonuniform and duplicate labels never invent targets', async () => {
  const pages = [['Contents', 'Preface .... ii', '1 Introduction .... 1', '2 Methods .... 3'], ['Body A'], ['Body B'], ['Body C']];
  const unlabeled = await extractToc(fixture({ pages }));
  assert.deepEqual(unlabeled.entries.map(entry => entry.page), [null, null, null]);
  const mixed = await extractToc(fixture({ pages, labels: '0 << /P (toc) >> 1 << /S /r /St 2 >> 2 << /S /D >> 3 << /S /D /St 3 >>' }));
  assert.deepEqual(mixed.entries.map(entry => entry.page), [2, 3, 4]);
  assert.equal(mixed.pageOffset, null);
  assert.equal(mixed.offsetVerified, true);
  const duplicates = await extractToc(fixture({ pages, labels: '0 << /S /D >> 1 << /S /D >>' }));
  assert.equal(duplicates.entries[1].page, null);
});

test('ordinary numbered prose and scanned pages produce no directory; search stops at 40 pages', async () => {
  for (const pages of [[['Measurements', 'Voltage is 12', 'Time is 24'], ['Discussion', 'A ratio of 16']], [[], []]]) {
    const result = await extractToc(fixture({ pages }));
    assert.equal(result.source, 'none');
    assert.deepEqual(result.entries, []);
  }
  const pages = Array.from({ length: 42 }, () => ['Ordinary text']);
  pages[40] = ['Contents', '1 Introduction .... 1', '2 Methods .... 3'];
  const result = await extractToc(fixture({ pages }));
  assert.equal(result.source, 'none');
  assert.equal(result.scannedPages, 40);
  assert.equal(result.truncated, true);
  const bodyAfterContents = await extractToc(fixture({ pages: [
    ['Contents', '1 Introduction .... 1', '2 Methods .... 2'],
    ['Measurements', 'Voltage is 12', 'Time is 24'],
  ] }));
  assert.equal(bodyAfterContents.entries.length, 2, 'Plain numeric prose must not extend the preceding contents page');
});

test('TOC endpoint works for previously imported documents across restart without changing original files or schema', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'paperdesk-toc-'));
  let runtime, server, base;
  async function start() {
    runtime = createApp({ dataDir });
    server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    runtime.close();
  }
  async function upload(bytes, filename) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), filename);
    const response = await fetch(`${base}/api/documents`, { method: 'POST', body: form });
    assert.equal(response.status, 201);
    return (await response.json()).document;
  }
  await start();
  t.after(async () => { await stop(); await rm(dataDir, { recursive: true, force: true }); });
  const bytes = bookmarkedPdf();
  const doc = await upload(bytes, 'old-document.pdf');
  const unknown = await upload(unverifiedContentsPdf(), 'unknown-offset.pdf');
  const verified = await upload(verifiedContentsPdf(), 'verified-offset.pdf');
  await stop();
  await start();
  const before = await (await fetch(`${base}/api/documents/${doc.id}`)).json();
  const results = await Promise.all(Array.from({ length: 5 }, () => fetch(`${base}/api/documents/${doc.id}/toc`).then(response => response.json())));
  assert.ok(results.every(result => result.source === 'bookmarks'));
  assert.deepEqual(results[0], results[4]);
  assert.equal((await (await fetch(`${base}/api/documents/${verified.id}/toc`)).json()).pageOffset, 2);
  assert.equal((await (await fetch(`${base}/api/documents/${unknown.id}/toc`)).json()).pageOffset, null);
  assert.deepEqual(await readFile(join(dataDir, 'pdfs', `${doc.id}.pdf`)), bytes);
  assert.deepEqual(await (await fetch(`${base}/api/documents/${doc.id}`)).json(), before);
  const database = new DatabaseSync(join(dataDir, 'paperdesk.sqlite'), { readOnly: true });
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, 2);
  assert.ok(!database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().some(row => /toc|outline/i.test(row.name)));
  database.close();
  assert.deepEqual((await readdir(dataDir)).filter(name => !name.startsWith('paperdesk.sqlite')), ['pdfs']);
  assert.equal((await fetch(`${base}/api/documents/not-a-document/toc`)).status, 404);
  assert.equal((await fetch(`${base}/api/documents/${doc.id}/toc`, { headers: { Origin: 'https://example.com' } })).status, 403);

  await t.test('a failed read is retryable after the original PDF is restored', async () => {
    const retryDoc = await upload(fixture({ outline: [{ title: 'Retry target', page: 1 }] }), 'retry.pdf');
    const original = join(dataDir, 'pdfs', `${retryDoc.id}.pdf`), temporarilyMoved = `${original}.held`;
    await rename(original, temporarilyMoved);
    try {
      const failure = await fetch(`${base}/api/documents/${retryDoc.id}/toc`);
      assert.equal(failure.status, 422);
      assert.match((await failure.json()).error, /重试/);
    } finally { await rename(temporarilyMoved, original); }
    const recovered = await (await fetch(`${base}/api/documents/${retryDoc.id}/toc`)).json();
    assert.equal(recovered.source, 'bookmarks');
  });
});
