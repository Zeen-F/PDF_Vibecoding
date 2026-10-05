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

  const notesZh = '## 浏览器验收\n\n相位裕度需要结合工作条件。';
  const notesEn = '## Browser verification\n\nCompare the claim with the evidence.';
  await page.getByRole('textbox', { name: '中文笔记', exact: true }).fill(notesZh);
  await page.getByRole('textbox', { name: 'English notes', exact: true }).fill(notesEn);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.save-row [role="status"]')).toHaveText('已保存到本机');
  let saved = (await (await fetch(`${base}/api/documents/${document.id}`)).json()).document;
  assert.equal(saved.notesZh, notesZh);
  assert.equal(saved.notesEn, notesEn);

  const pendingDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 Markdown', exact: true }).click();
  const download = await pendingDownload;
  assert.match(download.suggestedFilename(), /\.md$/);
  const exported = await readFile(await download.path(), 'utf8');
  assert.ok(exported.includes(notesZh), 'Export must contain the Chinese note');
  assert.ok(exported.includes(notesEn), 'Export must contain the English note');
  assert.ok(exported.includes('reading-demo.pdf'), 'Export must identify the imported source');

  // Reload after a successful save, with no recovery draft masking server persistence.
  assert.equal(await page.evaluate(id => localStorage.getItem(`paperdesk-draft-${id}`), document.id), null);
  await page.reload();
  await expect(page.getByRole('textbox', { name: '中文笔记', exact: true })).toHaveValue(notesZh);
  await expect(page.getByRole('textbox', { name: 'English notes', exact: true })).toHaveValue(notesEn);
  saved = (await (await fetch(`${base}/api/documents/${document.id}`)).json()).document;
  assert.equal(saved.notesZh, notesZh);
  assert.equal(saved.notesEn, notesEn);
  console.log('PASS: isolated PDF import, rendered page, bilingual note save, Markdown download and reload');
  await page.close();
  return document;
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
  await expect(page.getByRole('textbox', { name: '中文笔记', exact: true })).toHaveValue(/浏览器验收/);
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

try {
  try { await access(join(root, 'dist/index.html')); }
  catch { throw new Error('Build the application first with npm run build, or run npm run check.'); }
  tempDir = await mkdtemp(join(tmpdir(), 'paperdesk-browser-'));
  runtime = createApp({ dataDir: join(tempDir, 'data') });
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
  await tableOfContentsWorkflow(context, sampleDocument);
  await largeUploadWorkflow(context);
  assert.deepEqual(pageErrors, [], 'Browser pages must not raise uncaught exceptions');
  console.log('Browser checks passed; temporary library removed on exit.');
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
} finally {
  await cleanup();
}
