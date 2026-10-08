// Real Electron acceptance with only checked-in PDF fixtures and temporary data.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { _electron as electron, expect as playwrightExpect } from '@playwright/test';
import { clearInheritedTestStorage } from './test-isolated.mjs';

clearInheritedTestStorage();

const expect = playwrightExpect.configure({ timeout: 15_000 });
const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { packaged: { type: 'string' } } });
const appBundle = values.packaged ? path.resolve(values.packaged) : null;
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Desktop acceptance requires an Apple Silicon Mac.');
const executablePath = appBundle ? path.join(appBundle, 'Contents/MacOS/Paperdesk')
  : process.env.ELECTRON_EXECUTABLE_PATH || createRequire(import.meta.url)('electron');
await access(executablePath);
await access(path.join(root, 'dist/index.html'));
const artifacts = path.join(root, '.local/verification/bookmarks');
await mkdir(artifacts, { recursive: true });
const temporary = await mkdtemp(path.join(tmpdir(), 'paperdesk-vault-desktop-'));
const userData = path.join(temporary, 'profile'), vaultDir = path.join(temporary, '测试知识库'), cacheHome = path.join(temporary, 'fixture-home');
await mkdir(path.join(vaultDir, '.obsidian'), { recursive: true });
await mkdir(cacheHome);
const canonicalVault = await realpath(vaultDir), canonicalTemporary = await realpath(temporary);
const sample = path.join(root, 'public/examples/reading-demo.pdf');
const original = await readFile(sample), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceRelative = '原有资料/阅读 #示例.pdf';
const sourcePdf = path.join(canonicalVault, ...sourceRelative.split('/'));
await mkdir(path.dirname(sourcePdf), { recursive: true });
await writeFile(sourcePdf, original);
const externalPdf = path.join(temporary, '外部导入.pdf');
const externalBytes = Buffer.concat([original, Buffer.from('\n% isolated external import fixture\n')]);
await writeFile(externalPdf, externalBytes);
const label = appBundle ? 'packaged' : 'source';
const env = { ...process.env, PAPERDESK_DESKTOP_USER_DATA: userData, PAPERDESK_DESKTOP_PORT: '0' };
delete env.ELECTRON_RUN_AS_NODE;
const rendererErrors = [], checks = [];
let application, page, baseUrl, runError;
const summary = { kind: `${label}-electron-obsidian-vault`, checks, rendererErrors, status: 'running' };

