import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { _electron as electron, expect } from '@playwright/test';
import { startDesktopRuntime } from '../desktop/runtime.mjs';
import { clearInheritedTestStorage } from './test-isolated.mjs';
import { desktopTestTarget, testEvidenceDirectory, temporaryTestDirectory, removeTestDirectory, closeTestApplication, testShutdownHandlers } from './desktop-test-support.mjs';

clearInheritedTestStorage();

// Avoid a trailing backslash in the quoted Windows Electron app argument.
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const { values } = parseArgs({ options: { packaged: { type: 'string' } } });
const appBundle = values.packaged ? path.resolve(values.packaged) : null;
const { executablePath, appPath: packagedAppPath } = desktopTestTarget(appBundle);
await access(executablePath);
const originalPdf = await readFile(path.join(root, 'public/examples/reading-demo.pdf'));
if (process.env.PAPERDESK_ACCEPTANCE_DIR) testEvidenceDirectory(root, root);
const temporary = await temporaryTestDirectory('paperdesk-desktop-');
const artifactDir = testEvidenceDirectory(root, temporary);
const userData = path.join(temporary, 'profile');
const fixtureLibrary = path.join(temporary, 'existing-library');
const label = appBundle ? 'packaged' : 'source';
const env = { ...process.env, PAPERDESK_DESKTOP_USER_DATA: userData, PAPERDESK_DESKTOP_PORT: '0' };
delete env.ELECTRON_RUN_AS_NODE;
let application, fixture, document, baseUrl, cleanupPromise;
let readerSessionId;
const errors = [];
const pdfHash = bytes => createHash('sha256').update(bytes).digest('hex');
const originalHash = pdfHash(originalPdf);

function cleanup() {
  cleanupPromise ??= (async () => {
    await closeTestApplication(application, userData);
    await fixture?.close();
    await removeTestDirectory(temporary, 'paperdesk-desktop-');
  })();
  return cleanupPromise;
}
const removeShutdownHandlers = testShutdownHandlers(cleanup);

async function launch() {
  const result = await electron.launch({ executablePath, args: appBundle ? [] : [root], cwd: temporary, env, chromiumSandbox: true, timeout: 60_000 });
  application = result;
  const page = await result.firstWindow();
  readerSessionId = null;
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().includes('/api/reader-sessions/')) readerSessionId = request.url().split('/').at(-1);
  });
  await result.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
  await page.bringToFront();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('.app-shell')).toBeVisible();
  baseUrl = new URL(page.url()).origin;
  return page;
}

async function quit() {
  const current = application;
  const closed = current.waitForEvent('close', { timeout: 30_000 });
  await current.evaluate(({ app }) => { app.quit(); }).catch(error => {
    if (!/closed|Target page|Session closed/.test(error.message)) throw error;
  });
  await closed;
  application = null;
  await assert.rejects(fetch(baseUrl + '/api/health', { signal: AbortSignal.timeout(1000) }), 'Owned service must exit with the application');
}

async function request(endpoint) {
  const response = await fetch(baseUrl + '/api' + endpoint, { signal: AbortSignal.timeout(35_000) });
  assert.equal(response.status, 200, endpoint);
  return response.json();
}

async function chooseLibrary(directory) {
  await application.evaluate(({ dialog, Menu }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    Menu.getApplicationMenu().getMenuItemById('open-existing-library').click();
  }, directory);
}

