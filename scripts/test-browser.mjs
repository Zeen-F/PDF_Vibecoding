import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createServer as createViteServer } from 'vite';
import { createApp } from '../server/app.mjs';
import { bookmarkedPdf, unverifiedContentsPdf, verifiedContentsPdf, writeLargeUploadPdf } from '../tests/fixtures/toc-browser.mjs';
import { graphicsOnlyPdf } from '../tests/fixtures/scan-browser.mjs';
import { pluginWorkflow } from '../tests/plugin.browser.mjs';
import { nativeReaderWorkflow } from '../tests/reader-ui.browser.mjs';
import { chatgptHandoffWorkflow } from '../tests/chatgpt-handoff.browser.mjs';
import { createChatgptRunnerFixture, chatgptAutomationWorkflow } from '../tests/chatgpt-automation.browser.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pageErrors = [];
let tempDir;
let runtime;
let appServer;
let harnessServer;
let browser;
let cleanupPromise;

function cleanup() {
  cleanupPromise ??= (async () => {
    await browser?.close();
    await harnessServer?.close();
    if (appServer) {
      appServer.closeAllConnections();
      await new Promise((resolve, reject) => appServer.close(error => error ? reject(error) : resolve()));
    }
    await runtime?.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  })();
  return cleanupPromise;
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(code));
  });
}

async function selectionRegression(context) {
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(`Selection harness: ${error.message}`));
  const port = harnessServer.httpServer.address().port;
  await page.goto(`http://127.0.0.1:${port}/tests/selection-harness.html`);
  await page.getByRole('button', { name: 'Run selection tests' }).click();
  await page.waitForFunction(() => window.selectionTestResults !== undefined, undefined, { timeout: 30000 });
  const result = await page.evaluate(() => window.selectionTestResults);
  assert.equal(result.total, 17, 'The browser runner must execute all 17 selection regressions');
  assert.equal(result.failed, 0, JSON.stringify(result.tests.filter(test => test.status !== 'PASS'), null, 2));
  assert.equal(result.passed, 17);
  console.log('PASS: all 17 real-DOM selection regressions');
  await page.close();
}

async function readingWorkflow(context) {
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(`Reading app: ${error.message}`));
  const base = `http://127.0.0.1:${appServer.address().port}`;
  const library = await (await fetch(`${base}/api/documents`)).json();
  assert.deepEqual(library.documents, [], 'Browser tests must begin with an isolated empty library');
  await page.goto(base);
  const imported = page.waitForResponse(response => response.url() === `${base}/api/documents` && response.request().method() === 'POST');
  await page.getByLabel('选择 PDF 文件').setInputFiles(join(root, 'public/examples/reading-demo.pdf'));
  const response = await imported;
  assert.equal(response.status(), 201);
  const { document } = await response.json();
  assert.equal(document.pageCount, 2);
  await expect(page.getByLabel('PDF 第 1 页', { exact: true })).toBeVisible();
  await expect(page.locator('.textLayer span').first()).toBeVisible();

  const notes = '## 浏览器验收\n\n相位裕度需要结合工作条件。\n\nCompare the claim with the evidence.';
  const editor = page.getByRole('textbox', { name: '笔记', exact: true });
  await expect(page.locator('.notes-body textarea')).toHaveCount(1);
  await editor.fill(notes);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.save-row [role="status"]')).toHaveText('已保存到本机');
  let saved = (await (await fetch(`${base}/api/documents/${document.id}`)).json()).document;
  assert.equal(saved.notesZh, notes);
  assert.equal(saved.notesEn, '');

  const pendingDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 Markdown', exact: true }).click();
  const download = await pendingDownload;
  assert.match(download.suggestedFilename(), /\.md$/);
  const exported = await readFile(await download.path(), 'utf8');
  assert.ok(exported.includes(notes), 'Export must preserve the complete mixed-language note');
  assert.ok(exported.includes('reading-demo.pdf'), 'Export must identify the imported source');

  // Reload after a successful save, with no recovery draft masking server persistence.
  assert.equal(await page.evaluate(id => localStorage.getItem(`paperdesk-draft-${id}`), document.id), null);
  await page.reload();
  await expect(editor).toHaveValue(notes);
  saved = (await (await fetch(`${base}/api/documents/${document.id}`)).json()).document;
  assert.equal(saved.notesZh, notes);
  assert.equal(saved.notesEn, '');

  // Exercise the real text-selection modal as well as the isolated DOM harness.
  const text = page.locator('.textLayer span').filter({ hasText: /^Reading with intention$/ });
  await expect(text).toBeVisible();
  const box = await text.boundingBox();
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.getByRole('button', { name: '高亮并批注', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /高亮与批注/ });
  await expect(dialog.locator('blockquote')).toHaveText('Reading with intention');
  await dialog.getByRole('textbox', { name: '批注评论', exact: true }).fill('文字批注回归，保留真实引文。');
  const annotationResponse = page.waitForResponse(result => result.url() === `${base}/api/documents/${document.id}/annotations` && result.request().method() === 'POST');
  await dialog.getByRole('button', { name: '保存批注', exact: true }).click();
  const created = await annotationResponse;
  assert.equal(created.status(), 201);
  assert.equal(Object.hasOwn(created.request().postDataJSON(), 'preview'), false);
  const { annotation } = await created.json();
  assert.equal(annotation.kind, 'text');
  assert.equal(annotation.quote, 'Reading with intention');
  await expect(dialog).not.toBeVisible();
  await expect(page.locator(`[data-annotation="${annotation.id}"]`).first()).toBeVisible();
  console.log('PASS: isolated PDF import, rendered page, single note save, Markdown download, reload and real text annotation');
  await page.close();
  return document;
}

