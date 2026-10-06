import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { bookmarkedPdf } from './fixtures/toc-browser.mjs';
import { graphicsOnlyPdf } from './fixtures/scan-browser.mjs';

export function assertHandoffPrompt(prompt, { title, page, quote, excluded = [] }) {
  const sourceLine = prompt.split('\n').find(line => line.includes('"title"') && line.includes('"pdfPage"'));
  assert.ok(sourceLine, 'The portable prompt must retain the source title and physical PDF page');
  const source = JSON.parse(sourceLine.slice(sourceLine.indexOf('{')));
  assert.deepEqual(source, { title, pdfPage: page }, 'Local document/session identifiers must not enter the portable source');
  if (quote !== undefined) assert.ok(prompt.includes(JSON.stringify(quote)), 'The complete confirmed quote must be preserved as quoted source material');
  assert.doesNotMatch(prompt, /paperdesk_[a-z_]+|sessionId|documentId|reader-sessions|data:image\//);
  for (const value of excluded) if (value) assert.ok(!prompt.includes(value), `The portable prompt must not contain ${value}`);
}

export function assertCropPng(bytes, preview, pageSize) {
  const expected = Buffer.from(preview.split(',')[1], 'base64');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update(expected).digest('hex'), 'The exported file must be the exact confirmed crop');
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  assert.ok(size.width > 8 && size.height > 8);
  assert.ok(size.width < pageSize.width && size.height < pageSize.height, 'Export must not silently substitute the full page');
  return size;
}

