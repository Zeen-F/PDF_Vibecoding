// Focused acceptance against real Electron BrowserWindow/main/preload code.
// Run after building dist and preparing Electron; no production data or backups.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, expect as playwrightExpect } from '@playwright/test';
import { bookmarkedPdf } from './fixtures/toc-browser.mjs';
import { graphicsOnlyPdf } from './fixtures/scan-browser.mjs';
import { LAUNCHER_PROTOCOL, PRODUCT_VERSION } from '../shared/service-identity.mjs';
import { clearInheritedTestStorage } from '../scripts/test-isolated.mjs';
import { desktopTestTarget, testEvidenceDirectory, temporaryTestDirectory, removeTestDirectory, closeTestApplication, testShutdownHandlers } from '../scripts/desktop-test-support.mjs';

clearInheritedTestStorage();

const expect = playwrightExpect.configure({ timeout: 10_000 });
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const { values } = parseArgs({ options: { packaged: { type: 'string' } } });
const appBundle = values.packaged ? path.resolve(values.packaged) : null;
const { executablePath, appPath: packagedAppPath } = desktopTestTarget(appBundle);
if (process.env.PAPERDESK_ACCEPTANCE_DIR) testEvidenceDirectory(root, root);
const temporary = await temporaryTestDirectory('paperdesk-desktop-reliability-');
const artifacts = testEvidenceDirectory(root, temporary);
const userData = path.join(temporary, 'test-profile');
const library = path.join(userData, 'library');
const env = { ...process.env, PAPERDESK_DESKTOP_USER_DATA: userData, PAPERDESK_DESKTOP_PORT: '0' };
delete env.ELECTRON_RUN_AS_NODE;
const releases = new Set(), rendererErrors = [], automationErrors = [], dialogAcknowledgementRaces = [], networkEvidence = [], mainDialogs = [];
const summary = { kind: appBundle ? 'real-packaged-electron' : 'real-source-electron', appBundle, startedAt: new Date().toISOString(), artifacts, userData, library,
  backupsCreated: false, groups: [], rendererErrors, automationErrors, dialogAcknowledgementRaces, networkEvidence, mainDialogs, status: 'running' };
let application, page, base, a, b, annotation, db, runError, cleanupPromise, preservePriorEvidence = false;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function cleanup() {
  cleanupPromise ??= (async () => {
    for (const release of [...releases]) release();
    if (db) { try { db.exec('DROP TRIGGER IF EXISTS desktop_reliability_position_failure;'); } catch {} db.close(); db = null; }
    if (application) {
      await page?.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
      await closeTestApplication(application, userData);
      application = null;
    }
    await removeTestDirectory(temporary, 'paperdesk-desktop-reliability-');
  })();
  return cleanupPromise;
}
const removeShutdownHandlers = testShutdownHandlers(cleanup);