async function legacyNotesWorkflow(context, sampleDocument) {
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(`Legacy notes: ${error.message}`));
  const base = `http://127.0.0.1:${appServer.address().port}`;
  const endpoint = `${base}/api/documents/${sampleDocument.id}`;
  const editor = page.getByRole('textbox', { name: '笔记', exact: true });
  const readDocument = async () => (await (await fetch(endpoint)).json()).document;
  await page.goto(base);
  await expect(editor).toBeVisible();

  const legacyZh = '## 浏览器验收\n\n旧笔记甲：先核对工作条件。';
  const legacyEn = '## Legacy evidence\n\nKeep the original second field intact until editing.';
  const combined = `${legacyZh}\n\n---\n\n${legacyEn}`;
  const setup = await fetch(endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notesZh: legacyZh, notesEn: legacyEn }) });
  assert.equal(setup.status, 200);
  const noteWrites = [];
  page.on('request', request => {
    if (request.url() !== endpoint || request.method() !== 'PATCH') return;
    const body = request.postDataJSON();
    if (Object.hasOwn(body, 'notesZh') || Object.hasOwn(body, 'notesEn')) noteWrites.push(body);
  });
  await page.reload();
  await expect(page.locator('.notes-body textarea')).toHaveCount(1);
  await expect(editor).toHaveValue(combined);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.save-row [role="status"]')).toHaveText('已保存到本机');
  const pendingDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 Markdown', exact: true }).click();
  const exported = await readFile(await (await pendingDownload).path(), 'utf8');
  assert.ok(exported.includes(combined));
  assert.equal(exported.split(legacyZh).length - 1, 1);
  assert.equal(exported.split(legacyEn).length - 1, 1);
  let raw = await readDocument();
  assert.equal(raw.notesZh, legacyZh);
  assert.equal(raw.notesEn, legacyEn);
  assert.deepEqual(noteWrites, [], 'Reading, a no-op save and export must not rewrite legacy fields');

  const edited = `${combined}\n\n补充：统一编辑后保留两段旧内容。`;
  await editor.fill(edited);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.save-row [role="status"]')).toHaveText('已保存到本机');
  raw = await readDocument();
  assert.equal(raw.notesZh, edited);
  assert.equal(raw.notesEn, '');
  assert.ok(noteWrites.some(body => body.notesZh === edited && body.notesEn === ''));
  await page.reload();
  await expect(editor).toHaveValue(edited);
  assert.equal((await editor.inputValue()).split(legacyEn).length - 1, 1, 'Reload must not append the old second field again');

  // Seed the old two-field draft shape before React starts, after the previous
  // document's unload cleanup. Seed only once so the next reload tests persistence.
  const draft = { notesZh: '## 浏览器验收\n\n恢复旧草稿甲。', notesEn: 'Recovered draft: keep this second paragraph.' };
  const draftKey = `paperdesk-draft-${sampleDocument.id}`;
  const draftValue = `${draft.notesZh}\n\n---\n\n${draft.notesEn}`;
  await page.addInitScript(({ key, value }) => {
    const seedKey = `${key}-seeded`;
    if (!sessionStorage.getItem(seedKey)) {
      localStorage.setItem(key, JSON.stringify(value));
      sessionStorage.removeItem(key.replace('paperdesk-draft-', 'paperdesk-draft-slot-'));
      sessionStorage.setItem(seedKey, 'true');
    }
  }, { key: draftKey, value: draft });
  await page.reload();
  await expect(editor).toHaveValue(draftValue);
  await expect(page.locator('.notes-conflict')).toBeVisible();
  raw = await readDocument();
  assert.equal(raw.notesZh, edited, 'An old draft without a base revision must not overwrite newer saved notes');
  await page.getByRole('button', { name: '保留草稿并载入已保存笔记', exact: true }).click();
  await expect(editor).toHaveValue(edited);
  await page.locator('.preserved-drafts summary').click();
  await expect(page.getByRole('textbox', { name: '保留的笔记草稿 1', exact: true })).toHaveValue(draftValue);
  // Choosing this recovered text in the editor is now an explicit edit, with
  // the current saved revision as its base and the old draft archived safely.
  await editor.fill(draftValue);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.save-row [role="status"]')).toHaveText('已保存到本机');
  raw = await readDocument();
  assert.equal(raw.notesZh, draftValue);
  assert.equal(raw.notesEn, '');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), draftKey), null);
  await page.reload();
  await expect(editor).toHaveValue(draftValue);
  console.log('PASS: legacy fields without writes, edit consolidation and unknown-base draft conflict/recovery without duplication');
  await page.close();
}