// The caller owns an isolated app and browser context. No external ChatGPT page
// is opened: we inspect the ordinary link and download only original fixtures.
export async function chatgptHandoffWorkflow({ context, base, onPreview }) {
  const pages = [], errors = [];
  const upload = async (name, bytes) => {
    const body = new FormData();
    body.append('file', new Blob([bytes, Buffer.from('\n% Original manual ChatGPT handoff regression\n')], { type: 'application/pdf' }), name);
    const response = await fetch(`${base}/api/documents`, { method: 'POST', body });
    assert.equal(response.status, 201);
    return (await response.json()).document;
  };
  const getDoc = async id => (await (await fetch(`${base}/api/documents/${id}`)).json()).document;
  const open = async (doc, pageNumber) => {
    const page = await context.newPage(); pages.push(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const sessions = [], network = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().includes('/api/reader-sessions/')) sessions.push({ id: request.url().split('/').at(-1), ...request.postDataJSON() });
      if (/^https?:/.test(request.url())) network.push(request.url());
    });
    await page.addInitScript(() => {
      window.handoffMessages = [];
      window.handoffClipboard = { mode: 'reject', calls: [], pending: [] };
      window.addEventListener('message', event => { if (event.data?.method) window.handoffMessages.push(event.data.method); });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => {
        window.handoffClipboard.calls.push(text);
        if (window.handoffClipboard.mode === 'hold') return new Promise(resolve => window.handoffClipboard.pending.push(resolve));
        throw new Error('Isolated clipboard rejection fixture');
      } } });
    });
    await page.goto(`${base}/?document=${doc.id}&page=${pageNumber}`);
    await expect(page.getByLabel(`PDF 第 ${pageNumber} 页`, { exact: true })).toBeVisible();
    await expect.poll(() => sessions.length).toBeGreaterThan(0);
    return { page, sessions, network };
  };
  const handoff = page => page.getByRole('dialog', { name: 'ChatGPT 提问准备', exact: true });
  const question = dialog => dialog.getByRole('textbox', { name: '向 ChatGPT 提问', exact: true });
  const prepared = dialog => dialog.getByRole('textbox', { name: '准备给 ChatGPT 的问题', exact: true });
  const assertPrivate = async reader => {
    assert.ok(reader.sessions.every(session => session.selection === null), 'Manual handoff must never publish a selection to a Codex reader session');
    assert.ok(reader.network.every(url => new URL(url).origin === new URL(base).origin), 'Preparing for ChatGPT must not upload context or prefetch an external destination');
    assert.equal((await reader.page.evaluate(() => window.handoffMessages)).some(method => ['ui/message', 'ui/update-model-context'].includes(method)), false);
    const response = await fetch(`${base}/api/reader-context?sessionId=${reader.sessions.at(-1).id}`);
    assert.equal(response.status, 200); assert.equal((await response.json()).selection, null);
  };
  const verifyPreparation = async (dialog, info) => {
    await expect(dialog).toBeVisible();
    if (!await dialog.locator('details').evaluate(element => element.open)) await dialog.locator('summary').filter({ hasText: '手动备用方式' }).click();
    await expect(question(dialog)).toHaveAttribute('maxlength', '4000');
    assert.ok((await question(dialog).inputValue()).trim().length > 0);
    await expect(prepared(dialog)).toHaveAttribute('readonly', '');
    assertHandoffPrompt(await prepared(dialog).inputValue(), info);
    const link = dialog.getByRole('link', { name: '打开 ChatGPT', exact: true });
    await expect(link).toHaveAttribute('href', 'https://chatgpt.com/');
    await expect(link).toHaveAttribute('target', '_blank');
    const copy = dialog.getByRole('button', { name: '复制 ChatGPT 提问', exact: true });
    const initial = await question(dialog).inputValue();
    await question(dialog).fill('  \n  '); await expect(copy).toBeDisabled();
    await question(dialog).fill(initial); await copy.click();
    await expect(dialog.getByRole('status')).toContainText(/手动复制/);
    assert.equal(await prepared(dialog).evaluate(element => element.selectionStart === 0 && element.selectionEnd === element.value.length), true, 'Clipboard refusal must leave the whole prompt selected for manual copying');
  };
  try {
    const book = await upload('original-chatgpt-text.pdf', bookmarkedPdf());
    const scan = await upload('original-chatgpt-region.pdf', graphicsOnlyPdf());
    const privateNote = 'CHATGPT_HANDOFF_PRIVATE_NOTE：不能跟随选区导出。';
    assert.equal((await fetch(`${base}/api/documents/${book.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notesZh: privateNote, notesEn: '' }) })).status, 200);
    const reader = await open(book, 2), page = reader.page;
    await expect(page.getByRole('textbox', { name: '笔记', exact: true })).toHaveValue(privateNote);
    const span = page.locator('.textLayer span').filter({ hasText: /^1 Introduction$/ });
    await expect(span).toBeVisible(); await span.scrollIntoViewIfNeeded();
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('.pdf-paper')).not.toHaveClass(/is-loading/);
    const dragLine = await span.evaluate(element => {
      // Measure rendered glyphs, not the PDF.js span's CSS box. Ending inside
      // that box can leave the caret before the last glyph after font scaling.
      // This Range only measures; the selection below is a real mouse drag.
      const range = document.createRange(); range.selectNodeContents(element);
      const text = range.getBoundingClientRect(), layer = element.closest('.textLayer').getBoundingClientRect();
      return { start: text.left + .25, lastGlyphEdge: text.right - .25, end: Math.min(text.right + 4, layer.right - 1), y: text.top + text.height / 2 };
    });
    assert.ok(dragLine.end > dragLine.start);
    await page.mouse.move(dragLine.start, dragLine.y); await page.mouse.down();
    // Visit the last glyph before entering blank page space. With only eight
    // widely spaced events, the final in-span event can precede its midpoint;
    // Chromium then keeps that incomplete caret position outside the span.
    await page.mouse.move(dragLine.lastGlyphEdge, dragLine.y, { steps: 12 });
    await page.mouse.move(dragLine.end, dragLine.y); await page.mouse.up();
    const nativeQuote = await page.evaluate(() => window.getSelection()?.toString());
    assert.equal(nativeQuote, '1 Introduction', 'The real browser drag must include the complete last glyph');
    await expect(page.getByRole('button', { name: '交给 ChatGPT', exact: true })).toBeVisible();
    const summary = page.locator('.selection-summary p');
    await expect(summary).toHaveText('1 Introduction');
    const quote = await summary.textContent(); assert.equal(quote, '1 Introduction');
    const noteRevision = (await getDoc(book.id)).notesRevision;
    await page.getByRole('button', { name: '交给 ChatGPT', exact: true }).click();
    let dialog = handoff(page);
    await verifyPreparation(dialog, { title: book.title, page: 2, quote, excluded: [book.id, reader.sessions.at(-1).id, privateNote, 'A short introduction for navigation checks.'] });
    const custom = '自定义问题 α < β：请只解释所选文字。';
    await question(dialog).fill(custom); assert.ok((await prepared(dialog).inputValue()).includes(custom));
    await onPreview?.(page);
    await assertPrivate(reader);
    assert.equal((await getDoc(book.id)).notesRevision, noteRevision);
    await dialog.getByRole('button', { name: '关闭 ChatGPT 提问准备', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(page.getByLabel('PDF 第 3 页', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '交给 ChatGPT', exact: true })).toBeHidden();
    await assertPrivate(reader);
    console.log('PASS: browser text handoff preserves the real quote, provides clipboard fallback and exposes only a fixed ChatGPT link without sharing');

    const regions = await open(scan, 1), regionPage = regions.page;
    await regionPage.getByRole('button', { name: '区域批注', exact: true }).click();
    const drag = async (from, to) => {
      const layer = regionPage.getByLabel('拖动框选批注区域', { exact: true }); await expect(layer).toBeVisible();
      const bounds = await layer.boundingBox(); assert.ok(bounds);
      await regionPage.mouse.move(bounds.x + from[0] * bounds.width, bounds.y + from[1] * bounds.height); await regionPage.mouse.down();
      await regionPage.mouse.move(bounds.x + to[0] * bounds.width, bounds.y + to[1] * bounds.height, { steps: 8 }); await regionPage.mouse.up();
      await regionPage.getByRole('button', { name: '交给 ChatGPT', exact: true }).click();
      return handoff(regionPage);
    };
    dialog = await drag([.5, .36], [.15, .18]);
    await verifyPreparation(dialog, { title: scan.title, page: 1, excluded: [scan.id, regions.sessions.at(-1).id, privateNote] });
    const preview = await dialog.getByRole('img', { name: '第 1 页框选区域预览', exact: true }).getAttribute('src');
    const pageSize = await regionPage.getByLabel('PDF 第 1 页', { exact: true }).evaluate(canvas => ({ width: canvas.width, height: canvas.height }));
    const pending = regionPage.waitForEvent('download');
    await dialog.getByRole('button', { name: '保存选区图片', exact: true }).click();
    const download = await pending; assert.match(download.suggestedFilename(), /\.png$/);
    assertCropPng(await readFile(await download.path()), preview, pageSize);
    await question(dialog).fill('旧弹窗正在复制的问题');
    await regionPage.evaluate(() => { window.handoffClipboard.mode = 'hold'; });
    await dialog.getByRole('button', { name: '复制 ChatGPT 提问', exact: true }).click();
    await expect.poll(() => regionPage.evaluate(() => window.handoffClipboard.pending.length)).toBe(1);
    const copiesBeforeReopen = await regionPage.evaluate(() => window.handoffClipboard.calls.length);
    await dialog.getByRole('button', { name: '关闭 ChatGPT 提问准备', exact: true }).click();
    await regionPage.getByRole('button', { name: '交给 ChatGPT', exact: true }).click();
    dialog = handoff(regionPage);
    await dialog.locator('summary').filter({ hasText: '手动备用方式' }).click();
    await expect(dialog.getByRole('button', { name: '等待上次复制…', exact: true })).toBeDisabled();
    const reopenedPrompt = await prepared(dialog).inputValue(), reopenedStatus = await dialog.getByRole('status').textContent();
    assert.ok(!reopenedPrompt.includes('旧弹窗正在复制的问题'));
    await regionPage.evaluate(() => { window.handoffClipboard.pending.shift()(); window.handoffClipboard.mode = 'reject'; });
    await expect(dialog.getByRole('button', { name: '复制 ChatGPT 提问', exact: true })).toBeEnabled();
    await expect(prepared(dialog)).toHaveValue(reopenedPrompt);
    await expect(dialog.getByRole('status')).toHaveText(reopenedStatus);
    assert.equal(await regionPage.evaluate(() => window.handoffClipboard.calls.length), copiesBeforeReopen, 'Reopening cannot start a second clipboard write while the first is pending');
    await question(dialog).fill('不能复用到下一页的旧问题');
    await assertPrivate(regions);
    await dialog.getByRole('button', { name: '关闭 ChatGPT 提问准备', exact: true }).click();
    await regionPage.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(regionPage.getByLabel('PDF 第 2 页', { exact: true })).toBeVisible();
    await expect(handoff(regionPage)).toBeHidden();
    await expect(regionPage.getByRole('button', { name: '交给 ChatGPT', exact: true })).toBeHidden();
    dialog = await drag([.20, .25], [.65, .45]);
    await dialog.locator('summary').filter({ hasText: '手动备用方式' }).click();
    await expect(question(dialog)).not.toHaveValue('不能复用到下一页的旧问题');
    assertHandoffPrompt(await prepared(dialog).inputValue(), { title: scan.title, page: 2, excluded: [scan.id] });
    assert.notEqual(await dialog.getByRole('img', { name: '第 2 页框选区域预览', exact: true }).getAttribute('src'), preview);
    await assertPrivate(regions);
    assert.deepEqual((await (await fetch(`${base}/api/documents/${scan.id}`)).json()).annotations, []);
    assert.deepEqual(errors, [], 'Manual handoff must not cause uncaught browser exceptions');
    console.log('PASS: browser region handoff downloads the exact cropped PNG and never reuses a previous page image/question');
  } finally {
    await Promise.allSettled(pages.map(page => page.close()));
  }
}
