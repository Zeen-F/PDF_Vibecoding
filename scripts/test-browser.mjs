import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createServer as createViteServer } from 'vite';
import { createApp } from '../server/app.mjs';

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
  await readingWorkflow(context);
  assert.deepEqual(pageErrors, [], 'Browser pages must not raise uncaught exceptions');
  console.log('Browser checks passed; temporary library removed on exit.');
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
} finally {
  await cleanup();
}