async function tableOfContentsWorkflow(context, sampleDocument) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1800, height: 1000 });
  page.on('pageerror', error => pageErrors.push(`Table of contents: ${error.message}`));
  const base = `http://127.0.0.1:${appServer.address().port}`;
  await page.goto(base);

  async function importFixture(name, buffer) {
    const pending = page.waitForResponse(response => response.url() === `${base}/api/documents` && response.request().method() === 'POST');
    await page.getByLabel('选择 PDF 文件').setInputFiles({ name, mimeType: 'application/pdf', buffer });
    const response = await pending;
    assert.equal(response.status(), 201);
    const { document } = await response.json();
    await expect(page.getByRole('heading', { name: document.title, exact: true })).toBeVisible();
    await expect(page.getByLabel('PDF 第 1 页', { exact: true })).toBeVisible();
    return document;
  }

  async function openContents() {
    // A page load can finish before the saved document and Reader are restored.
    // Read the mounted toggle's state instead of sampling a possibly absent one.
    const toggle = page.getByRole('button', { name: /^(展开|收起)目录$/ });
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const navigation = page.getByRole('complementary', { name: '目录面板', exact: true });
    await expect(navigation).toBeVisible();
    return navigation;
  }

  async function chapterExpanded(navigation, title) {
    const expand = navigation.getByRole('button', { name: `展开章节：${title}`, exact: true });
    if (await expand.isVisible()) await expand.click();
    await expect(navigation.getByRole('button', { name: `收起章节：${title}`, exact: true })).toBeVisible();
  }

  const bookmarked = await importFixture('original-bookmark-exercise.pdf', bookmarkedPdf());
  let navigation = await openContents();
  await expect(navigation.getByText(/^PDF 内置书签/)).toBeVisible();
  await expect(navigation.getByRole('navigation', { name: '章节目录', exact: true })).toBeVisible();
  await chapterExpanded(navigation, '1 Introduction');
  const scope = navigation.getByRole('button', { name: '1.1 Scope，PDF 第 3 页', exact: true });
  await expect(scope).toBeVisible();
  await navigation.getByRole('button', { name: '收起章节：1 Introduction', exact: true }).click();
  await expect(scope).not.toBeVisible();
  await chapterExpanded(navigation, '1 Introduction');
  await scope.click();
  await expect(page.getByLabel('PDF 第 3 页', { exact: true })).toBeVisible();
  await expect(navigation).toBeVisible();

  await page.getByRole('textbox', { name: '筛选章节', exact: true }).fill('Results');
  const results = navigation.getByRole('button', { name: '2.1 Results，PDF 第 5 页', exact: true });
  await expect(results).toBeVisible();
  await expect(navigation.getByRole('button', { name: '1 Introduction，PDF 第 2 页', exact: true })).not.toBeVisible();
  await results.click();
  await expect(page.getByLabel('PDF 第 5 页', { exact: true })).toBeVisible();
  await expect.poll(async () => (await (await fetch(`${base}/api/documents/${bookmarked.id}`)).json()).document.lastPage).toBe(5);

  await page.reload();
  await expect(page.getByLabel('PDF 第 5 页', { exact: true })).toBeVisible();
  navigation = await openContents();
  await expect(navigation.getByText(/^PDF 内置书签/)).toBeVisible();
  await chapterExpanded(navigation, '2 Methods');
  await expect(navigation.getByRole('button', { name: '2.1 Results，PDF 第 5 页', exact: true })).toBeVisible();

  // A small reading window dismisses the overlaid contents after navigation.
  await page.setViewportSize({ width: 900, height: 900 });
  await navigation.getByRole('button', { name: '1 Introduction，PDF 第 2 页', exact: true }).click();
  await expect(page.getByLabel('PDF 第 2 页', { exact: true })).toBeVisible();
  await expect(navigation).not.toBeVisible();
  await expect(page.getByRole('button', { name: '展开目录', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1800, height: 1000 });

  // The two overlays must not compete when a wide reading layout becomes narrow.
  navigation = await openContents();
  const notesPanel = page.getByRole('complementary', { name: '笔记与批注', exact: true });
  await expect(notesPanel).toBeVisible();
  await page.setViewportSize({ width: 760, height: 900 });
  await expect(navigation).toBeVisible();
  await expect(notesPanel).not.toBeVisible();
  await page.getByRole('textbox', { name: '全文搜索', exact: true }).fill('浏览器验收');
  await page.locator('.search-result').filter({ hasText: '笔记' }).click();
  await expect(notesPanel).toBeVisible();
  await expect(navigation).not.toBeVisible();
  await expect(page.getByRole('textbox', { name: '笔记', exact: true })).toHaveValue(/浏览器验收/);
  await page.getByRole('textbox', { name: '全文搜索', exact: true }).fill('');
  await page.setViewportSize({ width: 1800, height: 1000 });

  // The original sample was imported before any TOC access. It must not inherit
  // a previous document's entries or require reimport after this feature.
  await page.getByRole('navigation', { name: '文献库', exact: true }).getByRole('button').filter({ hasText: sampleDocument.title }).click();
  navigation = await openContents();
  await expect(navigation).toContainText(/扫描目录.*不支持|OCR/);
  await expect(navigation.getByRole('button', { name: /1\.1 Scope|2\.1 Results/ })).toHaveCount(0);
  assert.equal((await (await fetch(`${base}/api/documents/${sampleDocument.id}/toc`)).json()).source, 'none');

  const contents = await importFixture('original-manual-contents-exercise.pdf', unverifiedContentsPdf());
  navigation = await openContents();
  await expect(navigation.getByText(/^目录页识别/)).toBeVisible();
  const toc = await (await fetch(`${base}/api/documents/${contents.id}/toc`)).json();
  assert.equal(toc.source, 'contents');
  assert.equal(toc.offsetVerified, false, 'Fixture requires explicit calibration, not guessed navigation');
  assert.equal(toc.pageOffset, null);
  const firstTitle = toc.entries[0].title;
  const chapter = navigation.getByRole('button', { name: new RegExp(`^${firstTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) });
  await expect(chapter).toBeDisabled();
  await page.getByRole('spinbutton', { name: '目录页码偏移', exact: true }).fill('2');
  await page.getByRole('button', { name: '应用偏移', exact: true }).click();
  await navigation.getByRole('button', { name: `${firstTitle}，PDF 第 3 页`, exact: true }).click();
  await expect(page.getByLabel('PDF 第 3 页', { exact: true })).toBeVisible();
  await expect.poll(async () => (await (await fetch(`${base}/api/documents/${contents.id}`)).json()).document.lastPage).toBe(3);
  await page.reload();
  navigation = await openContents();
  await expect(navigation.getByText(/^目录页识别/)).toBeVisible();
  const calibration = navigation.locator('details');
  if (await calibration.getAttribute('open') === null) await calibration.locator('summary').click();
  await expect(page.getByRole('spinbutton', { name: '目录页码偏移', exact: true })).toHaveValue('2');
  await expect(navigation.getByRole('button', { name: `${firstTitle}，PDF 第 3 页`, exact: true })).toBeEnabled();
  // Local calibration never mutates the source API result or PDF bytes.
  const unchanged = await (await fetch(`${base}/api/documents/${contents.id}/toc`)).json();
  assert.equal(unchanged.pageOffset, null);
  assert.equal(unchanged.offsetVerified, false);
  assert.deepEqual(Buffer.from(await (await fetch(`${base}/api/documents/${contents.id}/file`)).arrayBuffer()), unverifiedContentsPdf());
  await page.getByRole('button', { name: '恢复自动', exact: true }).click();
  await expect(chapter).toBeDisabled();

  const verified = await importFixture('original-verified-contents-exercise.pdf', verifiedContentsPdf());
  navigation = await openContents();
  await expect(navigation.getByText(/^目录页识别/)).toBeVisible();
  const verifiedToc = await (await fetch(`${base}/api/documents/${verified.id}/toc`)).json();
  assert.equal(verifiedToc.offsetVerified, true);
  assert.equal(verifiedToc.pageOffset, 2);
  const methods = verifiedToc.entries.find(entry => entry.page === 5);
  assert.ok(methods, 'Independent chapter anchors should resolve the second printed chapter to PDF page 5');
  await navigation.getByRole('button', { name: `${methods.title}，PDF 第 5 页`, exact: true }).click();
  await expect(page.getByLabel('PDF 第 5 页', { exact: true })).toBeVisible();
  console.log('PASS: nested bookmarks, chapter filter/jump, reload, narrow-window overlays and note search, document switching and manual/verified contents-page calibration');
  await page.close();
}

async function largeUploadWorkflow(context) {
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(`Large PDF upload: ${error.message}`));
  const base = `http://127.0.0.1:${appServer.address().port}`;
  const fixture = join(tempDir, 'original-large-upload-exercise.pdf');
  const expectedSize = await writeLargeUploadPdf(fixture);
  assert.ok(expectedSize > 50 * 1024 * 1024, 'Regression fixture must cross the former 50 MiB cap');
  await page.goto(base);
  const pending = page.waitForResponse(response => response.url() === `${base}/api/documents` && response.request().method() === 'POST', { timeout: 120000 });
  await page.getByLabel('选择 PDF 文件').setInputFiles(fixture);
  const response = await pending;
  assert.equal(response.status(), 201);
  const { document } = await response.json();
  assert.equal(document.byteSize, expectedSize);
  assert.equal(document.pageCount, 1);
  await expect(page.getByRole('heading', { name: document.title, exact: true })).toBeVisible();
  await expect(page.getByLabel('PDF 第 1 页', { exact: true })).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.textLayer')).toContainText('Original large upload exercise');
  console.log('PASS: a generated PDF larger than 50 MiB imports through the browser file picker and renders');
  await page.close();
}

async function scanRegionWorkflow(context) {
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(`Scan regions: ${error.message}`));
  const base = `http://127.0.0.1:${appServer.address().port}`;
  const bytes = graphicsOnlyPdf();
  await page.goto(base);
  const imported = page.waitForResponse(response => response.url() === `${base}/api/documents` && response.request().method() === 'POST');
  await page.getByLabel('选择 PDF 文件').setInputFiles({ name: 'original-scan-region-exercise.pdf', mimeType: 'application/pdf', buffer: bytes });
  const response = await imported;
  assert.equal(response.status(), 201);
  const { document } = await response.json();
  assert.equal(document.pageCount, 2);
  assert.equal(document.textAvailable, false, 'Region workflow must not depend on hidden text or OCR');
  await expect(page.getByRole('heading', { name: document.title, exact: true })).toBeVisible();
  await expect(page.getByLabel('PDF 第 1 页', { exact: true })).toBeVisible();
  await expect(page.locator('.textLayer span')).toHaveCount(0);

  const paper = page.locator('.pdf-paper');
  const regionMode = page.getByRole('button', { name: '区域批注', exact: true });
  const addRegion = page.getByRole('button', { name: '添加区域批注', exact: true });
  const documentState = async () => (await (await fetch(`${base}/api/documents/${document.id}`)).json());
  await regionMode.click();
  await expect(regionMode).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('拖动框选批注区域', { exact: true })).toBeVisible();

  async function dragRegion(from, to, { escape = false } = {}) {
    const bounds = await paper.boundingBox();
    assert.ok(bounds);
    await page.mouse.move(bounds.x + from[0] * bounds.width, bounds.y + from[1] * bounds.height);
    await page.mouse.down();
    await page.mouse.move(bounds.x + to[0] * bounds.width, bounds.y + to[1] * bounds.height, { steps: 5 });
    if (escape) await page.keyboard.press('Escape');
    await page.mouse.up();
    return { x: Math.min(from[0], to[0]), y: Math.min(from[1], to[1]), width: Math.abs(to[0] - from[0]), height: Math.abs(to[1] - from[1]) };
  }

  async function saveRegion(comment) {
    await addRegion.click();
    const dialog = page.getByRole('dialog', { name: /区域批注/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('img', { name: '第 1 页框选区域预览', exact: true })).toBeVisible();
    await dialog.getByRole('textbox', { name: '批注评论', exact: true }).fill(comment);
    const pending = page.waitForResponse(result => result.url() === `${base}/api/documents/${document.id}/annotations` && result.request().method() === 'POST');
    await dialog.getByRole('button', { name: '保存批注', exact: true }).click();
    const result = await pending;
    assert.equal(result.status(), 201);
    assert.equal(Object.hasOwn(result.request().postDataJSON(), 'preview'), false, 'Canvas preview must not enter the annotation API');
    await expect(dialog).not.toBeVisible();
    const { annotation } = await result.json();
    assert.equal(annotation.kind, 'region');
    assert.equal(annotation.quote, '');
    assert.equal(annotation.rects.length, 1);
    return annotation;
  }

  function assertCoordinates(actual, expected) {
    for (const key of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(actual[key] - expected[key]) < 0.004, `${key} coordinate changed: ${actual[key]} vs ${expected[key]}`);
    }
  }

  async function assertOverlay(annotation) {
    const overlay = page.locator(`[data-annotation="${annotation.id}"]`);
    await expect(overlay).toBeVisible();
    const actual = await overlay.evaluate(element => {
      const box = element.getBoundingClientRect();
      const parent = element.closest('.pdf-paper').getBoundingClientRect();
      return { x: (box.x - parent.x) / parent.width, y: (box.y - parent.y) / parent.height, width: box.width / parent.width, height: box.height / parent.height };
    });
    assertCoordinates(actual, annotation.rects[0]);
  }

  // A near-click and an interrupted drag must not create accidental regions.
  const bounds = await paper.boundingBox();
  await dragRegion([0.15, 0.2], [0.15 + 2 / bounds.width, 0.2 + 2 / bounds.height]);
  await expect(addRegion).not.toBeVisible();
  await dragRegion([0.16, 0.2], [0.44, 0.34], { escape: true });
  await expect(addRegion).not.toBeVisible();
  assert.deepEqual((await documentState()).annotations, []);

  // Esc first dismisses the dialog, then cancels the remaining draft if present.
  await dragRegion([0.16, 0.2], [0.44, 0.34]);
  await expect(addRegion).toBeVisible();
  const draft = page.locator('.region-draft-rect');
  const originalWidth = (await paper.boundingBox()).width;
  await page.getByRole('button', { name: '收起文献栏', exact: true }).click();
  await expect.poll(async () => Math.abs((await paper.boundingBox()).width - originalWidth)).toBeGreaterThan(20);
  await expect(draft).toBeVisible();
  await expect(addRegion).toBeVisible();
  await page.getByRole('button', { name: '展开文献栏', exact: true }).click();
  await expect.poll(async () => (await paper.boundingBox()).width).toBeCloseTo(originalWidth, 0);
  await page.getByRole('combobox', { name: '阅读缩放', exact: true }).selectOption('1.25');
  await expect.poll(async () => (await paper.boundingBox()).width).toBeCloseTo(750, 0);
  await expect(draft).toBeVisible();
  await expect(addRegion).toBeVisible();
  await page.getByRole('combobox', { name: '阅读缩放', exact: true }).selectOption('fit');
  await expect.poll(async () => (await paper.boundingBox()).width).toBeCloseTo(originalWidth, 0);
  await addRegion.click();
  await expect(page.getByRole('dialog', { name: /区域批注/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: /区域批注/ })).not.toBeVisible();
  await page.keyboard.press('Escape');
  await expect(addRegion).not.toBeVisible();
  assert.deepEqual((await documentState()).annotations, []);

  const forwardRect = await dragRegion([0.16, 0.2], [0.44, 0.34]);
  const first = await saveRegion('扫描区域回归：图中几何框。');
  assertCoordinates(first.rects[0], forwardRect);
  const reverseRect = await dragRegion([0.6, 0.44], [0.32, 0.28]);
  const second = await saveRegion('区域反向拖选验收。');
  assertCoordinates(second.rects[0], reverseRect);
  await assertOverlay(first);
  await assertOverlay(second);

  const updatedComment = '扫描区域回归：已修改的局部图形说明。';
  const firstCard = page.locator('.annotation-card').filter({ hasText: first.comment });
  await expect(firstCard.getByRole('button', { name: /^框选区域/ })).toBeVisible();
  await firstCard.getByRole('button', { name: '编辑批注', exact: true }).click();
  await page.getByRole('textbox', { name: '编辑批注内容', exact: true }).fill(updatedComment);
  await page.locator('.annotation-edit').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.annotation-card').filter({ hasText: updatedComment })).toBeVisible();
  assert.equal((await documentState()).annotations.find(annotation => annotation.id === first.id).comment, updatedComment);

  const pendingDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 Markdown', exact: true }).click();
  const markdown = await readFile(await (await pendingDownload).path(), 'utf8');
  assert.ok(markdown.includes(updatedComment));
  assert.match(markdown, /区域批注/);
  assert.match(markdown, /区域坐标.*x=.*y=.*width=.*height=/);
  assert.ok(!/^> /m.test(markdown), 'A region must not fabricate a text quotation');

  // A saved rectangle retains the same PDF-relative geometry as layout changes.
  const widthBefore = (await paper.boundingBox()).width;
  const library = page.getByRole('complementary', { name: '文献栏', exact: true, includeHidden: true });
  await page.getByRole('button', { name: '收起文献栏', exact: true }).click();
  await expect(library).not.toBeVisible();
  await expect(library).toHaveCount(1);
  await expect(page.getByRole('button', { name: '展开文献栏', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async () => Math.abs((await paper.boundingBox()).width - widthBefore)).toBeGreaterThan(20);
  await assertOverlay(first);
  await page.getByRole('combobox', { name: '阅读缩放', exact: true }).selectOption('1.5');
  await expect.poll(async () => (await paper.boundingBox()).width).toBeCloseTo(900, 0);
  await assertOverlay(first);
  await assertOverlay(second);

  await page.reload();
  await expect(page.getByLabel('PDF 第 1 页', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '展开文献栏', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(library).not.toBeVisible();
  await expect(regionMode).toHaveAttribute('aria-pressed', 'false');
  await assertOverlay(first);
  assert.equal((await documentState()).annotations.length, 2);

  await page.keyboard.press('ControlOrMeta+k');
  const search = page.getByRole('textbox', { name: '全文搜索', exact: true });
  await expect(library).toBeVisible();
  await expect(search).toBeFocused();
  await search.fill('扫描区域回归');
  await page.locator('.search-result').filter({ hasText: '批注' }).click();
  await expect(page.locator('.annotation-card').filter({ hasText: updatedComment })).toBeVisible();
  await search.fill('');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByLabel('PDF 第 2 页', { exact: true })).toBeVisible();
  await expect(page.locator(`[data-annotation="${first.id}"]`)).toHaveCount(0);
  await page.locator('.annotation-card').filter({ hasText: updatedComment }).getByRole('button', { name: '第 1 页', exact: true }).click();
  await expect(page.getByLabel('PDF 第 1 页', { exact: true })).toBeVisible();
  await expect(page.locator(`[data-annotation="${first.id}"]`)).toHaveClass(/focused/);

  // Returning to an annotation on a narrow window must expose the original page.
  await page.setViewportSize({ width: 760, height: 900 });
  const tocToggle = page.getByRole('button', { name: /^(展开|收起)目录$/ });
  if (await tocToggle.getAttribute('aria-expanded') === 'false') await tocToggle.click();
  await search.fill('区域反向拖选验收');
  await page.locator('.search-result').filter({ hasText: '批注' }).click();
  const notesPanel = page.getByRole('complementary', { name: '笔记与批注', exact: true });
  await expect(notesPanel).toBeVisible();
  await expect(page.getByRole('complementary', { name: '目录面板', exact: true })).not.toBeVisible();
  await page.locator('.annotation-card').filter({ hasText: second.comment }).getByRole('button', { name: /^框选区域/ }).click();
  await expect(notesPanel).not.toBeVisible();
  await expect(page.locator(`[data-annotation="${second.id}"]`)).toHaveClass(/focused/);
  assert.deepEqual(Buffer.from(await (await fetch(`${base}/api/documents/${document.id}/file`)).arrayBuffer()), bytes);
  console.log('PASS: graphics-only PDF region drag/cancel/save/edit/export, geometry across zoom and library collapse, persisted layout, keyboard search and page return');
  await page.close();
}

try {
  try { await access(join(root, 'dist/index.html')); }
  catch { throw new Error('Build the application first with npm run build, or run npm run check.'); }
  tempDir = await mkdtemp(join(tmpdir(), 'paperdesk-browser-'));
  const chatgptFixture = createChatgptRunnerFixture();
  runtime = createApp({ dataDir: join(tempDir, 'data'), chatgptRunner: chatgptFixture.runner });
  appServer = runtime.app.listen(0, '127.0.0.1');
  await once(appServer, 'listening');
  // Vite serves the unchanged source-based harness; the smoke test uses the production build.
  harnessServer = await createViteServer({
    configFile: false,
    root,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: true },
  });
  await harnessServer.listen();
  try { browser = await chromium.launch(); }
  catch (error) { throw new Error(`Chromium could not start. Run npx playwright install chromium (Linux CI: add --with-deps).\n${error.message}`); }
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(15000);
  await selectionRegression(context);
  const sampleDocument = await readingWorkflow(context);
  await legacyNotesWorkflow(context, sampleDocument);
  await tableOfContentsWorkflow(context, sampleDocument);
  await largeUploadWorkflow(context);
  await scanRegionWorkflow(context);
  await pluginWorkflow({ context, base: `http://127.0.0.1:${appServer.address().port}` });
  await nativeReaderWorkflow({ context, base: `http://127.0.0.1:${appServer.address().port}`, chatgptFixture });
  await chatgptHandoffWorkflow({ context, base: `http://127.0.0.1:${appServer.address().port}` });
  await chatgptAutomationWorkflow({ context, base: `http://127.0.0.1:${appServer.address().port}`, fixture: chatgptFixture });
  assert.deepEqual(pageErrors, [], 'Browser pages must not raise uncaught exceptions');
  console.log('Browser checks passed; temporary library removed on exit.');
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
} finally {
  await cleanup();
}
