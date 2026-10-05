import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const pdfPackageDir = fileURLToPath(new URL('../node_modules/pdfjs-dist/', import.meta.url));
const MAX_DEPTH = 12;
const MAX_ENTRIES = 2000;
const MAX_TITLE = 500;
const MAX_SCAN = 40;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const empty = () => ({ source: 'none', entries: [], pageOffset: null, offsetVerified: false, scannedPages: 0, truncated: false });

function title(value, state) {
  const text = String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length > MAX_TITLE) state.truncated = true;
  return text.slice(0, MAX_TITLE);
}

function validPage(page, count) { return Number.isInteger(page) && page > 0 && page <= count ? page : null; }
function normalizedLabel(label) { return String(label ?? '').normalize('NFKC').trim().toLowerCase(); }

async function bookmarkPage(pdf, node) {
  if (node.url || node.unsafeUrl || node.newWindow) return null;
  let destination = node.dest;
  try {
    if (typeof destination === 'string') destination = await pdf.getDestination(destination);
    if (!Array.isArray(destination) || destination.length < 2) return null;
    const target = destination[0];
    if (Number.isInteger(target)) return validPage(target + 1, pdf.numPages);
    if (target && Number.isInteger(target.num) && Number.isInteger(target.gen)) {
      return validPage((await pdf.getPageIndex(target)) + 1, pdf.numPages);
    }
  } catch { /* A malformed individual destination must never become a guessed page. */ }
  return null;
}

async function bookmarks(pdf, outline, labels) {
  const state = { count: 0, usable: 0, truncated: false };
  async function walk(nodes, depth = 1, prefix = 'b') {
    if (!Array.isArray(nodes)) return [];
    if (depth > MAX_DEPTH) { if (nodes.length) state.truncated = true; return []; }
    const result = [];
    for (let index = 0; index < nodes.length; index++) {
      if (state.count >= MAX_ENTRIES) { state.truncated = true; break; }
      const node = nodes[index];
      if (!node || typeof node !== 'object') continue;
      const id = `${prefix}-${index + 1}`;
      state.count++;
      const entryTitle = title(node.title, state) || '未命名章节';
      const page = await bookmarkPage(pdf, node);
      if (page !== null) state.usable++;
      const children = await walk(node.items, depth + 1, id);
      result.push({ id, title: entryTitle, page, printedPage: page !== null && labels?.[page - 1] ? String(labels[page - 1]).slice(0, 80) : null, children });
    }
    return result;
  }
  const entries = await walk(outline);
  return { entries, ...state };
}

// Group measured baselines before sorting left-to-right. PDF content-stream order
// may place all right-hand page numbers before all left-hand chapter titles.
function textLines(page, content) {
  const viewport = page.getViewport({ scale: 1 });
  const runs = content.items.filter(item => typeof item.str === 'string' && item.str.trim() && Array.isArray(item.transform)).map(item => {
    const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    return { text: item.str, x, y, width: Math.abs(item.width || 0), height: Math.max(1, Math.abs(item.height || Math.hypot(item.transform[2], item.transform[3]) || 10)) };
  }).filter(item => [item.x, item.y, item.width, item.height].every(Number.isFinite));
  const groups = [];
  for (const run of runs.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const group = groups.findLast(line => Math.abs(line.y - run.y) <= Math.min(line.height, run.height) * 0.35);
    if (group) group.runs.push(run);
    else groups.push({ y: run.y, height: run.height, runs: [run] });
  }
  return groups.map(group => {
    const sorted = group.runs.sort((a, b) => a.x - b.x);
    let text = '', previous;
    for (const run of sorted) {
      const gap = previous ? run.x - previous.x - previous.width : 0;
      const adjacentCjk = previous && CJK.test(previous.text.at(-1)) && CJK.test(run.text[0]);
      if (previous && !/\s$/.test(text) && !/^\s/.test(run.text) && gap > Math.min(previous.height, run.height) * (adjacentCjk ? 0.4 : 0.12)) text += ' ';
      text += run.text;
      previous = run;
    }
    const last = sorted.at(-1);
    const pageNumberX = /^(?:\d{1,5}|[ivxlcdm]{1,12})$/i.test(last.text.trim()) ? last.x : null;
    return { text: text.replace(/\s+/g, ' ').trim(), x: sorted[0].x, y: group.y, pageNumberX };
  }).filter(line => line.text);
}