async function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  await appendFile(path.join(artifacts, 'acceptance.log'), line + '\n');
}
async function group(name, action) {
  const started = Date.now();
  try { await action(); summary.groups.push({ name, status: 'passed', durationMs: Date.now() - started }); await log(`PASS: ${name}`); }
  catch (error) { summary.groups.push({ name, status: 'failed', durationMs: Date.now() - started, error: error.message }); throw error; }
}
function gate() {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const unblock = () => { releases.delete(unblock); release(); };
  releases.add(unblock);
  return { entered, waiting, release: unblock, started };
}
async function bounded(promise, label, ms = 15_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function api(endpoint, body, method = 'GET') {
  const response = await fetch(`${base}/api${endpoint}`, { method, signal: AbortSignal.timeout(15_000),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(response.ok, `${method} ${endpoint}: ${response.status}`);
  return response.json();
}
const document = id => api(`/documents/${id}`);
const currentPage = number => page.getByLabel(`PDF 第 ${number} 页`, { exact: true });
const annotationCard = () => page.locator(`[data-annotation-id="${annotation.id}"]`);
const commentEditor = () => annotationCard().getByRole('textbox', { name: '编辑批注内容', exact: true });
const visible = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
const messageCount = () => application.evaluate(() => globalThis.reliabilityDialogs.length);

async function launch() {
  application = await electron.launch({ executablePath, args: appBundle ? [] : [root], cwd: temporary, env, chromiumSandbox: true, timeout: 60_000 });
  application.process().stderr?.on('data', bytes => { void appendFile(path.join(artifacts, 'electron-stderr.log'), bytes).catch(() => {}); });
  page = await application.firstWindow();
  page.on('pageerror', error => rendererErrors.push(error.message));
  page.on('dialog', async dialog => {
    try { await dialog.accept(); }
    catch (error) {
      // Reload approval or native quit can dismiss beforeunload before CDP
      // acknowledges it. Keep those races distinct from renderer exceptions.
      if (dialog.type() === 'beforeunload' && /No dialog is showing|Not attached to an active page/.test(error.message)) {
        dialogAcknowledgementRaces.push({ type: dialog.type(), message: error.message });
      } else automationErrors.push(error.message);
    }
  });
  await application.evaluate(({ BrowserWindow, dialog }) => {
    globalThis.reliabilityDialogs = [];
    // Capture only this app's error dialog calls to avoid blocking automation.
    dialog.showMessageBox = async (...args) => { globalThis.reliabilityDialogs.push(args.at(-1)); return { response: 0 }; };
    BrowserWindow.getAllWindows()[0].show(); BrowserWindow.getAllWindows()[0].focus();
  });
  await page.bringToFront();
  await expect(page.locator('.app-shell')).toBeVisible();
  base = new URL(page.url()).origin;
  await expect.poll(async () => (await api('/health')).ok).toBe(true);
  await log(`Electron started: ${base}`);
}
async function captureDialogs(label) {
  if (application) mainDialogs.push({ label, dialogs: await application.evaluate(() => globalThis.reliabilityDialogs) });
}
async function quit() {
  const app = application, ownedBase = base;
  await captureDialogs('before successful quit');
  const closed = app.waitForEvent('close', { timeout: 25_000 });
  await app.evaluate(({ app }) => { app.quit(); }).catch(error => { if (!/closed|Target page|Session closed/.test(error.message)) throw error; });
  await closed; application = null;
  await assert.rejects(fetch(ownedBase + '/api/health', { signal: AbortSignal.timeout(1_000) }), 'Owned service must stop with the application');
}
async function screenshot(name) { await page.screenshot({ path: path.join(artifacts, name + '.png') }); }
async function reload() {
  // Electron cancels dirty renderer navigations through will-prevent-unload.
  // Approve only this deliberate test reload, then remove the listener before
  // exercising native close/quit, whose real save protections remain in force.
  await application.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    globalThis.reliabilityReloadApproval = event => event.preventDefault();
    contents.once('will-prevent-unload', globalThis.reliabilityReloadApproval);
  });
  try { await page.reload(); }
  finally {
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.removeListener('will-prevent-unload', globalThis.reliabilityReloadApproval);
      delete globalThis.reliabilityReloadApproval;
    });
  }
}
async function annotationsTab() {
  const expand = page.getByRole('button', { name: '展开笔记面板', exact: true });
  if (await expand.count()) await expand.click();
  await page.locator('.panel-tabs button').nth(1).click();
}
async function openBook(book) {
  const expand = page.getByRole('button', { name: '展开文献栏', exact: true });
  if (await expand.count()) await expand.click();
  await page.getByRole('complementary', { name: '文献栏', exact: true }).getByRole('button', { name: '全部文献', exact: true }).click();
  await page.locator(`[data-document-id="${book.id}"] .document-item`).click();
  await expect(page.locator('.header-title h1')).toHaveText(book.title);
  await expect(page.locator('.opening-mask')).toHaveCount(0);
}
async function importPdf(filename) {
  const pending = page.waitForResponse(response => response.url() === `${base}/api/documents` && response.request().method() === 'POST');
  await page.getByLabel('选择 PDF 文件').setInputFiles(filename);
  const response = await pending; assert.equal(response.status(), 201);
  const book = (await response.json()).document;
  await expect(page.locator('.header-title h1')).toHaveText(book.title);
  return book;
}
async function regionModal() {
  await page.getByRole('combobox', { name: '翻页方式', exact: true }).selectOption('paged');
  await page.getByRole('combobox', { name: '页面布局', exact: true }).selectOption('1');
  await page.getByRole('combobox', { name: '阅读缩放', exact: true }).selectOption('fit');
  await expect(page.locator('.pdf-paper canvas')).toBeVisible();
  const toggle = page.getByRole('button', { name: '区域批注', exact: true });
  if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
  const bounds = await page.locator('.pdf-paper').boundingBox();
  assert.ok(bounds);
  // Start outside the existing region annotation, whose overlay deliberately
  // owns its pointer events. This must create a new region, not click that card.
  await page.mouse.move(bounds.x + bounds.width * .52, bounds.y + bounds.height * .3);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .8, bounds.y + bounds.height * .45, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('button', { name: '添加区域批注', exact: true }).click();
  return page.getByRole('dialog', { name: /区域批注/ });
}
async function assertDraftStored(comment) {
  assert.equal(await page.evaluate(text => Object.keys(localStorage).some(key => key.startsWith('paperdesk-annotation-draft-') && localStorage.getItem(key)?.includes(text)), comment), true);
}

