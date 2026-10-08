import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { READER_LAYOUT_PAGE_COUNT, readerLayoutPdf, readerLayoutSize, readerLayoutText } from './fixtures/reader-layout.mjs';

const pagesInGroup = (page, count) => {
  const start = Math.floor((page - 1) / count) * count + 1;
  return Array.from({ length: Math.min(count, READER_LAYOUT_PAGE_COUNT - start + 1) }, (_, index) => start + index);
};
const assertRect = (actual, expected) => {
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(Number.isFinite(actual[key]) && actual[key] >= 0 && actual[key] <= 1, `${key} must be normalized`);
    if (expected) assert.ok(Math.abs(actual[key] - expected[key]) < .006, `${key}: ${actual[key]} vs ${expected[key]}`);
  }
  assert.ok(actual.x + actual.width <= 1.001 && actual.y + actual.height <= 1.001);
};

// Real pointer selection and saved annotation readback against an isolated
// multi-page fixture. The display tests never configure or call an external API.
export async function readerLayoutWorkflow({ context, base, onLayoutPreview }) {
  // A fresh browser storage partition verifies the default without inheriting
  // deliberate zoom preferences from earlier workflows in the shared runner.
  const layoutContext = await context.browser().newContext({ viewport: { width: 2560, height: 1440 } });
  const page = await layoutContext.newPage(), errors = [], external = [], translationCalls = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith(`${base}/`)) external.push(request.url());
    if (request.url().includes('/api/translation/') && !['GET', 'HEAD'].includes(request.method())) translationCalls.push(request.url());
  });
  const upload = async (variant, mixedSizes = false) => {
    const form = new FormData(); form.append('file', new Blob([readerLayoutPdf({ variant, mixedSizes })], { type: 'application/pdf' }), `original-reader-${variant}.pdf`);
    const result = await fetch(`${base}/api/documents`, { method: 'POST', body: form });
    assert.equal(result.status, 201); const document = (await result.json()).document;
    assert.equal(document.pageCount, READER_LAYOUT_PAGE_COUNT); return document;
  };
  const book = await upload('browser-layout'), other = await upload('browser-switch'), mixed = await upload('browser-mixed-sizes', true);
  const notes = '原创布局验收笔记：切换阅读方式保留此段。';
  const seeded = await fetch(`${base}/api/documents/${book.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notesZh: notes, notesEn: '' }) });
  assert.equal(seeded.status, 200);
  const readBook = async () => (await (await fetch(`${base}/api/documents/${book.id}`)).json());
  const before = (await readBook()).document;
  const tile = number => page.locator(`.pdf-paper[data-page="${number}"]`);
  const flow = page.getByRole('combobox', { name: '翻页方式', exact: true });
  const layout = page.getByRole('combobox', { name: '页面布局', exact: true });
  const zoom = page.getByRole('combobox', { name: '阅读缩放', exact: true });
  const pageInput = page.getByRole('spinbutton', { name: '页码', exact: true });
  const selectionBar = page.locator('.selection-bar');
  async function ready(number) {
    await expect(tile(number).getByLabel(`PDF 第 ${number} 页`, { exact: true })).toBeVisible();
    await expect(tile(number).locator('.textLayer')).toContainText(readerLayoutText(number));
  }
  async function goto(number) {
    await pageInput.fill(String(number)); await pageInput.press('Enter');
    await expect(pageInput).toHaveValue(String(number)); await ready(number);
  }
  async function group(number, count) {
    const expected = pagesInGroup(number, count);
    await expect.poll(() => page.locator('.pdf-paper[data-page]').evaluateAll(elements => elements.map(element => Number(element.dataset.page)))).toEqual(expected);
    await Promise.all(expected.map(ready));
    return expected;
  }
  async function selectText(number) {
    const line = tile(number).locator('.textLayer span').filter({ hasText: readerLayoutText(number) });
    await expect(line).toBeVisible(); await line.scrollIntoViewIfNeeded();
    const bounds = await line.boundingBox(); assert.ok(bounds);
    await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2); await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 8 }); await page.mouse.up();
    await expect(selectionBar.locator('.selection-summary p')).toHaveText(readerLayoutText(number));
  }
  async function dragRegion(number, from = [.15, .30], to = [.60, .45]) {
    const layer = tile(number).getByLabel('拖动框选批注区域', { exact: true });
    await expect(layer).toBeVisible(); await layer.scrollIntoViewIfNeeded();
    const bounds = await layer.boundingBox(); assert.ok(bounds);
    await page.mouse.move(bounds.x + from[0] * bounds.width, bounds.y + from[1] * bounds.height); await page.mouse.down();
    await page.mouse.move(bounds.x + to[0] * bounds.width, bounds.y + to[1] * bounds.height, { steps: 7 }); await page.mouse.up();
    await expect(selectionBar).toContainText(`第 ${number} 页`);
    return { x: Math.min(from[0], to[0]), y: Math.min(from[1], to[1]), width: Math.abs(to[0] - from[0]), height: Math.abs(to[1] - from[1]) };
  }
  async function saveAnnotation(number, kind, comment) {
    await page.getByRole('button', { name: kind === 'region' ? '添加区域批注' : '高亮并批注', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: kind === 'region' ? /区域批注/ : /高亮与批注/ });
    if (kind === 'region') await expect(dialog.getByRole('img', { name: `第 ${number} 页框选区域预览`, exact: true })).toBeVisible();
    else await expect(dialog.locator('blockquote')).toHaveText(readerLayoutText(number));
    await dialog.getByRole('textbox', { name: '批注评论', exact: true }).fill(comment);
    await onLayoutPreview?.(page, `browser-page-${number}-${kind}-preview`);
    const pending = page.waitForResponse(response => response.url() === `${base}/api/documents/${book.id}/annotations` && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '保存批注', exact: true }).click();
    const response = await pending; assert.equal(response.status(), 201);
    const request = response.request().postDataJSON(); assert.equal(request.page, number); assert.equal(Object.hasOwn(request, 'preview'), false);
    const { annotation } = await response.json(); assert.equal(annotation.page, number); assert.equal(annotation.kind, kind);
    await expect(dialog).toBeHidden(); return annotation;
  }
  try {
    await page.setViewportSize({ width: 2560, height: 1440 });
    await page.goto(`${base}/?document=${book.id}&page=1`); await ready(1);
    await expect(flow).toHaveValue('paged'); await expect(layout).toHaveValue('1'); await expect(zoom).toHaveValue('fit');
    const collapseLibrary = page.getByRole('button', { name: '收起文献栏', exact: true });
    if (await collapseLibrary.isVisible()) await collapseLibrary.click();
    const collapseNotes = page.getByRole('button', { name: '收起笔记面板', exact: true });
    if (await collapseNotes.isVisible()) await collapseNotes.click();
    const contentWidth = () => page.locator('.pdf-scroll').evaluate(element => {
      const style = getComputedStyle(element); return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    });
    await expect.poll(async () => Math.abs((await tile(1).boundingBox()).width - await contentWidth())).toBeLessThan(6);
    const wide = (await tile(1).boundingBox()).width;
    assert.ok(wide > 600 * 1.65 + 300, 'Fit width must exceed the old 165% ceiling in the real wide container');
    assert.ok(await tile(1).locator('canvas').evaluate((canvas, width) => canvas.width >= width - 1, wide), 'Wide fit must preserve at least one backing pixel per displayed pixel');
    await onLayoutPreview?.(page, 'browser-width-wide');
    await page.setViewportSize({ width: 1600, height: 1100 });
    await expect.poll(async () => Math.abs((await tile(1).boundingBox()).width - await contentWidth())).toBeLessThan(6);
    assert.ok((await tile(1).boundingBox()).width < wide - 500, 'Fit width must respond to viewport resize');
    await page.setViewportSize({ width: 2560, height: 1440 });

    await layout.selectOption('2'); await goto(1); await group(1, 2);
    const beforeCrossPage = (await readBook()).annotations;
    await page.evaluate(texts => {
      const node = (number, text) => [...document.querySelectorAll(`.pdf-paper[data-page="${number}"] .textLayer span`)].find(span => !span.children.length && span.textContent === text)?.firstChild;
      const start = node(1, texts[0]), end = node(2, texts[1]);
      if (start?.nodeType !== Node.TEXT_NODE || end?.nodeType !== Node.TEXT_NODE) throw new Error('Real page text endpoints are missing');
      const range = document.createRange(); range.setStart(start, 0); range.setEnd(end, end.textContent.length);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }, [readerLayoutText(1), readerLayoutText(2)]);
    await expect(page.locator('.pdf-selection-error')).toContainText('同一页'); await expect(selectionBar).toHaveCount(0);
    assert.deepEqual((await readBook()).annotations, beforeCrossPage, 'A cross-page native range must not create a partial-page annotation');
    await page.evaluate(() => window.getSelection().removeAllRanges()); await expect(page.locator('.pdf-selection-error')).toHaveCount(0);
    console.log('PASS: a native DOM range across two visible PDF text layers is rejected with a same-page hint and unchanged annotations');

    for (const count of [2, 4, 6, 9]) {
      await layout.selectOption(String(count)); await expect(zoom).toHaveValue('page'); await goto(1); await group(1, count);
      const boxes = await Promise.all(pagesInGroup(1, count).map(number => tile(number).boundingBox()));
      const columns = count === 2 || count === 4 ? 2 : 3;
      assert.ok(boxes[1].x > boxes[0].x + boxes[0].width - 2, `${count}-page grid must show separate columns`);
      assert.ok(boxes[1].x - boxes[0].x - boxes[0].width <= 18, `${count}-page whole-screen grid must pack neighboring paper with its intended gap`);
      assert.ok(Math.abs(boxes[1].y - boxes[0].y) < 2, `${count}-page first row must align`);
      if (count > columns) assert.ok(boxes[columns].y > boxes[0].y + boxes[0].height - 2, `${count}-page grid must contain its next row`);
      const scroll = await page.locator('.pdf-scroll').boundingBox();
      assert.ok(boxes.every(box => box.y >= scroll.y - 2 && box.y + box.height <= scroll.y + scroll.height + 2), 'Whole-screen mode must fit every tile vertically');
      await page.getByRole('button', { name: '下一页', exact: true }).click(); await expect(pageInput).toHaveValue(String(count + 1)); await group(count + 1, count);
      await page.getByRole('button', { name: '上一页', exact: true }).click(); await expect(pageInput).toHaveValue('1'); await group(1, count);
      await goto(count + 2); await group(count + 2, count); await expect(pageInput).toHaveValue(String(count + 2));
      await goto(READER_LAYOUT_PAGE_COUNT); await group(READER_LAYOUT_PAGE_COUNT, count);
      await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: '上一页', exact: true }).click();
      const previousStart = pagesInGroup(READER_LAYOUT_PAGE_COUNT, count)[0] - count;
      await expect(pageInput).toHaveValue(String(previousStart)); await group(previousStart, count);
      await onLayoutPreview?.(page, `browser-grid-${count}`);
    }
    console.log('PASS: real wide-container fit and resize, 2/4/6/9 grids, whole-screen heights, exact page requests and partial final groups');
    await goto(1); await expect.poll(async () => (await readBook()).document.lastPage).toBe(1);
    await page.reload(); await ready(1);
    await expect(flow).toHaveValue('paged'); await expect(layout).toHaveValue('9'); await expect(zoom).toHaveValue('page'); await group(1, 9);
    await goto(1); await zoom.selectOption('2');
    await expect.poll(async () => (await tile(1).boundingBox()).width).toBeCloseTo(1200, 0); await group(1, 9);
    const raster = await page.locator('.pdf-paper canvas').evaluateAll(canvases => ({ total: canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0), largest: Math.max(...canvases.map(canvas => Math.max(canvas.width, canvas.height))) }));
    assert.ok(raster.total <= 12_000_000 && raster.largest <= 4096, `Nine-page 200% rendering must stay within the shared raster budget (${JSON.stringify(raster)})`);
    await zoom.selectOption('page');

    await page.getByRole('button', { name: '展开文献栏', exact: true }).click();
    await page.locator(`[data-document-id="${mixed.id}"] .document-item`).click();
    await page.getByRole('button', { name: '收起文献栏', exact: true }).click();
    await layout.selectOption('4'); await goto(1); await group(1, 4);
    const mixedScroll = await page.locator('.pdf-scroll').boundingBox();
    for (const number of [1, 2, 3, 4]) {
      const bounds = await tile(number).boundingBox(), size = readerLayoutSize(number, true);
      assert.ok(Math.abs(bounds.width / bounds.height - size.width / size.height) < .005, `Mixed page ${number} must retain its real aspect ratio`);
      assert.ok(bounds.y >= mixedScroll.y - 2 && bounds.y + bounds.height <= mixedScroll.y + mixedScroll.height + 2, `Mixed page ${number} must fit inside the whole-screen group`);
    }
    await onLayoutPreview?.(page, 'browser-grid-4-mixed-sizes');
    await page.getByRole('button', { name: '展开文献栏', exact: true }).click();
    await page.locator(`[data-document-id="${book.id}"] .document-item`).click();
    await page.getByRole('button', { name: '收起文献栏', exact: true }).click();
    console.log('PASS: a whole-screen grid preserves mixed landscape/tall page proportions and fits all pages inside the viewport');

    await layout.selectOption('1'); await zoom.selectOption('page'); await goto(1); await flow.selectOption('continuous'); await ready(1);
    const scrollBox = await page.locator('.pdf-scroll').boundingBox();
    await page.mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + scrollBox.height / 2); await page.mouse.wheel(0, scrollBox.height * 3);
    await expect.poll(async () => Number(await pageInput.inputValue())).toBeGreaterThan(1);
    await page.locator('.pdf-group[data-group-start="15"]').evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await expect(pageInput).toHaveValue('15'); await ready(15);
    const canvases = await page.locator('.pdf-paper canvas').count();
    assert.ok(canvases > 0 && canvases <= 7 && canvases < READER_LAYOUT_PAGE_COUNT, `Continuous view must retain only nearby page canvases (actual ${canvases})`);
    assert.ok(await page.locator('.textLayer span').count() < READER_LAYOUT_PAGE_COUNT * 6, 'Continuous rendering must also bound text layers');
    await expect.poll(async () => (await readBook()).document.lastPage).toBe(15);
    await onLayoutPreview?.(page, 'browser-continuous-page-15');
    console.log('PASS: real continuous wheel/scroll navigation reaches later pages, updates active page and bounds rendered canvas/text resources');

    await flow.selectOption('paged'); await layout.selectOption('9'); await goto(1); await group(1, 9);
    await selectText(5);
    const text = await saveAnnotation(5, 'text', '布局验收：第五页文字引文。');
    assert.equal(text.quote, readerLayoutText(5)); text.rects.forEach(rect => assertRect(rect));
    await page.getByRole('button', { name: '区域批注', exact: true }).click();
    const expected = await dragRegion(5);
    const region = await saveAnnotation(5, 'region', '布局验收：第五页图形区域。');
    assert.equal(region.quote, ''); assert.equal(region.rects.length, 1); assertRect(region.rects[0], expected);
    await expect(tile(5).locator(`[data-annotation="${region.id}"]`)).toBeVisible();
    const saved = (await readBook()).annotations;
    assert.equal(saved.find(item => item.id === text.id).page, 5); assert.equal(saved.find(item => item.id === region.id).page, 5);
    await dragRegion(5); await layout.selectOption('4'); await expect(selectionBar).toHaveCount(0);
    await goto(5); await dragRegion(5); await flow.selectOption('continuous'); await expect(selectionBar).toHaveCount(0);
    await flow.selectOption('paged'); await layout.selectOption('9'); await goto(1); await group(1, 9);
    await page.getByRole('button', { name: '区域批注', exact: true }).click(); await selectText(5);
    await layout.selectOption('4'); await expect(selectionBar).toHaveCount(0);
    await goto(5); await selectText(5); await flow.selectOption('continuous'); await expect(selectionBar).toHaveCount(0);
    await flow.selectOption('paged'); await layout.selectOption('4'); await goto(5); await selectText(5);
    const expandLibrary = page.getByRole('button', { name: '展开文献栏', exact: true }); if (await expandLibrary.isVisible()) await expandLibrary.click();
    await page.locator(`[data-document-id="${other.id}"] .document-item`).click();
    await expect(page.locator('.header-title h1')).toHaveText(other.title); await expect(selectionBar).toHaveCount(0);
    const after = (await readBook()).document;
    assert.equal(after.notesZh, before.notesZh); assert.equal(after.notesEn, before.notesEn); assert.equal(after.notesRevision, before.notesRevision);
    assert.deepEqual(Buffer.from(await (await fetch(`${base}/api/documents/${book.id}/file`)).arrayBuffer()), readerLayoutPdf({ variant: 'browser-layout' }));
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(translationCalls, []);
    console.log('PASS: real text/region selection on the fifth grid tile saves true page and normalized coordinates; document/mode/layout changes cancel drafts without note/API writes');
  } finally {
    if (!page.isClosed()) {
      if (await flow.isVisible()) await flow.selectOption('paged');
      if (await layout.isVisible()) await layout.selectOption('1');
      if (await zoom.isVisible()) await zoom.selectOption('fit');
      await page.close();
    }
    await layoutContext.close();
  }
}