function isHeading(text) {
  return /^(?:(?:\d+|[ivxlcdm]+)\s+)?(?:table\s+of\s+contents|contents|目\s*录)(?:\s*[（(]?\s*(?:continued|续)\s*[)）]?)?(?:\s+(?:\d+|[ivxlcdm]+))?$/i.test(text.normalize('NFKC'));
}
function isRoman(text) {
  return /^(?=[ivxlcdm]+$)m{0,4}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i.test(text);
}
function numbering(text) {
  const match = text.match(/^(\d+(?:\.\d+)*)(?:\.?\s+|(?=[\p{Script=Han}]))/u);
  if (match) return match[1].split('.').length;
  if (/^(?:chapter|part|section)\s+\w+\b|^第[一二三四五六七八九十百零〇\d]+[章节篇部]/i.test(text)) return 1;
  return null;
}

function parseLine(line) {
  const match = line.text.match(/^(.+?)(?:\s+|[.·…]{2,}\s*)(\d{1,5}|[ivxlcdm]{1,12})\s*$/i);
  if (!match || (!/^\d+$/.test(match[2]) && !isRoman(match[2]))) return null;
  const entryTitle = match[1].replace(/[\s.·…]+$/g, '').trim();
  if (!/\p{L}/u.test(entryTitle) || isHeading(entryTitle) || entryTitle.length < 2) return null;
  return { title: entryTitle, printedPage: match[2], x: line.x, y: line.y, pageNumberX: line.pageNumberX, level: numbering(entryTitle), leader: /[.·…]{2,}/u.test(line.text) };
}

function pageEntries(lines) {
  const entries = [];
  let pending = [];
  for (const line of lines) {
    if (isHeading(line.text) || /^\d+$/.test(line.text) || isRoman(line.text)) { pending = []; continue; }
    const entry = parseLine(line);
    if (entry) {
      if (pending.length && entry.level === null && pending.length <= 2 && line.y - pending.at(-1).y < 40
          && line.x >= pending[0].x - 5 && line.x - pending[0].x < 80) {
        entry.title = `${pending.map(item => item.text).join(' ')} ${entry.title}`;
        entry.level = numbering(entry.title);
        entry.x = pending[0].x;
      }
      entries.push(entry);
      pending = [];
    } else if (line.text.length <= 200 && /\p{L}/u.test(line.text) && !/[.!?。！？]$/.test(line.text)) pending.push(line);
    else pending = [];
  }
  return entries;
}

function buildTree(rows, state) {
  const entries = [], stack = [];
  const minX = Math.min(...rows.map(row => row.x));
  for (let index = 0; index < rows.length; index++) {
    if (index >= MAX_ENTRIES) { state.truncated = true; break; }
    const row = rows[index];
    const level = row.level ?? Math.max(1, Math.min(4, 1 + Math.round((row.x - minX) / 24)));
    while (stack.length && stack.at(-1).level >= level) stack.pop();
    if (stack.length >= MAX_DEPTH) { state.truncated = true; continue; }
    const entry = { id: `c-${index + 1}`, title: title(row.title, state), page: null, printedPage: row.printedPage, children: [] };
    (stack.at(-1)?.entry.children || entries).push(entry);
    row.entry = entry;
    stack.push({ level, entry });
  }
  return entries;
}