try {
  await access(executablePath);
  await mkdir(artifacts, { recursive: true });
  // Explicit evidence is review material; never overwrite an existing result.
  // The actual profile/PDF/database always live in a disposable temporary root.
  try { await access(path.join(artifacts, 'results.json')); preservePriorEvidence = true; throw new Error(`Existing evidence preserved. Choose an empty PAPERDESK_ACCEPTANCE_DIR: ${artifacts}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const aFile = path.join(temporary, 'original-six-pages.pdf'), bFile = path.join(temporary, 'original-vector-pages.pdf');
  await writeFile(aFile, Buffer.concat([bookmarkedPdf(), Buffer.from(`\n% isolated desktop ${randomUUID()}\n`)]));
  await writeFile(bFile, graphicsOnlyPdf());

  await group('1: real sandboxed Electron/preload, isolated library identity and original PDF import', async () => {
    await launch();
    const runtime = await application.evaluate(({ app, BrowserWindow }) => {
      const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { node: process.versions.node, electron: process.versions.electron, userData: app.getPath('userData'), appPath: app.getAppPath(),
        sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration };
    });
    const expectedAppPath = appBundle ? packagedAppPath : root;
    assert.equal(runtime.userData, userData); assert.equal(runtime.appPath.replace(/\/$/, ''), expectedAppPath.replace(/\/$/, ''));
    assert.equal(runtime.sandbox, true); assert.equal(runtime.contextIsolation, true); assert.equal(runtime.nodeIntegration, false);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await page.evaluate(() => typeof window.paperdeskDesktop?.onFlushRequest), 'function');
    const status = await api('/plugin/status');
    assert.equal(status.libraryId, createHash('sha256').update(path.resolve(library)).digest('hex'));
    assert.equal(status.productVersion, PRODUCT_VERSION); assert.equal(status.launcherProtocol, LAUNCHER_PROTOCOL);
    assert.equal((await api('/documents')).documents.length, 0);
    summary.runtime = runtime; summary.identity = status; summary.initialOrigin = base;
    a = await importPdf(aFile); b = await importPdf(bFile); await openBook(a);
    await expect(currentPage(1)).toBeVisible();
    annotation = (await api(`/documents/${a.id}/annotations`, { page: 1, kind: 'region', quote: '', comment: 'Electron 原始评论', color: 'yellow',
      requestId: randomUUID(), rects: [{ x: .1, y: .1, width: .3, height: .15 }] }, 'POST')).annotation;
    await reload(); await expect(currentPage(1)).toBeVisible();
    summary.documents = { a, b, annotationId: annotation.id };
    summary.originalPdfHashes = { a: hash(await readFile(aFile)), b: hash(await readFile(bFile)) };
    await screenshot('01-real-electron-isolated-reader');
  });

  await group('2: comment draft survives panel/document changes and reload; native close preserves dirty window', async () => {
    await annotationsTab(); await annotationCard().getByRole('button', { name: '编辑批注', exact: true }).click();
    const retained = 'Electron 切标签、切文献、刷新仍应保留的评论';
    await commentEditor().fill(retained);
    await page.locator('.panel-tabs button').nth(0).click(); await annotationsTab(); await expect(commentEditor()).toHaveValue(retained);
    await openBook(b); await annotationsTab(); await expect(page.getByRole('textbox', { name: '编辑批注内容', exact: true })).toHaveCount(0);
    await openBook(a); await annotationsTab(); await expect(commentEditor()).toHaveValue(retained);
    await reload(); await expect(currentPage(1)).toBeVisible(); await annotationsTab(); await expect(commentEditor()).toHaveValue(retained);
    await assertDraftStored(retained);
    const count = await messageCount();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(messageCount).toBe(count + 1); assert.equal(await visible(), true);
    const dialogs = await application.evaluate(() => globalThis.reliabilityDialogs);
    assert.match(dialogs.at(-1).detail, /批注|草稿/);
    await screenshot('02-comment-draft-close-protection');
    await annotationCard().getByRole('button', { name: '保存', exact: true }).click();
    await expect(commentEditor()).toHaveCount(0);
    assert.equal((await document(a.id)).annotations.find(value => value.id === annotation.id).comment, retained);
  });

  await group('3: new region draft refresh recovery and lost POST response retry uses same ID exactly once', async () => {
    let modal = await regionModal(); const retained = 'Electron 新建区域评论：响应丢失后不可重复';
    await modal.getByRole('textbox', { name: '批注评论', exact: true }).fill(retained);
    await modal.getByRole('button', { name: '关闭批注窗口', exact: true }).click();
    await reload(); await expect(currentPage(1)).toBeVisible(); await annotationsTab();
    await page.getByRole('button', { name: '恢复第 1 页批注草稿', exact: true }).click();
    modal = page.getByRole('dialog', { name: /区域批注/ });
    await expect(modal.getByRole('textbox', { name: '批注评论', exact: true })).toHaveValue(retained);
    const endpoint = `${base}/api/documents/${a.id}/annotations`, before = (await document(a.id)).annotations.length;
    const attempts = []; let lost = false;
    await page.route(endpoint, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts.push(route.request().postDataJSON());
      if (!lost) { lost = true; const response = await route.fetch(); assert.equal(response.status(), 201); await route.abort('failed'); }
      else await route.continue();
    });
    await modal.getByRole('button', { name: '保存批注', exact: true }).click();
    await expect(modal.getByRole('button', { name: '保存批注', exact: true })).toBeEnabled();
    await expect(modal.getByRole('textbox', { name: '批注评论', exact: true })).toBeDisabled();
    assert.equal((await document(a.id)).annotations.length, before + 1);
    await assertDraftStored(retained); await screenshot('03-post-result-lost-retained-draft');
    await modal.getByRole('button', { name: '保存批注', exact: true }).click(); await expect(modal).not.toBeVisible();
    await page.unroute(endpoint);
    assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]); assert.match(attempts[0].requestId, /^[0-9a-f-]{36}$/);
    const saved = (await document(a.id)).annotations.filter(value => value.comment === retained);
    assert.equal(saved.length, 1); assert.equal((await document(a.id)).annotations.length, before + 1);
    networkEvidence.push({ kind: 'annotation-post-lost-response', attempts, savedAnnotationId: saved[0].id });
  });

  await group('4: failed PATCH and typing during acknowledgement remain recoverable through real close handshake', async () => {
    await annotationCard().getByRole('button', { name: '编辑批注', exact: true }).click();
    const submitted = 'Electron 第一份请求内容', newer = 'Electron 请求期间继续输入的最新评论';
    await commentEditor().fill(submitted);
    const endpoint = `${base}/api/documents/${a.id}/annotations/${annotation.id}`;
    await page.route(endpoint, route => route.request().method() === 'PATCH'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'isolated annotation failure' }) }) : route.continue());
    await annotationCard().getByRole('button', { name: '保存', exact: true }).click();
    await expect(annotationCard().getByRole('alert')).toContainText('保存失败');
    await expect(commentEditor()).toHaveValue(submitted); await assertDraftStored(submitted); await page.unroute(endpoint);
    const hold = gate(); let first = true;
    await page.route(endpoint, async route => {
      if (route.request().method() === 'PATCH' && first) {
        first = false; const response = await route.fetch(); assert.equal(response.status(), 200); hold.entered(); await hold.waiting; await route.fulfill({ response });
      } else await route.continue();
    });
    await annotationCard().getByRole('button', { name: '保存', exact: true }).click(); await bounded(hold.started, 'annotation PATCH reached test SQLite');
    await commentEditor().fill(newer);
    const count = await messageCount(); await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await page.waitForTimeout(250); assert.equal(await visible(), true); assert.equal(await messageCount(), count, 'Close must await the accepted annotation request');
    hold.release(); await expect.poll(messageCount).toBe(count + 1);
    assert.equal(await visible(), true); await expect(commentEditor()).toHaveValue(newer); await assertDraftStored(newer);
    assert.equal((await document(a.id)).annotations.find(value => value.id === annotation.id).comment, submitted);
    await screenshot('04-newer-comment-protected-after-close');
    await annotationCard().getByRole('button', { name: '保存', exact: true }).click(); await expect(commentEditor()).toHaveCount(0); await page.unroute(endpoint);
    assert.equal((await document(a.id)).annotations.find(value => value.id === annotation.id).comment, newer);
  });

  await group('5: rapid page changes serialize/coalesce in Electron and persist after reload', async () => {
    await page.getByRole('combobox', { name: '翻页方式', exact: true }).selectOption('paged');
    await page.getByRole('combobox', { name: '页面布局', exact: true }).selectOption('1');
    const endpoint = `${base}/api/documents/${a.id}`, hold = gate(), order = [];
    await page.route(endpoint, async route => {
      const body = route.request().method() === 'PATCH' ? route.request().postDataJSON() : null;
      if (!Object.hasOwn(body || {}, 'lastPage')) return route.continue();
      order.push(body.lastPage); networkEvidence.push({ kind: 'position-request', body });
      if (body.lastPage === 2) { hold.entered(); await hold.waiting; }
      await route.continue();
    });
    await page.getByRole('button', { name: '下一页', exact: true }).click(); await bounded(hold.started, 'page 2 held');
    await page.getByRole('button', { name: '下一页', exact: true }).click(); await expect(currentPage(3)).toBeVisible();
    await page.getByRole('button', { name: '下一页', exact: true }).click(); await expect(currentPage(4)).toBeVisible();
    assert.deepEqual(order, [2]); hold.release();
    await expect.poll(async () => (await document(a.id)).document.lastPage).toBe(4); assert.deepEqual(order, [2, 4]);
    await page.unroute(endpoint); await reload(); await expect(currentPage(4)).toBeVisible();
    await screenshot('05-position-coalesced-page4');
  });

  await group('6: real BrowserWindow.close waits for latest page; successful close/quit and restart retain page', async () => {
    const endpoint = `${base}/api/documents/${a.id}`, hold = gate(), order = [];
    await page.route(endpoint, async route => {
      const body = route.request().method() === 'PATCH' ? route.request().postDataJSON() : null;
      if (!Object.hasOwn(body || {}, 'lastPage')) return route.continue();
      order.push(body.lastPage); if (body.lastPage === 5) { hold.entered(); await hold.waiting; }
      await route.continue();
    });
    await page.getByRole('button', { name: '下一页', exact: true }).click(); await bounded(hold.started, 'page 5 held before native close');
    await page.getByRole('button', { name: '下一页', exact: true }).click(); await expect(currentPage(6)).toBeVisible();
    const origin = base;
    const closed = process.platform === 'darwin' ? null : application.waitForEvent('close', { timeout: 30_000 });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await page.waitForTimeout(250); assert.equal(await visible(), true); assert.deepEqual(order, [5]);
    hold.release();
    if (process.platform === 'darwin') {
      await expect.poll(visible).toBe(false); assert.deepEqual(order, [5, 6]);
      assert.equal((await document(a.id)).document.lastPage, 6); assert.equal((await api('/health')).ok, true);
      await page.unroute(endpoint); await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].show(); BrowserWindow.getAllWindows()[0].focus(); });
      await quit();
    } else {
      await closed; application = null;
      assert.deepEqual(order, [5, 6]);
      await assert.rejects(fetch(origin + '/api/health', { signal: AbortSignal.timeout(1_000) }));
    }
    delete env.PAPERDESK_DESKTOP_PORT; await launch();
    assert.equal(base, origin, 'Restart must reuse the saved test origin'); await expect(currentPage(6)).toBeVisible();
    assert.equal((await document(a.id)).annotations.length, 2);
    assert.equal((await document(a.id)).annotations.find(value => value.id === annotation.id).comment, 'Electron 请求期间继续输入的最新评论');
  });

  await group('7: SQLite position failure blocks real quit, survives reload, and saves after connection recovery', async () => {
    db = new DatabaseSync(path.join(library, 'paperdesk.sqlite'));
    db.exec(`CREATE TRIGGER desktop_reliability_position_failure BEFORE UPDATE OF last_page ON documents
      WHEN NEW.id = '${a.id}' AND NEW.last_page <> OLD.last_page
      BEGIN SELECT RAISE(ABORT, 'isolated desktop position failure'); END;`);
    await page.getByRole('button', { name: '上一页', exact: true }).click(); await expect(currentPage(5)).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('阅读位置未保存');
    assert.equal((await document(a.id)).document.lastPage, 6);
    await reload(); await expect(currentPage(5)).toBeVisible(); await expect(page.getByRole('alert')).toContainText('阅读位置未保存');
    const count = await messageCount(); await application.evaluate(({ app }) => { app.quit(); });
    await expect.poll(messageCount).toBe(count + 1); assert.equal(await visible(), true);
    await expect(page.locator('.app-shell')).not.toHaveAttribute('inert');
    assert.equal((await document(a.id)).document.lastPage, 6); await screenshot('07-position-failure-cancels-native-quit');
    db.exec('DROP TRIGGER desktop_reliability_position_failure;'); db.close(); db = null;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(async () => (await document(a.id)).document.lastPage).toBe(5);
    await quit(); await launch(); await expect(currentPage(5)).toBeVisible();
  });

  await group('8: actual 10-second quit timeout retains window, late acknowledgement is safe, retry quits successfully', async () => {
    const endpoint = `${base}/api/documents/${a.id}`, hold = gate(); let intercepted = false;
    await page.route(endpoint, async route => {
      const body = route.request().method() === 'PATCH' ? route.request().postDataJSON() : null;
      if (body?.lastPage === 6 && !intercepted) { intercepted = true; hold.entered(); await hold.waiting; }
      await route.continue();
    });
    await page.getByRole('button', { name: '下一页', exact: true }).click(); await bounded(hold.started, 'page 6 held for native timeout');
    const count = await messageCount(), started = Date.now(); await application.evaluate(({ app }) => { app.quit(); });
    await expect(page.locator('.app-shell')).toHaveAttribute('inert', '');
    await expect.poll(messageCount, { timeout: 15_000 }).toBe(count + 1);
    const elapsed = Date.now() - started; assert.ok(elapsed >= 9_500, `Expected real 10-second deadline, got ${elapsed}ms`);
    const dialogs = await application.evaluate(() => globalThis.reliabilityDialogs);
    assert.match(dialogs.at(-1).detail, /保存确认尚未返回/);
    assert.equal(await visible(), true); await expect(page.locator('.app-shell')).not.toHaveAttribute('inert');
    assert.equal((await document(a.id)).document.lastPage, 5); await screenshot('08-native-timeout-keeps-page6');
    hold.release(); await expect.poll(async () => (await document(a.id)).document.lastPage).toBe(6);
    await page.unroute(endpoint); assert.equal(await messageCount(), count + 1);
    summary.timeoutMs = elapsed;
    await quit(); await launch(); await expect(currentPage(6)).toBeVisible();
    assert.equal((await api('/plugin/status')).libraryId, summary.identity.libraryId);
    await screenshot('08-successful-restart-page6'); await quit();
  });

  await group('9: injected abnormal test-process exit/restart exposes historical draft without overwriting saved comment/PDF', async () => {
    const origin = base; await launch(); assert.equal(base, origin); await expect(currentPage(6)).toBeVisible();
    await annotationsTab();
    const savedComment = (await document(a.id)).annotations.find(value => value.id === annotation.id).comment;
    await annotationCard().getByRole('button', { name: '编辑批注', exact: true }).click();
    const crashDraft = 'Electron 异常退出后历史评论草稿：必须供核对且不可自动覆盖';
    await commentEditor().fill(crashDraft); await assertDraftStored(crashDraft);
    const count = await messageCount(); await application.evaluate(({ app }) => { app.quit(); });
    await expect.poll(messageCount).toBe(count + 1); assert.equal(await visible(), true);
    await expect(page.locator('.app-shell')).not.toHaveAttribute('inert'); await expect(commentEditor()).toHaveValue(crashDraft);
    assert.equal((await document(a.id)).annotations.find(value => value.id === annotation.id).comment, savedComment);
    // Chromium's explicit storage flush precedes a controlled app.exit(7).
    // This is process-restart recovery, not an assertion about power loss or a
    // killed write during SQLite commit. Only the synthetic profile is touched.
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.session.flushStorageData());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await captureDialogs('before injected abnormal exit'); await screenshot('09-draft-before-injected-exit');
    const exiting = application, child = exiting.process(), closed = exiting.waitForEvent('close', { timeout: 15_000 });
    const childExited = child.exitCode !== null ? Promise.resolve(child.exitCode)
      : new Promise(resolve => child.once('exit', code => resolve(code)));
    await exiting.evaluate(({ app }, profile) => {
      if (app.getPath('userData') !== profile) throw new Error('Refusing abnormal exit outside the isolated profile');
      app.exit(7);
    }, userData).catch(error => { if (!/closed|Target page|Session closed/.test(error.message)) throw error; });
    await closed; application = null;
    const exitCode = await bounded(childExited, 'injected test process exit'); assert.equal(exitCode, 7);
    await assert.rejects(fetch(origin + '/api/health', { signal: AbortSignal.timeout(1_000) }));
    summary.abnormalExitInjection = { exitCode, storageFlushRequested: true, scope: 'isolated test profile only', powerLossTest: false };
    await launch(); assert.equal(base, origin); await expect(currentPage(6)).toBeVisible(); await annotationsTab();
    await expect(commentEditor()).toHaveCount(0);
    assert.equal((await document(a.id)).annotations.find(value => value.id === annotation.id).comment, savedComment);
    const historical = page.locator('.historical-drafts'); await expect(historical).toBeVisible();
    if (!await historical.evaluate(element => element.open)) await historical.locator('summary').click();
    const historicalComments = await historical.getByRole('textbox').evaluateAll(elements => elements.map(element => element.value));
    assert.ok(historicalComments.includes(crashDraft), 'Reopened Electron must expose the persisted draft for manual recovery');
    assert.equal(hash(await readFile(path.join(library, 'pdfs', `${a.id}.pdf`))), summary.originalPdfHashes.a);
    assert.equal(hash(await readFile(path.join(library, 'pdfs', `${b.id}.pdf`))), summary.originalPdfHashes.b);
    await screenshot('09-restarted-historical-draft'); await quit();
  });
  assert.deepEqual(rendererErrors, [], 'Real Electron renderer must have no uncaught errors');
  assert.deepEqual(automationErrors, [], 'Desktop automation must have no unexpected dialog errors');
  summary.status = 'passed';
} catch (error) {
  runError = error; summary.status = 'failed'; summary.error = { message: error.message, stack: error.stack };
  console.error(error.stack || error);
  if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
} finally {
  removeShutdownHandlers();
  for (const release of [...releases]) release();
  if (db) { try { db.exec('DROP TRIGGER IF EXISTS desktop_reliability_position_failure;'); } catch {} db.close(); db = null; }
  if (application) {
    await captureDialogs('cleanup').catch(() => {});
    await page?.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    try { await quit(); summary.cleanup = 'normal quit'; }
    catch {
      await closeTestApplication(application, userData);
      application = null;
      summary.cleanup = 'forced stop of own test instance after failed acceptance';
    }
  } else summary.cleanup ||= 'all test application instances exited normally';
  summary.finishedAt = new Date().toISOString();
  try { if (!preservePriorEvidence) {
    await mkdir(artifacts, { recursive: true });
    await writeFile(path.join(artifacts, 'results.json'), JSON.stringify(summary, null, 2) + '\n');
    await log(`RESULT: ${summary.status}; ${summary.groups.filter(item => item.status === 'passed').length}/${summary.groups.length} groups passed; synthetic fixtures removed after test; no backups created`);
  } } finally { await cleanup(); }
}
if (runError) process.exitCode = 1;
