import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { bookmarkedPdf } from './fixtures/toc-browser.mjs';
import { DOCUMENT_DRAG_TYPE } from '../shared/library.mjs';

export async function libraryThemesWorkflow({ context, base }) {
  const page = await context.newPage(), failures = [], writes = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('request', request => { if (request.method() === 'PATCH' && request.url().includes('/folder')) writes.push(request.postDataJSON()); });
  const json = async (path, body, method = 'GET') => {
    const response = await fetch(`${base}/api${path}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(response.ok, `${method} ${path}: ${response.status}`); return response.json();
  };
  const key = randomUUID().slice(0, 8), titleA = `书架验收甲-${key}`, titleB = `书架验收乙-${key}`;
  const upload = async title => {
    const form = new FormData(); form.append('file', new Blob([bookmarkedPdf(), `\n% ${title}\n`], { type: 'application/pdf' }), `${title}.pdf`);
    const response = await fetch(`${base}/api/documents`, { method: 'POST', body: form }); assert.equal(response.status, 201); return (await response.json()).document;
  };
  const a = await upload(titleA), b = await upload(titleB), note = '原创隔离笔记：移动文件夹不得更改此内容。';
  await json(`/documents/${a.id}`, { notesZh: note, notesEn: '' }, 'PATCH');
  const before = (await json(`/documents/${a.id}`)).document;
  try {
    await page.goto(`${base}/?document=${a.id}&page=1`);
    const sidebar = page.getByRole('complementary', { name: '文献栏', exact: true });
    const folderName = `专题-${key}`, renamed = `专题改名-${key}`;
    const notes = page.getByRole('textbox', { name: '笔记', exact: true });
    await expect(notes).toHaveValue(note);
    await expect(sidebar.getByRole('button', { name: '新建文件夹', exact: true })).toBeEnabled();
    await sidebar.getByRole('button', { name: '新建文件夹', exact: true }).click();
    const newFolder = page.getByRole('dialog', { name: '新建文件夹', exact: true });
    await newFolder.getByRole('textbox', { name: '文件夹名称', exact: true }).fill(folderName);
    await newFolder.getByRole('button', { name: '保存文件夹', exact: true }).click();
    await expect(newFolder).toHaveCount(0);
    const folder = sidebar.getByRole('button', { name: `文件夹：${folderName}`, exact: true });
    await expect(folder).toBeVisible();
    const folderId = (await json('/library')).folders.find(item => item.name === folderName).id;
    await page.evaluate(() => { window.importOverlaySeen = false; window.libraryObserver = new MutationObserver(() => { if (document.querySelector('.drop-overlay')) window.importOverlaySeen = true; }); window.libraryObserver.observe(document.body, { childList: true, subtree: true }); });
    const card = id => sidebar.locator(`[data-document-id="${id}"] .document-item`);
    await card(a.id).dragTo(folder);
    await expect.poll(async () => (await json(`/documents/${a.id}`)).document.folderId).toBe(folderId);
    assert.equal(await page.evaluate(() => window.importOverlaySeen), false, 'Internal document dragging must never display PDF import UI');
    await folder.click();
    await expect(card(a.id)).toBeVisible(); await expect(card(b.id)).toHaveCount(0);
    await expect(page.locator('.header-title h1')).toHaveText(a.title); await expect(notes).toHaveValue(note);
    await card(a.id).dragTo(sidebar.getByRole('button', { name: '未分类', exact: true }));
    await expect.poll(async () => (await json(`/documents/${a.id}`)).document.folderId).toBe(null);
    await sidebar.getByRole('button', { name: '未分类', exact: true }).click();
    await sidebar.getByRole('combobox', { name: `移动文献：${a.title}`, exact: true }).selectOption(folderId);
    await expect.poll(async () => (await json(`/documents/${a.id}`)).document.folderId).toBe(folderId);
    await sidebar.getByRole('button', { name: `重命名文件夹：${folderName}`, exact: true }).click();
    const rename = page.getByRole('dialog', { name: '重命名文件夹', exact: true });
    await rename.getByRole('textbox', { name: '文件夹名称', exact: true }).fill(renamed);
    await rename.getByRole('button', { name: '保存文件夹', exact: true }).click();
    await expect(sidebar.getByRole('button', { name: `文件夹：${renamed}`, exact: true })).toContainText('1');
    await page.reload();
    await expect(sidebar.getByRole('button', { name: `文件夹：${renamed}`, exact: true })).toBeVisible();
    await expect(sidebar.getByRole('combobox', { name: `移动文献：${a.title}`, exact: true })).toHaveValue(folderId);
    // A forged payload with a valid document ID has no same-page drag token.
    const movesBeforeForgery = writes.length;
    await sidebar.getByRole('button', { name: '未分类', exact: true }).evaluate((target, payload) => {
      const transfer = new DataTransfer(); transfer.setData(payload.type, JSON.stringify({ documentId: payload.id, token: 'external' }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }, { type: DOCUMENT_DRAG_TYPE, id: a.id });
    assert.equal(writes.length, movesBeforeForgery);
    assert.equal((await json(`/documents/${a.id}`)).document.folderId, folderId);
    await sidebar.getByRole('button', { name: `删除文件夹：${renamed}`, exact: true }).click();
    const deletion = page.getByRole('dialog', { name: '删除文件夹', exact: true });
    await expect(deletion).toContainText('文献会回到未分类');
    await deletion.getByRole('button', { name: '删除文件夹', exact: true }).click();
    await expect(deletion).toHaveCount(0);
    const after = (await json(`/documents/${a.id}`)).document;
    assert.equal(after.folderId, null); assert.equal(after.notesZh, before.notesZh); assert.equal(after.notesRevision, before.notesRevision);
    assert.equal((await json(`/documents/${b.id}`)).document.id, b.id);
    await expect(notes).toHaveValue(note);
    console.log('PASS: actual document drag, unfiled return, keyboard move, rename/delete preservation, reload and forged-drag rejection');

    const colors = () => page.evaluate(() => ({ paper: getComputedStyle(document.querySelector('.pdf-paper')).backgroundColor, side: getComputedStyle(document.querySelector('.sidebar')).backgroundColor, notes: getComputedStyle(document.querySelector('.notes-field textarea')).backgroundColor, toolbar: getComputedStyle(document.querySelector('.reader-toolbar')).backgroundColor }));
    await expect(page.locator('.pdf-paper canvas')).toBeVisible();
    await sidebar.getByRole('button', { name: '主题：暖砂', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'sand'); const light = await colors();
    await sidebar.getByRole('button', { name: '主题：夜读', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'night'); const dark = await colors();
    assert.notEqual(dark.side, light.side); assert.notEqual(dark.notes, light.notes); assert.notEqual(dark.toolbar, light.toolbar);
    assert.equal(dark.paper, 'rgb(255, 255, 255)'); assert.equal(light.paper, dark.paper);
    await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
    assert.equal((await json('/library')).theme, 'night');

    let releaseTheme, themeEntered;
    const held = new Promise(resolve => { themeEntered = resolve; });
    const release = new Promise(resolve => { releaseTheme = resolve; });
    const themeOrder = [];
    await page.route(`${base}/api/library/theme`, async route => {
      const id = route.request().postDataJSON().theme; themeOrder.push(id);
      if (id === 'sand') { const response = await route.fetch(); themeEntered(); await release; await route.fulfill({ response }); }
      else await route.continue();
    });
    await sidebar.getByRole('button', { name: '主题：暖砂', exact: true }).click(); await held;
    await sidebar.getByRole('button', { name: '主题：雾蓝', exact: true }).click();
    assert.deepEqual(themeOrder, ['sand'], 'A second theme write waits for the first acknowledgement');
    releaseTheme(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'slate');
    assert.deepEqual(themeOrder, ['sand', 'slate']); assert.equal((await json('/library')).theme, 'slate');
    await page.unroute(`${base}/api/library/theme`);
    await page.route(`${base}/api/library/theme`, route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '隔离测试保存失败' }) }));
    await sidebar.getByRole('button', { name: '主题：森林', exact: true }).click();
    await expect(sidebar.getByRole('alert')).toContainText('主题未保存');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'slate');
    assert.equal((await json('/library')).theme, 'slate'); await page.unroute(`${base}/api/library/theme`);
    const remoteFolder = (await json('/folders', { name: `另一窗口-${key}` }, 'POST')).folder;
    await json(`/documents/${b.id}/folder`, { folderId: remoteFolder.id }, 'PATCH');
    await json('/library/theme', { theme: 'forest' }, 'PATCH');
    await sidebar.getByRole('button', { name: '刷新文献库', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'forest');
    await expect(sidebar.getByRole('button', { name: `文件夹：${remoteFolder.name}`, exact: true })).toContainText('1');
    await expect(sidebar.getByRole('combobox', { name: `移动文献：${b.title}`, exact: true })).toHaveValue(remoteFolder.id);
    await expect(notes).toHaveValue(note);
    const moveEndpoint = `${base}/api/documents/${a.id}/folder`;
    await page.route(moveEndpoint, route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '隔离测试移动失败' }) }));
    await sidebar.getByRole('combobox', { name: `移动文献：${a.title}`, exact: true }).selectOption(remoteFolder.id);
    await expect(sidebar.getByRole('alert')).toContainText('移动失败');
    await expect(sidebar.getByRole('combobox', { name: `移动文献：${a.title}`, exact: true })).toHaveValue('');
    assert.equal((await json(`/documents/${a.id}`)).document.folderId, null);
    await page.unroute(moveEndpoint);
    // Filtering the shelf must not replace the current book or flush its draft.
    await page.route(`${base}/api/documents/${a.id}`, route => route.request().method() === 'PATCH' && Object.hasOwn(route.request().postDataJSON(), 'notesZh') ? route.abort('failed') : route.continue());
    await notes.fill('仍在编辑的隔离草稿，不应因切换文件夹丢失。');
    await sidebar.getByRole('button', { name: `文件夹：${remoteFolder.name}`, exact: true }).click();
    await expect(page.locator('.header-title h1')).toHaveText(a.title);
    await expect(notes).toHaveValue('仍在编辑的隔离草稿，不应因切换文件夹丢失。');
    assert.equal((await json(`/documents/${a.id}`)).document.notesZh, note);
    await page.setViewportSize({ width: 688, height: 820 });
    await expect(sidebar.getByRole('button', { name: '未分类', exact: true })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: '主题：夜读', exact: true })).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    assert.deepEqual(failures, []);
    console.log('PASS: four persisted themes, unchanged PDF whites, ordered rapid writes, failure preservation, cross-client refresh and narrow layout');
  } finally { await page.close(); }
}