try {
  await mkdir(artifactDir, { recursive: true });
  let page = await launch();
  await expect(page.getByRole('button', { name: '导入第一篇 PDF' })).toBeVisible();
  assert.equal((await request('/documents')).documents.length, 0, 'Tests must start with an isolated empty library');
  const security = await application.evaluate(({ app, BrowserWindow }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { node: process.versions.node, electron: process.versions.electron, appPath: app.getAppPath(), sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration, contextIsolation: prefs.contextIsolation };
  });
  assert.ok(Number(security.node.split('.')[0]) >= 24);
  assert.equal(security.nodeIntegration, false);
  assert.equal(security.contextIsolation, true);
  assert.equal(security.sandbox, true);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(async () => (await navigator.permissions.query({ name: 'clipboard-write' })).state), 'granted');
  assert.equal(await page.evaluate(async () => (await navigator.permissions.query({ name: 'clipboard-read' })).state), 'denied');
  console.log(`PASS: ${label} desktop starts with bundled Node ${security.node} and an isolated sandboxed window`);

  const imported = page.waitForResponse(response => response.url() === baseUrl + '/api/documents' && response.request().method() === 'POST');
  await page.getByLabel('选择 PDF 文件').setInputFiles(path.join(root, 'public/examples/reading-demo.pdf'));
  const importedResponse = await imported;
  assert.equal(importedResponse.status(), 201);
  document = (await importedResponse.json()).document;
  await expect(page.getByLabel('PDF 第 1 页', { exact: true })).toBeVisible();
  await expect(page.locator('.textLayer span').first()).toBeVisible();
  let editor = page.getByRole('textbox', { name: '笔记', exact: true });
  const notes = '## 桌面验收\n\n原文、笔记和批注保存在本机。\nDesktop release acceptance.';
  await editor.fill(notes);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.save-row [role="status"]')).toHaveText('已保存到本机');
  assert.equal((await request(`/documents/${document.id}`)).document.notesZh, notes);
  const importToast = page.getByRole('button', { name: '关闭提示', exact: true });
  if (await importToast.isVisible()) await importToast.click();

  const heading = page.locator('.textLayer span').filter({ hasText: /^Reading with intention$/ });
  await expect(heading).toBeVisible();
  await expect(page.locator('.pdf-paper')).not.toHaveClass(/is-loading/);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
  await heading.hover();
  const box = await heading.boundingBox();
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  const selectionDiagnostic = await page.evaluate(() => ({ text: window.getSelection()?.toString(), focused: window.document.hasFocus(), inert: window.document.querySelector('.app-shell').inert }));
  console.log('Desktop pointer selection:', JSON.stringify(selectionDiagnostic));
  await expect(page.locator('.selection-summary p')).toHaveText('Reading with intention');
  assert.match(readerSessionId, /^[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: '交给 Codex', exact: true }).click();
  await page.keyboard.press('Shift');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('.codex-status')).toHaveAttribute('data-shared', 'true');
  await expect.poll(async () => (await request(`/reader-context?sessionId=${readerSessionId}`)).selection?.text).toBe('Reading with intention');
  await page.getByRole('button', { name: '高亮并批注', exact: true }).click();
  const annotationDialog = page.getByRole('dialog', { name: /高亮与批注/ });
  await expect(annotationDialog.locator('blockquote')).toHaveText('Reading with intention');
  await annotationDialog.getByRole('textbox', { name: '批注评论', exact: true }).fill('桌面窗口中的真实选文。');
  await annotationDialog.getByRole('button', { name: '保存批注', exact: true }).click();
  await expect(annotationDialog).not.toBeVisible();
  assert.equal((await request(`/documents/${document.id}`)).annotations.length, 1);

  // Native canvas rendering must work in an Electron child, including fonts.
  const rendered = await request(`/documents/${document.id}/reader-page?page=1&width=800`);
  const image = rendered.image ?? rendered.page?.image;
  assert.equal(typeof image, 'string', JSON.stringify(Object.keys(rendered)));
  assert.equal(Buffer.from(image, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const actualPdf = await fetch(`${baseUrl}/api/documents/${document.id}/file`).then(response => response.arrayBuffer());
  assert.equal(pdfHash(Buffer.from(actualPdf)), originalHash);
  console.log('PASS: real PDF import, display, text selection, note/annotation save and native child rendering');

  const downloadPath = path.join(temporary, 'desktop-notes.md');
  await application.evaluate(({ BrowserWindow }, filename) => {
    BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => {
      item.setSavePath(filename);
      item.once('done', (_event, state) => { globalThis.desktopTestDownloadState = state; });
    });
  }, downloadPath);
  await page.getByRole('button', { name: '导出 Markdown', exact: true }).click();
  await expect.poll(() => application.evaluate(() => globalThis.desktopTestDownloadState)).toBe('completed');
  await expect.poll(async () => { try { return await readFile(downloadPath, 'utf8'); } catch { return ''; } }).toContain(notes);
  assert.ok((await readFile(downloadPath, 'utf8')).includes('桌面窗口中的真实选文。'));
  await page.screenshot({ path: path.join(artifactDir, `${label}-reader.png`) });

  // Quit immediately after typing: the native quit handshake flushes the queue.
  await page.getByRole('button', { name: /^笔记$/, exact: true }).click();
  const finalNotes = notes + '\n\n立即退出前新增的内容。';
  await editor.fill(finalNotes);
  await quit();
  const settings = JSON.parse(await readFile(path.join(userData, 'desktop-settings.json'), 'utf8'));
  assert.equal(settings.dataDir, path.join(userData, 'library'));
  assert.equal(pdfHash(await readFile(path.join(settings.dataDir, 'pdfs', document.id + '.pdf'))), originalHash);
  delete env.PAPERDESK_DESKTOP_PORT; // Recover the saved local origin and its drafts.
  page = await launch();
  await expect(editor = page.getByRole('textbox', { name: '笔记', exact: true })).toHaveValue(finalNotes);
  assert.equal((await request(`/documents/${document.id}`)).annotations.length, 1);
  console.log('PASS: Markdown export and immediate quit/restart preserve original PDF, unsaved text and annotations');

  // A second launch must focus the existing instance, with no second window/server.
  const second = spawn(executablePath, appBundle ? [] : [root], { cwd: temporary, env, stdio: 'ignore' });
  let secondTimer;
  let secondExit;
  try {
    secondExit = await Promise.race([once(second, 'close'), new Promise((_, reject) => { secondTimer = setTimeout(() => { second.kill(); reject(new Error('Second instance did not exit')); }, 15_000); })]);
  } finally { clearTimeout(secondTimer); }
  assert.equal(secondExit[0], 0);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);

  if (process.platform === 'darwin') {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
    assert.equal((await request('/health')).ok, true);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    console.log('PASS: single-instance launch and macOS window hide keep one healthy service');
  } else {
    const stoppedUrl = baseUrl, closed = application.waitForEvent('close', { timeout: 30_000 });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()).catch(error => {
      if (!/closed|Target page|Session closed/.test(error.message)) throw error;
    });
    await closed; application = null;
    await assert.rejects(fetch(stoppedUrl + '/api/health', { signal: AbortSignal.timeout(1000) }));
    page = await launch();
    editor = page.getByRole('textbox', { name: '笔记', exact: true });
    await expect(editor).toHaveValue(finalNotes);
    console.log('PASS: single-instance launch, native window close/service stop and restart preserve saved notes');
  }

  // A failed save must cancel native quit and preserve the window and draft.
  await application.evaluate(({ dialog }) => {
    globalThis.desktopTestMessages = [];
    dialog.showMessageBox = async (...args) => {
      globalThis.desktopTestMessages.push(args.at(-1));
      return { response: 0 };
    };
  });
  const unsaved = finalNotes + '\n\n保存失败时必须保留这一段。';
  await page.route(`**/api/documents/${document.id}`, async route => {
    if (route.request().method() === 'PATCH' && Object.hasOwn(route.request().postDataJSON(), 'notesZh')) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '隔离测试：保存失败' }) });
    } else await route.continue();
  });
  await editor.fill(unsaved);
  await application.evaluate(({ app }) => { app.quit(); });
  await expect.poll(() => application.evaluate(() => globalThis.desktopTestMessages.length)).toBe(1);
  await expect(editor).toHaveValue(unsaved);
  assert.equal((await request(`/documents/${document.id}`)).document.notesZh, finalNotes);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  await page.unroute(`**/api/documents/${document.id}`);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.save-row [role="status"]')).toHaveText('已保存到本机');
  console.log('PASS: failed save cancels native quit and keeps the recoverable draft');

  const invalidLibrary = path.join(temporary, 'unrelated-folder');
  await mkdir(invalidLibrary);
  await application.evaluate(({ dialog, Menu }) => {
    dialog.showOpenDialog = () => new Promise(resolve => { globalThis.desktopTestPickerResolve = resolve; });
    Menu.getApplicationMenu().getMenuItemById('open-existing-library').click();
  });
  await expect(page.locator('.app-shell')).toHaveAttribute('inert', '');
  await page.keyboard.type('This must not enter the old editor');
  await expect(editor).toHaveValue(unsaved);
  await application.evaluate((_electron, directory) => {
    globalThis.desktopTestPickerResolve({ canceled: false, filePaths: [directory] });
  }, invalidLibrary);
  await expect.poll(() => application.evaluate(() => globalThis.desktopTestMessages.length)).toBe(2);
  await expect(page.locator('.app-shell')).not.toHaveAttribute('inert');
  assert.equal(JSON.parse(await readFile(path.join(userData, 'desktop-settings.json'), 'utf8')).dataDir, settings.dataDir);
  assert.deepEqual(await readdir(invalidLibrary), []);
  await expect(editor).toHaveValue(unsaved);
  console.log('PASS: invalid library selection changes neither the current library nor the selected folder');

  // Prepare a stopped existing library using only the checked-in original PDF.
  fixture = await startDesktopRuntime({ dataDir: fixtureLibrary, preferredPort: 0 });
  const form = new FormData(); form.append('file', new Blob([originalPdf], { type: 'application/pdf' }), 'existing-demo.pdf');
  const existingResponse = await fetch(fixture.baseUrl + '/api/documents', { method: 'POST', body: form });
  assert.equal(existingResponse.status, 201);
  const existing = (await existingResponse.json()).document;
  const existingNotes = '已有文献库中的笔记，打开桌面版后应完整保留。';
  const saved = await fetch(fixture.baseUrl + `/api/documents/${existing.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notesZh: existingNotes, notesEn: '', expectedNotesRevision: existing.notesRevision }) });
  assert.equal(saved.status, 200);
  await fixture.close(); fixture = null;
  await chooseLibrary(fixtureLibrary);
  await expect.poll(async () => JSON.parse(await readFile(path.join(userData, 'desktop-settings.json'), 'utf8')).dataDir, { timeout: 15_000 }).toBe(fixtureLibrary);
  await expect(page.getByRole('textbox', { name: '笔记', exact: true })).toHaveValue(existingNotes);
  baseUrl = new URL(page.url()).origin;
  assert.equal((await request('/documents')).documents.length, 1);
  assert.equal(pdfHash(await readFile(path.join(fixtureLibrary, 'pdfs', existing.id + '.pdf'))), originalHash);
  await quit();
  page = await launch();
  await expect(page.getByRole('textbox', { name: '笔记', exact: true })).toHaveValue(existingNotes);
  await quit();
  console.log('PASS: native existing-library selection and restart preserve records and original PDF bytes');

  if (appBundle) {
    const resources = packagedAppPath;
    for (const forbidden of ['data', '.local', 'tests', 'scripts', '.env', '.git', 'src']) {
      await assert.rejects(access(path.join(resources, forbidden)), `Private/development path must not be shipped: ${forbidden}`);
    }
    async function checkTree(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) await checkTree(filename);
        else assert.ok(!/\.(?:sqlite(?:-.*)?|db(?:-.*)?|log)$/.test(entry.name) && !/^\.env(?:\.|$)/.test(entry.name), `Forbidden release file: ${filename}`);
      }
    }
    await checkTree(resources);
    assert.equal(path.resolve(security.appPath), path.resolve(packagedAppPath), 'The application must run from its installed bundle');
    console.log('PASS: packaged application contains no personal library, database, environment file or development data');
  }
  assert.deepEqual(errors, [], 'Desktop renderer must not raise uncaught errors');
  console.log(`PASS: ${label} desktop acceptance complete`);
} finally {
  removeShutdownHandlers();
  await cleanup();
}