function anchorTitle(text) {
  return text.normalize('NFKC').toLowerCase()
    .replace(/^(?:chapter|part|section)\s+[\divxlcdm]+[\s.:：-]*/i, '')
    .replace(/^第[一二三四五六七八九十百零〇\d]+[章节篇部][\s.:：-]*/, '')
    .replace(/^\d+(?:\.\d+)*[\s.:：-]*/, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function headingOffsets(rows, pages, contentsPages, pageCount) {
  const targets = new Map();
  for (const row of rows) {
    if (!/^\d+$/.test(row.printedPage)) continue;
    const key = anchorTitle(row.title);
    if (key.length < (CJK.test(key) ? 2 : 6)) continue;
    if (!targets.has(key)) targets.set(key, new Set());
  }
  for (const page of pages) {
    if (contentsPages.has(page.page) || !validPage(page.page, pageCount) || typeof page.text !== 'string') continue;
    const lines = page.text.slice(0, 1500).split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 20);
    for (let start = 0; start < lines.length; start++) {
      for (let count = 1; count <= 3 && start + count <= lines.length; count++) {
        const key = anchorTitle(lines.slice(start, start + count).join(' '));
        targets.get(key)?.add(page.page);
      }
    }
  }
  const offsets = new Map();
  for (const row of rows) {
    if (!/^\d+$/.test(row.printedPage)) continue;
    const matches = targets.get(anchorTitle(row.title));
    if (matches?.size !== 1) continue;
    const offset = [...matches][0] - Number(row.printedPage);
    if (!offsets.has(offset)) offsets.set(offset, new Set());
    offsets.get(offset).add(Number(row.printedPage));
  }
  // Conflicting unique headings or a single repeated printed page are insufficient.
  if (offsets.size !== 1 || offsets.values().next().value.size < 2) return null;
  return offsets.keys().next().value;
}

function mapPages(rows, labels, pageCount, pages, contentsPages) {
  if (Array.isArray(labels) && labels.length === pageCount) {
    const index = new Map();
    labels.forEach((label, offset) => {
      const key = normalizedLabel(label);
      if (!key) return;
      if (index.has(key)) index.set(key, null); // Duplicate labels are not navigation targets.
      else index.set(key, offset + 1);
    });
    let matched = 0;
    const numericOffsets = new Map();
    for (const row of rows) {
      if (!row.entry) continue;
      row.entry.page = index.get(normalizedLabel(row.printedPage)) ?? null;
      if (row.entry.page === null) continue;
      matched++;
      if (/^\d+$/.test(row.printedPage)) {
        const offset = row.entry.page - Number(row.printedPage);
        if (!numericOffsets.has(offset)) numericOffsets.set(offset, new Set());
        numericOffsets.get(offset).add(Number(row.printedPage));
      }
    }
    if (matched) {
      const uniform = numericOffsets.size === 1 && numericOffsets.values().next().value.size >= 2;
      return { pageOffset: uniform ? numericOffsets.keys().next().value : null, offsetVerified: true };
    }
  }
  const pageOffset = headingOffsets(rows, pages, contentsPages, pageCount);
  if (pageOffset !== null) {
    for (const row of rows) {
      if (row.entry && /^\d+$/.test(row.printedPage)) row.entry.page = validPage(Number(row.printedPage) + pageOffset, pageCount);
    }
  }
  return { pageOffset, offsetVerified: pageOffset !== null };
}

/** Read only the supplied original PDF; metadata is computed in memory, never written. */
export async function extractToc(input, { getPageTexts = () => [] } = {}) {
  const result = empty();
  if (input instanceof URL && input.protocol !== 'file:') throw new Error('Only local PDF files are supported.');
  const source = input instanceof URL
    ? { url: input.href, disableStream: true, disableAutoFetch: true }
    : { data: new Uint8Array(input) };
  const task = getDocument({
    ...source, isEvalSupported: false, disableFontFace: true,
    useSystemFonts: false, useWorkerFetch: false, cMapUrl: `${path.join(pdfPackageDir, 'cmaps')}${path.sep}`,
    cMapPacked: true, standardFontDataUrl: `${path.join(pdfPackageDir, 'standard_fonts')}${path.sep}`,
    wasmUrl: `${path.join(pdfPackageDir, 'wasm')}${path.sep}`, stopAtErrors: true, verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    const labels = await pdf.getPageLabels().catch(() => null);
    const outline = await pdf.getOutline().catch(() => null);
    const native = await bookmarks(pdf, outline, labels);
    if (native.usable) return { ...result, source: 'bookmarks', entries: native.entries, truncated: native.truncated };
    const rows = [], contentsPages = new Set();
    let started = false;
    for (let number = 1; number <= Math.min(MAX_SCAN, pdf.numPages); number++) {
      const page = await pdf.getPage(number);
      let lines;
      try { lines = textLines(page, await page.getTextContent()); }
      finally { page.cleanup(); }
      result.scannedPages++;
      const headingIndex = lines.findIndex(line => isHeading(line.text));
      const candidates = pageEntries(headingIndex >= 0 ? lines.slice(headingIndex + 1) : lines);
      const meaningful = lines.filter(line => !isHeading(line.text) && !/^\d+$/.test(line.text) && !isRoman(line.text)).length;
      const pageNumberPositions = candidates.map(entry => entry.pageNumberX).filter(Number.isFinite);
      const alignedPageNumbers = pageNumberPositions.length >= 2 && Math.max(...pageNumberPositions) - Math.min(...pageNumberPositions) <= 18;
      const structuredEntries = candidates.filter(entry => entry.level !== null || entry.leader).length >= 2 || alignedPageNumbers;
      const continuation = started && structuredEntries && candidates.length >= 2 && candidates.length / Math.max(1, meaningful) >= 0.55;
      if (headingIndex >= 0 && candidates.length || continuation) {
        started = true;
        contentsPages.add(number);
        rows.push(...candidates);
        if (rows.length >= MAX_ENTRIES) { result.truncated = true; break; }
      } else if (started) break;
    }
    if (result.scannedPages === MAX_SCAN && pdf.numPages > MAX_SCAN) result.truncated = true;
    if (!rows.length) return result;
    result.source = 'contents';
    result.entries = buildTree(rows, result);
    Object.assign(result, mapPages(rows, labels, pdf.numPages, await getPageTexts(), contentsPages));
    return result;
  } finally { await task.destroy().catch(() => {}); }
}