async function record(message) { checks.push(message); console.log(`PASS: ${message}`); }
async function request(endpoint) {
  const response = await fetch(`${baseUrl}/api${endpoint}`, { signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, endpoint);
  return response.json();
}
async function managedPdfCopies() {
  try { return await readdir(path.join(canonicalVault, 'Paperdesk', 'PDFs')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function launch() {
  application = await electron.launch({ executablePath, args: appBundle ? [] : [root], cwd: temporary, env, chromiumSandbox: true, timeout: 60_000 });
  page = await application.firstWindow();
  page.on('pageerror', error => rendererErrors.push(error.message));
  await application.evaluate(({ BrowserWindow, dialog, shell }) => {
    globalThis.vaultDesktopMessages = [];
    globalThis.vaultDesktopOpenedUris = [];
    dialog.showMessageBox = async (...args) => { globalThis.vaultDesktopMessages.push(args.at(-1)); return { response: 0 }; };
    // Never launch the user's real Obsidian app during acceptance.
    shell.openExternal = async uri => { globalThis.vaultDesktopOpenedUris.push(uri); };
    BrowserWindow.getAllWindows()[0].show(); BrowserWindow.getAllWindows()[0].focus();
  });
  await page.bringToFront();
  await expect(page.locator('.app-shell')).toBeVisible();
  const versions = await application.evaluate(() => ({ node: process.versions.node, electron: process.versions.electron }));
  assert.ok(Number(versions.node.split('.')[0]) >= 24, 'The Electron child must provide a supported Node runtime');
  summary.versions = versions;
  baseUrl = new URL(page.url()).origin;
}
async function importPdf(file = sample, expectedStatus = 201) {
  const incoming = page.waitForResponse(response => response.url() === `${baseUrl}/api/documents` && response.request().method() === 'POST');
  await page.getByLabel('选择 PDF 文件').setInputFiles(file);
  const response = await incoming;
  assert.equal(response.status(), expectedStatus);
  const { document } = await response.json();
  await expect(page.getByLabel('PDF 第 1 页', { exact: true })).toBeVisible();
  await expect(page.locator('.textLayer span').first()).toBeVisible();
  return document;
}
async function selectVaultPdf() {
  const sourceChoice = page.getByRole('button', { name: `打开 Obsidian PDF：${sourceRelative}`, exact: true });
  await expect(sourceChoice).toBeVisible();
  await expect(sourceChoice).toContainText(path.basename(sourceRelative));
  await expect(sourceChoice).toContainText(path.dirname(sourceRelative));
  assert.equal((await request('/documents')).documents.length, 0, 'Listing existing PDFs must not associate them');
  assert.deepEqual(await managedPdfCopies(), []);
  await page.screenshot({ path: path.join(artifacts, `${label}-sidebar.png`) });
  const pending = page.waitForResponse(response => response.url() === `${baseUrl}/api/vault/pdfs/open` && response.request().method() === 'POST');
  await sourceChoice.click();
  const response = await pending;
  assert.equal(response.status(), 201);
  const { document } = await response.json();
  await expect(page.getByLabel('PDF 第 1 页', { exact: true })).toBeVisible();
  await expect(page.locator('.textLayer span').first()).toBeVisible();
  return document;
}
async function annotateVaultPdf(document) {
  const heading = page.locator('.textLayer span').filter({ hasText: /^Reading with intention$/ });
  await expect(heading).toBeVisible();
  await expect(page.locator('.pdf-paper')).not.toHaveClass(/is-loading/);
  await heading.hover();
  const box = await heading.boundingBox();
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('.selection-summary p')).toHaveText('Reading with intention');
  await page.getByRole('button', { name: '高亮并批注', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /高亮与批注/ });
  await dialog.getByRole('textbox', { name: '批注评论', exact: true }).fill('直接选择 Obsidian 原 PDF 后的桌面批注。');
  await dialog.getByRole('button', { name: '保存批注', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const { annotations } = await request(`/documents/${document.id}`);
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].quote, 'Reading with intention');
  assert.equal(annotations[0].comment, '直接选择 Obsidian 原 PDF 后的桌面批注。');
  await page.locator('.panel-tabs').getByRole('button', { name: '笔记', exact: true }).click();
  return annotations[0];
}
async function bookmarkSecondPage(document) {
  const number = page.getByRole('spinbutton', { name: '页码', exact: true });
  await number.fill('2'); await number.press('Enter');
  await expect(number).toHaveValue('2');
  await expect(page.getByLabel('PDF 第 2 页', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '展开书签', exact: true }).click();
  const panel = page.getByRole('region', { name: '个人书签', exact: true });
  const endpoint = `${baseUrl}/api/documents/${document.id}/bookmarks`;
  const created = page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'POST');
  await panel.getByRole('button', { name: '添加当前页书签', exact: true }).click();
  const response = await created; assert.equal(response.status(), 201);
  const bookmark = (await response.json()).bookmark;
  await panel.getByRole('button', { name: '重命名书签：第 2 页，PDF 第 2 页', exact: true }).click();
  const title = '回访第二页';
  await panel.getByRole('textbox', { name: '书签名称，PDF 第 2 页', exact: true }).fill(title);
  const messagesBefore = await application.evaluate(() => globalThis.vaultDesktopMessages.length);
  await application.evaluate(({ app }) => app.quit());
  await expect.poll(() => application.evaluate(() => globalThis.vaultDesktopMessages.length)).toBe(messagesBefore + 1);
  const preventedQuit = await application.evaluate(() => globalThis.vaultDesktopMessages.pop());
  assert.match(preventedQuit.detail, /书签/);
  await expect(panel.getByRole('textbox', { name: '书签名称，PDF 第 2 页', exact: true })).toHaveValue(title);
  summary.bookmarkQuitGuard = { message: preventedQuit.message, detail: preventedQuit.detail };
  await record('native quit refuses an unsaved bookmark name and preserves its input until explicitly saved');
  const renamed = page.waitForResponse(response => response.url() === `${endpoint}/${bookmark.id}` && response.request().method() === 'PATCH');
  await panel.getByRole('button', { name: '保存书签名称', exact: true }).click();
  const renameResponse = await renamed; assert.equal(renameResponse.status(), 200);
  const saved = (await renameResponse.json()).bookmark;
  await expect(panel.getByRole('button', { name: `书签：${title}，PDF 第 2 页`, exact: true })).toBeVisible();
  await number.fill('1'); await number.press('Enter');
  await expect(page.getByLabel('PDF 第 1 页', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: `书签：${title}，PDF 第 2 页`, exact: true }).click();
  await expect(number).toHaveValue('2');
  await expect(page.getByLabel('PDF 第 2 页', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(artifacts, `${label}-bookmarks.png`) });
  await number.fill('1'); await number.press('Enter');
  await expect(page.getByLabel('PDF 第 1 页', { exact: true })).toBeVisible();
  const close = page.getByRole('button', { name: '收起书签', exact: true });
  if (await close.isVisible()) await close.click();
  return saved;
}
async function quit() {
  const current = application, stoppedUrl = baseUrl;
  const closed = current.waitForEvent('close', { timeout: 30_000 });
  await current.evaluate(({ app }) => { app.quit(); }).catch(error => { if (!/closed|Target page|Session closed/.test(error.message)) throw error; });
  await closed; application = null;
  await assert.rejects(fetch(`${stoppedUrl}/api/health`, { signal: AbortSignal.timeout(1000) }));
}

try {
  await launch();
  assert.equal((await request('/storage')).mode, 'library');
  assert.equal((await request('/documents')).documents.length, 0);
  const previousBook = await importPdf();
  const previousNotes = '切换 Obsidian 仓库前，原库的待保存笔记必须完成。';
  const editor = page.getByRole('textbox', { name: '笔记', exact: true });
  await editor.fill(previousNotes);
  await application.evaluate(async ({ dialog, Menu }, fixtureHome) => {
    // This stub is local to the isolated Electron child. It sends the default
    // hashed vault cache into the fixture, without changing HOME or real data.
    const os = process.getBuiltinModule('node:os');
    globalThis.vaultDesktopOriginalHomedir = os.homedir;
    os.homedir = () => fixtureHome;
    dialog.showOpenDialog = () => new Promise(resolve => { globalThis.vaultDesktopPickerResolve = resolve; });
    Menu.getApplicationMenu().getMenuItemById('open-obsidian-vault').click();
  }, cacheHome);
  await expect(page.locator('.app-shell')).toHaveAttribute('inert', '');
  await expect.poll(async () => (await request(`/documents/${previousBook.id}`)).document.notesZh).toBe(previousNotes);
  await page.keyboard.type('这段文字不得进入已经锁住的原库');
  await expect(editor).toHaveValue(previousNotes);
  const previousUrl = baseUrl;
  await application.evaluate((_electron, directory) => { globalThis.vaultDesktopPickerResolve({ canceled: false, filePaths: [directory] }); }, vaultDir);
  await expect.poll(async () => JSON.parse(await readFile(path.join(userData, 'desktop-settings.json'), 'utf8')).vaultDir).toBe(canonicalVault);
  await expect(page.locator('.app-shell')).not.toHaveAttribute('inert');
  await expect(page.getByRole('button', { name: '选择 Obsidian PDF', exact: true })).toBeVisible();
  baseUrl = new URL(page.url()).origin;
  await application.evaluate(() => { process.getBuiltinModule('node:os').homedir = globalThis.vaultDesktopOriginalHomedir; });
  await assert.rejects(fetch(previousUrl + '/api/health', { signal: AbortSignal.timeout(1000) }));
  const settings = JSON.parse(await readFile(path.join(userData, 'desktop-settings.json'), 'utf8'));
  assert.ok(settings.dataDir.startsWith(canonicalTemporary + path.sep), 'Acceptance cache must stay inside the isolated fixture');
  assert.equal(settings.vaultSubdir, 'Paperdesk');
  const storage = await request('/storage');
  assert.equal(storage.mode, 'vault');
  assert.equal(storage.vaultName, '测试知识库');
  assert.equal(storage.documentCount, 0);
  await record('native vault selection flushes the old library, locks editing and opens only the isolated Obsidian root');

  const document = await selectVaultPdf();
  const annotation = await annotateVaultPdf(document);
  const notes = '## Obsidian 桌面验收\n\nPDF 和 Markdown 是正式资料。\n桌面保存后可以从仓库读回。';
  await editor.fill(notes);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.save-row [role="status"]')).toHaveText('已保存到 Obsidian 仓库');
  const noteUri = (await request(`/documents/${document.id}/vault-note`)).uri;
  const notePath = new URL(noteUri).searchParams.get('path');
  assert.ok(notePath.startsWith(path.join(canonicalVault, 'Paperdesk', 'Notes') + path.sep));
  assert.ok((await stat(notePath)).isFile());
  assert.match(await readFile(notePath, 'utf8'), /PDF 和 Markdown 是正式资料/);
  assert.equal(hash(await readFile(sourcePdf)), hash(original));
  assert.deepEqual(await managedPdfCopies(), [], 'Selecting a vault PDF must not create a PDF copy');
  const source = JSON.parse((await readFile(notePath, 'utf8')).match(/<!-- paperdesk-state:v1\n([^\n]*)\n-->/)[1]);
  assert.equal(source.version, 3);
  assert.deepEqual(source.pdfSource, { kind: 'vault', path: sourceRelative });
  assert.equal(source.annotations[0].id, annotation.id);
  assert.equal((await request(`/documents/${document.id}`)).document.notesZh, notes);
  await record('the sidebar automatically lists vault PDFs without association and opens the existing file in place, preserving its hash');

  const imported = await importPdf(externalPdf);
  assert.equal(hash(await readFile(externalPdf)), hash(externalBytes), 'External original must stay unchanged');
  assert.equal(hash(await readFile(path.join(canonicalVault, 'Paperdesk', 'PDFs', `${imported.id}.pdf`))), hash(externalBytes));
  assert.deepEqual(await managedPdfCopies(), [`${imported.id}.pdf`]);
  const importedState = JSON.parse((await readFile(path.join(canonicalVault, 'Paperdesk', 'Notes', `${imported.id}.md`), 'utf8')).match(/<!-- paperdesk-state:v1\n([^\n]*)\n-->/)[1]);
  assert.equal(importedState.version, 3);
  assert.equal((await importPdf(externalPdf, 200)).id, imported.id);
  assert.deepEqual(await managedPdfCopies(), [`${imported.id}.pdf`]);
  assert.equal((await request('/documents')).documents.length, 2);
  await page.locator(`[data-document-id="${document.id}"] .document-item`).click();
  await expect(editor).toHaveValue(notes);
  await record('vault upload saves an external PDF copy inside Obsidian, preserves the external original and deduplicates repeat imports');

  const bookmark = await bookmarkSecondPage(document);
  assert.deepEqual((await request(`/documents/${document.id}/bookmarks`)).bookmarks, [bookmark]);
  const bookmarkedState = JSON.parse((await readFile(notePath, 'utf8')).match(/<!-- paperdesk-state:v1\n([^\n]*)\n-->/)[1]);
  assert.equal(bookmarkedState.bookmarks[0].id, bookmark.id);
  assert.equal(bookmarkedState.bookmarks[0].page, 2);
  assert.match(await readFile(notePath, 'utf8'), /回访第二页/);
  assert.equal(hash(await readFile(sourcePdf)), hash(original));
  await record('native personal bookmarks add, rename and jump to the actual PDF page, persist in Markdown and preserve the original PDF');

  await page.getByRole('button', { name: '资料位置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '资料位置', exact: true });
  await expect(dialog).toContainText('测试知识库');
  await expect(dialog).toContainText('资料文件夹：Paperdesk');
  await dialog.getByRole('button', { name: '重新读取仓库', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '重新读取仓库', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '在 Obsidian 中打开笔记', exact: true }).click();
  await expect.poll(() => application.evaluate(() => globalThis.vaultDesktopOpenedUris.length)).toBe(1);
  const opened = await application.evaluate(() => globalThis.vaultDesktopOpenedUris[0]);
  assert.equal(opened, noteUri);
  assert.equal(new URL(opened).protocol, 'obsidian:');
  const invalidOpen = await page.evaluate(async () => {
    try { await window.paperdeskDesktop.openVaultNote('file:///arbitrary.md'); return false; } catch { return true; }
  });
  assert.equal(invalidOpen, true);
  assert.equal(await application.evaluate(() => globalThis.vaultDesktopOpenedUris.length), 1);
  await page.screenshot({ path: path.join(artifacts, `${label}-storage.png`) });
  await dialog.getByRole('button', { name: '关闭资料位置', exact: true }).click();
  await record('storage dialog refreshes the vault and narrow desktop IPC opens only the active document Markdown URI');

  const finalNotes = notes + '\n\n退出前新输入的内容。';
  await editor.fill(finalNotes);
  await quit();
  assert.match(await readFile(notePath, 'utf8'), /退出前新输入的内容/);
  delete env.PAPERDESK_DESKTOP_PORT;
  await launch();
  await expect(page.getByRole('textbox', { name: '笔记', exact: true })).toHaveValue(finalNotes);
  await expect(page.getByLabel('PDF 第 1 页', { exact: true })).toBeVisible();
  await expect(page.locator('.textLayer span').first()).toBeVisible();
  assert.equal((await request('/storage')).mode, 'vault');
  assert.equal((await request('/documents')).documents.length, 2);
  assert.deepEqual((await request(`/documents/${document.id}`)).annotations, [annotation]);
  await expect(page.locator(`[data-annotation="${annotation.id}"]`).first()).toBeVisible();
  assert.deepEqual(JSON.parse(await readFile(path.join(userData, 'desktop-settings.json'), 'utf8')), settings);
  assert.equal(hash(await readFile(sourcePdf)), hash(original));
  assert.deepEqual(await managedPdfCopies(), [`${imported.id}.pdf`]);
  assert.deepEqual(await application.evaluate(() => globalThis.vaultDesktopMessages), []);
  await page.screenshot({ path: path.join(artifacts, `${label}-reader-restarted.png`) });
  await quit();
  await launch();
  await page.getByRole('button', { name: '展开书签', exact: true }).click();
  const reopenedBookmarks = page.getByRole('region', { name: '个人书签', exact: true });
  await reopenedBookmarks.getByRole('button', { name: `书签：${bookmark.title}，PDF 第 2 页`, exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: '页码', exact: true })).toHaveValue('2');
  await expect(page.getByLabel('PDF 第 2 页', { exact: true })).toBeVisible();
  assert.deepEqual((await request(`/documents/${document.id}/bookmarks`)).bookmarks, [bookmark]);
  assert.equal((await request(`/documents/${document.id}`)).document.notesZh, finalNotes);
  assert.deepEqual((await request(`/documents/${document.id}`)).annotations, [annotation]);
  assert.equal(hash(await readFile(sourcePdf)), hash(original));
  await page.screenshot({ path: path.join(artifacts, `${label}-bookmarks-restarted.png`) });
  await quit();
  await record('native quit flush and relaunch restore personal bookmarks and their page jumps, together with the PDF, notes and annotations');
  assert.deepEqual(rendererErrors, []);
  summary.status = 'passed';
  console.log(`PASS: ${label} Electron Obsidian vault acceptance complete`);
} catch (error) {
  runError = error;
  summary.status = 'failed'; summary.error = error.message;
  if (application) {
    summary.dialogs = await application.evaluate(() => globalThis.vaultDesktopMessages).catch(() => []);
    await page?.screenshot({ path: path.join(artifacts, `${label}-failed.png`) }).catch(() => {});
  }
} finally {
  if (application) await application.close().catch(() => application.process().kill('SIGKILL'));
  await writeFile(path.join(artifacts, `${label}-summary.json`), JSON.stringify(summary, null, 2) + '\n');
  await rm(temporary, { recursive: true, force: true });
}
if (runError) throw runError;
