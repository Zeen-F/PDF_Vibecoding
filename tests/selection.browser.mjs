import { prepareTextLayer, readPdfSelection } from '../src/selection.js';

const host = document.querySelector('#fixture-host');
const output = document.querySelector('#results');
const status = document.querySelector('#status');
const button = document.querySelector('#run-tests');
const tests = [];
const test = (name, run) => tests.push({ name, run });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (actual, expected, label) => assert(actual === expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const words = text => text.replace(/\s+/g, ' ').trim();

async function fixture(items, { width = 620, height = 380, rotation = 0 } = {}) {
  window.getSelection().removeAllRanges();
  host.replaceChildren();
  const paper = document.createElement('div');
  paper.className = 'fixture-paper';
  paper.style.width = `${width}px`;
  paper.style.height = `${height}px`;
  const prefix = document.createElement('p');
  prefix.className = 'outside-copy';
  prefix.textContent = 'OUTSIDE PREFIX MUST NOT LEAK';
  const suffix = document.createElement('p');
  suffix.className = 'outside-copy';
  suffix.textContent = 'OUTSIDE SUFFIX MUST NOT LEAK';
  const layer = document.createElement('div');
  layer.className = 'textLayer fixture-layer';
  if (rotation === 90) {
    layer.style.inset = 'auto';
    layer.style.width = `${height}px`;
    layer.style.height = `${width}px`;
    layer.style.transformOrigin = '0 0';
    layer.style.transform = `translateX(${width}px) rotate(90deg)`;
  }
  const nodes = {};
  for (const item of items) {
    const span = document.createElement('span');
    span.dataset.testKey = item.key;
    span.setAttribute('role', 'presentation');
    span.setAttribute('dir', 'ltr');
    span.textContent = item.text;
    span.style.left = `${item.x}px`;
    span.style.top = `${item.y}px`;
    if (item.fontSize) {
      span.style.fontSize = `${item.fontSize}px`;
      span.style.lineHeight = `${item.lineHeight ?? item.fontSize}px`;
    }
    if (item.fontFamily) span.style.fontFamily = item.fontFamily;
    if (item.fontWeight) span.style.fontWeight = item.fontWeight;
    if (item.width) span.style.width = `${item.width}px`;
    nodes[item.key] = span;
    layer.append(span);
  }
  paper.append(layer);
  host.append(prefix, paper, suffix);
  await document.fonts.ready;
  await prepareTextLayer(layer, { rotation, paperBounds: paper.getBoundingClientRect() });
  return { paper, layer, nodes, prefix, suffix, read: () => readPdfSelection(layer, paper, window.getSelection()) };
}

function select(f, from, start, to = from, end = undefined, reverse = false) {
  const first = f.nodes[from].firstChild;
  const last = f.nodes[to].firstChild;
  const lastOffset = end ?? last.length;
  const selection = window.getSelection();
  selection.removeAllRanges();
  if (reverse) selection.setBaseAndExtent(last, lastOffset, first, start);
  else selection.setBaseAndExtent(first, start, last, lastOffset);
  return f.read();
}

function quote(result) {
  assert(result && typeof result.quote === 'string', 'Expected a text selection result');
  assert(Array.isArray(result.rects) && result.rects.length > 0, 'Expected highlight rectangles');
  return result.quote;
}

function bounded(rects) {
  for (const r of rects) {
    assert(['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k])), `Rectangle is not finite: ${JSON.stringify(r)}`);
    assert(r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001, `Rectangle escaped paper: ${JSON.stringify(r)}`);
  }
}

test('footer drawn before body cannot appear between selected body lines', async () => {
  const f = await fixture([
    { key: 'footer', text: 'FOOTER 01', x: 20, y: 330 },
    { key: 'second', text: 'Second body line.', x: 20, y: 70 },
    { key: 'first', text: 'First body line.', x: 20, y: 35 },
  ]);
  equal(words(quote(select(f, 'first', 0, 'second'))), 'First body line. Second body line.', 'Source-order correction');
  assert(!quote(f.read()).includes('FOOTER'), 'Unselected footer leaked');
});

test('forward partial-word selection contains exactly the selected characters', async () => {
  const f = await fixture([{ key: 'line', text: 'Alpha microelectronics Omega', x: 20, y: 35 }]);
  equal(quote(select(f, 'line', 9, 'line', 17)), 'roelectr', 'Exact partial word');
});

test('reverse drag direction returns the same partial characters in reading order', async () => {
  const f = await fixture([{ key: 'line', text: 'Alpha microelectronics Omega', x: 20, y: 35 }]);
  equal(quote(select(f, 'line', 9, 'line', 17, true)), 'roelectr', 'Reverse partial word');
});

test('wrapped English selection does not omit or duplicate endpoint fragments', async () => {
  const f = await fixture([
    { key: 'line2', text: 'continues on the next line.', x: 20, y: 63 },
    { key: 'line1', text: 'A useful sentence begins here and', x: 20, y: 35 },
  ]);
  equal(words(quote(select(f, 'line1', 9, 'line2', 12))), 'sentence begins here and continues on', 'Wrapped partial selection');
});

test('a font change inside one word does not invent a space', async () => {
  const first = 'micro';
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = '18px Arial';
  const f = await fixture([
    { key: 'bold', text: 'electronics', x: 20 + measure.measureText(first).width, y: 35, fontWeight: '700' },
    { key: 'plain', text: first, x: 20, y: 35 },
  ]);
  equal(quote(select(f, 'plain', 0, 'bold')), 'microelectronics', 'Mixed-font word');
});

test('a visible gap between separate words remains a space', async () => {
  const f = await fixture([
    { key: 'word2', text: 'study', x: 105, y: 35 },
    { key: 'word1', text: 'field', x: 20, y: 35 },
  ]);
  equal(words(quote(select(f, 'word1', 0, 'word2'))), 'field study', 'Visible word gap');
});

test('a raised small superscript stays between its baseline neighbors', async () => {
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = '18px Arial';
  const prefix = 'The gain is x';
  const superscriptX = 50 + measure.measureText(prefix).width;
  measure.font = '10px Arial';
  const tailX = superscriptX + measure.measureText('2').width;
  const f = await fixture([
    { key: 'tail', text: ' in this case.', x: tailX, y: 100, fontSize: 18 },
    { key: 'sup', text: '2', x: superscriptX, y: 89, fontSize: 10 },
    { key: 'prefix', text: prefix, x: 50, y: 100, fontSize: 18 },
  ]);
  window.getSelection().setBaseAndExtent(f.layer, 0, f.layer, f.layer.childNodes.length);
  equal(quote(f.read()), 'The gain is x2 in this case.', 'Superscript baseline reading order');
});

test('a lowered small subscript remains inside the chemical formula', async () => {
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = '18px Arial';
  const subscriptX = 50 + measure.measureText('H').width;
  measure.font = '10px Arial';
  const oxygenX = subscriptX + measure.measureText('2').width;
  const f = await fixture([
    { key: 'oxygen', text: 'O', x: oxygenX, y: 100, fontSize: 18 },
    { key: 'hydrogen', text: 'H', x: 50, y: 100, fontSize: 18 },
    { key: 'sub', text: '2', x: subscriptX, y: 114, fontSize: 10 },
  ]);
  window.getSelection().setBaseAndExtent(f.layer, 0, f.layer, f.layer.childNodes.length);
  equal(quote(f.read()), 'H2O', 'Subscript formula reading order');
});

test('CJK spans and wrapped CJK lines do not acquire Latin-style spaces', async () => {
  const f = await fixture([
    { key: 'c', text: '需要结合条件', x: 20, y: 63 },
    { key: 'b', text: '裕度', x: 56, y: 35 },
    { key: 'a', text: '相位', x: 20, y: 35 },
  ]);
  equal(quote(select(f, 'a', 0, 'c')), '相位裕度\n需要结合条件', 'CJK continuity with a real line break');
});

test('two-column reading follows the complete left column before the right', async () => {
  const f = await fixture([
    { key: 'r1', text: 'Right column line one.', x: 335, y: 35 },
    { key: 'l2', text: 'Left column line two.', x: 20, y: 73 },
    { key: 'l1', text: 'Left column line one.', x: 20, y: 35 },
    { key: 'r2', text: 'Right column line two.', x: 335, y: 73 },
  ]);
  equal(words(quote(select(f, 'l1', 0, 'r2'))), 'Left column line one. Left column line two. Right column line one. Right column line two.', 'Column reading order');
});

test('full-width heading and footer stay outside the two-column body order', async () => {
  const f = await fixture([
    { key: 'footer', text: 'END OF PAGE', x: 220, y: 325 },
    { key: 'r1', text: 'Right column line one.', x: 335, y: 105 },
    { key: 'l2', text: 'Left column line two.', x: 20, y: 143 },
    { key: 'title', text: 'Full-width heading for a two-column reading example', x: 20, y: 35, width: 550 },
    { key: 'l1', text: 'Left column line one.', x: 20, y: 105 },
    { key: 'r2', text: 'Right column line two.', x: 335, y: 143 },
  ]);
  equal(words(quote(select(f, 'title', 0, 'footer'))), 'Full-width heading for a two-column reading example Left column line one. Left column line two. Right column line one. Right column line two. END OF PAGE', 'Heading, columns and footer reading order');
});

test('wrapper endpoints clip the quote to the PDF layer', async () => {
  const f = await fixture([
    { key: 'a', text: 'Inside PDF only.', x: 20, y: 35 },
    { key: 'b', text: 'No toolbar or sidebar.', x: 20, y: 63 },
  ]);
  const selection = window.getSelection();
  selection.setBaseAndExtent(f.prefix.firstChild, 8, f.suffix.firstChild, 14);
  equal(words(quote(f.read())), 'Inside PDF only. No toolbar or sidebar.', 'Layer boundary clipping');
  bounded(f.read().rects);
});

test('page element endpoints include only its selected text descendants', async () => {
  const f = await fixture([{ key: 'a', text: 'A page-wide selection.', x: 20, y: 35 }]);
  window.getSelection().setBaseAndExtent(f.paper, 0, f.paper, f.paper.childNodes.length);
  equal(quote(f.read()), 'A page-wide selection.', 'Page endpoint selection');
});

test('cleared or collapsed selection cannot reuse the previous quote', async () => {
  const f = await fixture([{ key: 'a', text: 'One selection only.', x: 20, y: 35 }]);
  equal(quote(select(f, 'a', 0, 'a', 3)), 'One', 'Initial selection');
  window.getSelection().removeAllRanges();
  equal(f.read(), null, 'Cleared selection');
  window.getSelection().collapse(f.nodes.a.firstChild, 2);
  equal(f.read(), null, 'Collapsed selection');
});

test('overlapping rendered text does not duplicate highlight boxes', async () => {
  const f = await fixture([
    { key: 'a', text: 'Same geometry', x: 20, y: 35 },
    { key: 'b', text: 'Same geometry', x: 20, y: 35 },
  ]);
  const spans = [...f.layer.querySelectorAll('span')];
  window.getSelection().setBaseAndExtent(spans[0].firstChild, 0, spans.at(-1).firstChild, spans.at(-1).textContent.length);
  const result = f.read();
  quote(result);
  const boxes = result.rects.map(r => ['x', 'y', 'width', 'height'].map(k => r[k].toFixed(5)).join(','));
  equal(new Set(boxes).size, boxes.length, 'Rectangle deduplication');
  bounded(result.rects);
});

test('partially off-page text produces clipped normalized geometry', async () => {
  const f = await fixture([{ key: 'a', text: 'Clipped edge', x: -12, y: -5 }], { width: 160, height: 100 });
  const result = select(f, 'a', 0);
  quote(result);
  bounded(result.rects);
  assert(result.rects.some(r => r.x === 0 || r.y === 0), 'Expected rectangle to touch a clipped page edge');
});

test('intrinsic 90-degree rotation keeps the selected range geometry aligned', async () => {
  const f = await fixture([{ key: 'a', text: 'Rotated selected words', x: 20, y: 25 }], { width: 300, height: 260, rotation: 90 });
  const result = select(f, 'a', 8, 'a', 16);
  equal(quote(result), 'selected', 'Rotated exact quote');
  bounded(result.rects);
  const expected = window.getSelection().getRangeAt(0).getBoundingClientRect();
  const paper = f.paper.getBoundingClientRect();
  assert(result.rects.some(r => Math.abs(paper.left + r.x * paper.width - expected.left) < 1 && Math.abs(paper.top + r.y * paper.height - expected.top) < 1 && Math.abs(r.width * paper.width - expected.width) < 1 && Math.abs(r.height * paper.height - expected.height) < 1), 'Rotated highlight does not follow the actual selected range');
});

button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = 'Running…';
  const results = [];
  for (const entry of tests) {
    try { await entry.run(); results.push({ test: entry.name, status: 'PASS' }); }
    catch (error) { results.push({ test: entry.name, status: 'FAIL', error: error.message }); }
    finally { window.getSelection().removeAllRanges(); }
  }
  const passed = results.filter(result => result.status === 'PASS').length;
  const summary = { passed, failed: results.length - passed, total: results.length, tests: results };
  window.selectionTestResults = summary;
  output.textContent = JSON.stringify(summary, null, 2);
  status.textContent = `${passed}/${results.length} passed${summary.failed ? ` · ${summary.failed} failed` : ''}`;
  button.disabled = false;
});
