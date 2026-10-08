import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { graphicsOnlyPdf } from './fixtures/scan-browser.mjs';

// The caller supplies an isolated server and browser context. All PDFs/comments
// are original fixtures; there are no translation or conversation requests.
export async function annotationDraftWorkflow({ page: suppliedPage, context, base }) {
  const page = suppliedPage || await context.newPage();
  const extraPages = [], pageErrors = [];
  const cardIds = new Map();
  const key = randomUUID().slice(0, 8);
  const draftPrefix = 'paperdesk-annotation-draft-';
  const json = async (path, body, method = 'GET') => {
    const response = await fetch(`${base}/api${path}`, {
      method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.ok(response.ok, `${method} ${path}: ${response.status}`);
    return response.json();
  };
  const upload = async label => {
    const body = new FormData();
    body.append('file', new Blob([graphicsOnlyPdf(), `\n% annotation draft ${key} ${label}\n`], { type: 'application/pdf' }), `annotation-draft-${label}-${key}.pdf`);
    const response = await fetch(`${base}/api/documents`, { method: 'POST', body });
    assert.equal(response.status, 201);
    return (await response.json()).document;
  };
  const createAnnotation = async (book, comment) => (await json(`/documents/${book.id}/annotations`, {
    page: 1, kind: 'region', quote: '', comment, color: 'yellow',
    rects: [{ x: .1, y: .1, width: .3, height: .15 }],
  }, 'POST')).annotation;
  const installDesktopProbe = async target => {
    target.on('pageerror', error => pageErrors.push(error.message));
    target.on('dialog', async dialog => { await dialog.accept(); });
    await target.addInitScript(() => {
      window.paperdeskDesktop = {
        onLibrarySwitch: () => () => {},
        onFlushRequest: handler => { window.__annotationFlush = handler; return () => {}; },
      };
    });
  };
  const showAnnotations = async target => {
    const expand = target.getByRole('button', { name: '展开笔记面板', exact: true });
    if (await expand.count()) await expand.click();
    await target.locator('.panel-tabs button').nth(1).click();
  };
  // Creation timestamps may tie and UUID ordering can change card positions.
  // Bind comment aliases to record IDs so every fault targets the intended card.
  const byComment = (target, original) => target.locator(`[data-annotation-id="${cardIds.get(original)}"]`);
  const draftEditor = (target, original) => byComment(target, original).getByRole('textbox', { name: '编辑批注内容', exact: true });
  const drafts = async target => target.evaluate(prefix => Object.fromEntries(Object.keys(localStorage)
    .filter(name => name.startsWith(prefix)).map(name => [name, localStorage.getItem(name)])), draftPrefix);
  const slotPointer = (target, documentId, draftTarget) => target.evaluate(({ documentId, draftTarget }) => {
    const pointer = Object.keys(sessionStorage).find(name => name.startsWith('paperdesk-annotation-slot-') && name.endsWith(`-${documentId}-${draftTarget}`));
    return pointer ? sessionStorage.getItem(pointer) : null;
  }, { documentId, draftTarget });
  const activeDraft = async (target, documentId, draftTarget) => {
    const pointer = await slotPointer(target, documentId, draftTarget);
    return pointer && pointer !== 'saved' ? target.evaluate(name => JSON.parse(localStorage.getItem(name) || 'null'), pointer) : null;
  };
  const beforeunloadPrevented = target => target.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event); return event.defaultPrevented;
  });
  const flushResult = target => target.evaluate(async () => {
    try { await window.__annotationFlush(); return { ok: true }; }
    catch (error) { return { ok: false, message: error.message }; }
  });
  const openFromLibrary = async (target, book) => {
    const expand = target.getByRole('button', { name: '展开文献栏', exact: true });
    if (await expand.count()) await expand.click();
    const sidebar = target.getByRole('complementary', { name: '文献栏', exact: true });
    await sidebar.getByRole('button', { name: '全部文献', exact: true }).click();
    await sidebar.locator(`[data-document-id="${book.id}"] .document-item`).click();
    await expect(target.locator('.header-title h1')).toHaveText(book.title);
  };
  const openRegionModal = async target => {
    await target.getByRole('combobox', { name: '页面布局', exact: true }).selectOption('1');
    await target.getByRole('combobox', { name: '翻页方式', exact: true }).selectOption('paged');
    await target.getByRole('combobox', { name: '阅读缩放', exact: true }).selectOption('fit');
    await expect(target.locator('.pdf-paper canvas')).toBeVisible();
    const toggle = target.getByRole('button', { name: '区域批注', exact: true });
    if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
    const bounds = await target.locator('.pdf-paper').boundingBox();
    await target.mouse.move(bounds.x + bounds.width * .2, bounds.y + bounds.height * .22);
    await target.mouse.down();
    await target.mouse.move(bounds.x + bounds.width * .5, bounds.y + bounds.height * .4, { steps: 8 });
    await target.mouse.up();
    await target.getByRole('button', { name: '添加区域批注', exact: true }).click();
    return target.getByRole('dialog', { name: /区域批注/ });
  };
  const a = await upload('a'), b = await upload('b');
  const a1 = await createAnnotation(a, `原始批注甲-${key}`);
  const a2 = await createAnnotation(a, `原始批注乙-${key}`);
  const b1 = await createAnnotation(b, `另篇原始批注-${key}`);
  cardIds.set(a1.comment, a1.id); cardIds.set(a2.comment, a2.id); cardIds.set(b1.comment, b1.id);
  try {
    await installDesktopProbe(page);
    await page.goto(`${base}/?document=${a.id}&page=1`);
    await expect(page.getByLabel('PDF 第 1 页', { exact: true })).toBeVisible();
    await showAnnotations(page);
    const firstCard = byComment(page, a1.comment);
    await firstCard.getByRole('button', { name: '编辑批注', exact: true }).click();
    const retained = `切换标签与刷新仍应保留的批注草稿-${key}`;
    cardIds.set(retained, a1.id);
    await draftEditor(page, a1.comment).fill(retained);
    await page.locator('.panel-tabs button').nth(0).click();
    await showAnnotations(page);
    // This assertion fails on the original v1.1.0-beta.4 implementation.
    await expect(draftEditor(page, a1.comment)).toHaveValue(retained);
    assert.equal((await json(`/documents/${a.id}`)).annotations.find(item => item.id === a1.id).comment, a1.comment);
    assert.equal(await beforeunloadPrevented(page), true);
    const blockedFlush = await flushResult(page);
    assert.equal(blockedFlush.ok, false);
    assert.match(blockedFlush.message, /批注|草稿|保存/);
    await page.reload(); await showAnnotations(page);
    await expect(draftEditor(page, a1.comment)).toHaveValue(retained);
    await openFromLibrary(page, b); await showAnnotations(page);
    await expect(page.getByRole('textbox', { name: '编辑批注内容', exact: true })).toHaveCount(0);
    await byComment(page, b1.comment).getByRole('button', { name: '编辑批注', exact: true }).click();
    const otherBook = `另篇独立草稿-${key}`;
    await draftEditor(page, b1.comment).fill(otherBook);
    await openFromLibrary(page, a); await showAnnotations(page);
    await expect(draftEditor(page, a1.comment)).toHaveValue(retained);
    console.log('PASS: annotation comments survive panel tabs, reload and document changes; dirty comments block unload/desktop flush');

    // A failed PATCH keeps the editor and recovery copy. Saving one card must
    // not clear a different card or a different document's draft.
    const secondCard = byComment(page, a2.comment);
    await secondCard.getByRole('button', { name: '编辑批注', exact: true }).click();
    const secondDraft = `第二条仍未保存的评论-${key}`;
    await draftEditor(page, a2.comment).fill(secondDraft);
    const patchEndpoint = `${base}/api/documents/${a.id}/annotations/${a1.id}`;
    await page.route(patchEndpoint, route => route.request().method() === 'PATCH'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '隔离批注保存失败' }) }) : route.continue());
    await firstCard.getByRole('button', { name: '保存', exact: true }).click();
    await expect(firstCard.getByRole('alert')).toContainText('保存失败');
    await expect(draftEditor(page, a1.comment)).toHaveValue(retained);
    assert.ok(Object.values(await drafts(page)).some(value => value.includes(retained)));
    await page.unroute(patchEndpoint);
    await firstCard.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(async () => (await json(`/documents/${a.id}`)).annotations.find(item => item.id === a1.id).comment).toBe(retained);
    await expect(draftEditor(page, a1.comment)).toHaveCount(0);
    await expect(draftEditor(page, a2.comment)).toHaveValue(secondDraft);
    const afterOneSave = Object.values(await drafts(page));
    assert.ok(afterOneSave.some(value => value.includes(secondDraft)));
    assert.ok(afterOneSave.some(value => value.includes(otherBook)));
    assert.equal(await slotPointer(page, a.id, `edit-${a1.id}`), 'saved', 'Only the acknowledged card is marked saved; inherited historical slots may remain');
    // A save acknowledgement also must not erase text typed while it was in
    // flight; the next save should use the acknowledged updatedAt revision.
    const secondEndpoint = `${base}/api/documents/${a.id}/annotations/${a2.id}`;
    let entered, release;
    const enteredSave = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let held = false;
    await page.route(secondEndpoint, async route => {
      if (route.request().method() === 'PATCH' && !held) {
        held = true;
        const response = await route.fetch(); entered(); await gate;
        await route.fulfill({ response });
      } else await route.continue();
    });
    await secondCard.getByRole('button', { name: '保存', exact: true }).click();
    await enteredSave;
    const newerWhileSaving = `请求期间继续输入的最新评论-${key}`;
    await draftEditor(page, a2.comment).fill(newerWhileSaving);
    await page.evaluate(() => {
      window.__heldFlushSettled = false;
      window.__annotationFlush().then(() => { window.__heldFlushSettled = true; window.__heldFlushResult = { ok: true }; }, error => {
        window.__heldFlushSettled = true; window.__heldFlushResult = { ok: false, message: error.message };
      });
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => window.__heldFlushSettled), false, 'Desktop flush waits for accepted annotation requests');
    release();
    await expect(secondCard.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    await expect(draftEditor(page, a2.comment)).toHaveValue(newerWhileSaving);
    await expect.poll(() => page.evaluate(() => window.__heldFlushSettled)).toBe(true);
    const afterHeldFlush = await page.evaluate(() => window.__heldFlushResult);
    assert.equal(afterHeldFlush.ok, false); assert.match(afterHeldFlush.message, /批注|草稿|保存/);
    assert.equal((await json(`/documents/${a.id}`)).annotations.find(item => item.id === a2.id).comment, secondDraft);
    assert.ok(Object.values(await drafts(page)).some(value => value.includes(newerWhileSaving)));
    await secondCard.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(async () => (await json(`/documents/${a.id}`)).annotations.find(item => item.id === a2.id).comment).toBe(newerWhileSaving);
    await page.unroute(secondEndpoint);
    await expect(draftEditor(page, a2.comment)).toHaveCount(0);

    // A newly mounted card has no local busy flag for the old card's request.
    // Returning to the original saved text is still a newer editing intent.
    const baseComment = newerWhileSaving;
    const submitted = `旧卡片正在保存但尚未确认的评论-${key}`;
    await secondCard.getByRole('button', { name: '编辑批注', exact: true }).click();
    await draftEditor(page, a2.comment).fill(submitted);
    let enteredRemount, releaseRemount;
    const remountEntered = new Promise(resolve => { enteredRemount = resolve; });
    const remountGate = new Promise(resolve => { releaseRemount = resolve; });
    await page.route(secondEndpoint, async route => {
      if (route.request().method() === 'PATCH') {
        const response = await route.fetch(); enteredRemount(); await remountGate;
        await route.fulfill({ response });
      } else await route.continue();
    });
    await secondCard.getByRole('button', { name: '保存', exact: true }).click();
    await remountEntered;
    assert.equal((await json(`/documents/${a.id}`)).annotations.find(item => item.id === a2.id).comment, submitted);
    await page.locator('.panel-tabs button').nth(0).click();
    await showAnnotations(page);
    await expect(secondCard.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    await draftEditor(page, a2.comment).fill(baseComment);
    assert.equal((await activeDraft(page, a.id, `edit-${a2.id}`)).comment, baseComment);
    releaseRemount();
    await expect.poll(async () => (await activeDraft(page, a.id, `edit-${a2.id}`))?.baseComment).toBe(submitted);
    await expect(draftEditor(page, a2.comment)).toHaveValue(baseComment);
    await page.unroute(secondEndpoint);
    await page.reload(); await showAnnotations(page);
    await expect(draftEditor(page, a2.comment)).toHaveValue(baseComment);
    await secondCard.getByRole('button', { name: '保存', exact: true }).click();
    await expect(draftEditor(page, a2.comment)).toHaveCount(0);
    assert.equal((await json(`/documents/${a.id}`)).annotations.find(item => item.id === a2.id).comment, baseComment);

    // A lost PATCH response has an uncertain result. Returning to the old base
    // text must remain a draft, and its stale CAS must require explicit review.
    const committedWithoutReply = `服务端已保存但响应丢失的评论-${key}`;
    await secondCard.getByRole('button', { name: '编辑批注', exact: true }).click();
    await draftEditor(page, a2.comment).fill(committedWithoutReply);
    await page.route(secondEndpoint, async route => {
      if (route.request().method() === 'PATCH') {
        const response = await route.fetch(); assert.equal(response.status(), 200);
        await route.abort('failed');
      } else await route.continue();
    });
    await secondCard.getByRole('button', { name: '保存', exact: true }).click();
    await expect(secondCard.getByRole('alert')).toContainText('保存失败');
    await expect(secondCard.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    assert.equal((await json(`/documents/${a.id}`)).annotations.find(item => item.id === a2.id).comment, committedWithoutReply);
    await draftEditor(page, a2.comment).fill(baseComment);
    assert.equal((await activeDraft(page, a.id, `edit-${a2.id}`)).comment, baseComment);
    assert.equal(await beforeunloadPrevented(page), true);
    await page.unroute(secondEndpoint);
    await secondCard.getByRole('button', { name: '保存', exact: true }).click();
    await expect(secondCard.getByRole('alert')).toContainText('其他窗口');
    await expect(draftEditor(page, a2.comment)).toHaveValue(baseComment);
    assert.equal((await json(`/documents/${a.id}`)).annotations.find(item => item.id === a2.id).comment, committedWithoutReply);
    await secondCard.getByRole('button', { name: '载入最新评论，保留草稿', exact: true }).click();
    await expect(draftEditor(page, a2.comment)).toHaveCount(0);
    await expect(secondCard.locator('.annotation-comment')).toHaveText(committedWithoutReply);
    const uncertainHistory = page.locator('details').filter({ hasText: '其他窗口与历史批注草稿' });
    if (await uncertainHistory.getAttribute('open') === null) await uncertainHistory.locator('summary').click();
    await expect.poll(() => uncertainHistory.locator('textarea').evaluateAll(fields => fields.map(field => field.value))).toContain(baseComment);
    await secondCard.getByRole('button', { name: '编辑批注', exact: true }).click();
    await draftEditor(page, a2.comment).fill(baseComment);
    await secondCard.getByRole('button', { name: '保存', exact: true }).click();
    await expect(draftEditor(page, a2.comment)).toHaveCount(0);
    assert.equal((await json(`/documents/${a.id}`)).annotations.find(item => item.id === a2.id).comment, baseComment);
    console.log('PASS: remounted cards retain return-to-base intent across delayed and lost PATCH replies, refresh and explicit CAS reconciliation');

    await openFromLibrary(page, b); await showAnnotations(page);
    await byComment(page, b1.comment).getByRole('button', { name: '放弃草稿', exact: true }).click();
    await openFromLibrary(page, a); await showAnnotations(page);
    console.log('PASS: failed annotation PATCH retains draft, acknowledgement clears only its own draft, and explicit discard is scoped');

    // The same localStorage is shared, while independent tab session pointers
    // must keep their editors separate and expose others only as read-only.
    const savedCard = byComment(page, retained);
    await savedCard.getByRole('button', { name: '编辑批注', exact: true }).click();
    const windowA = `窗口甲自己的批注草稿-${key}`;
    await draftEditor(page, retained).fill(windowA);
    const secondPage = await context.newPage(); extraPages.push(secondPage);
    await installDesktopProbe(secondPage);
    await secondPage.goto(`${base}/?document=${a.id}&page=1`); await showAnnotations(secondPage);
    await expect(secondPage.getByRole('textbox', { name: '编辑批注内容', exact: true })).toHaveCount(0);
    const history = secondPage.locator('details').filter({ hasText: '其他窗口与历史批注草稿' });
    await expect(history).toBeVisible();
    await history.locator('summary').click();
    await expect.poll(() => history.locator('textarea').evaluateAll(fields => fields.map(field => field.value))).toContain(windowA);
    assert.equal(await history.locator('textarea').evaluateAll(fields => fields.every(field => field.readOnly)), true);
    await byComment(secondPage, retained).getByRole('button', { name: '编辑批注', exact: true }).click();
    await expect(draftEditor(secondPage, retained)).toHaveValue(retained);
    const windowB = `窗口乙自己的批注草稿-${key}`;
    await draftEditor(secondPage, retained).fill(windowB);
    await page.reload(); await showAnnotations(page);
    await secondPage.reload(); await showAnnotations(secondPage);
    await expect(draftEditor(page, retained)).toHaveValue(windowA);
    await expect(draftEditor(secondPage, retained)).toHaveValue(windowB);
    const copies = Object.entries(await drafts(page)).filter(([name]) => name.includes(a1.id));
    assert.ok(copies.some(([, value]) => value.includes(windowA)));
    assert.ok(copies.some(([, value]) => value.includes(windowB)));
    assert.equal((await flushResult(secondPage)).ok, false);
    // A real stale CAS write must preserve window B, and loading the newest
    // saved version archives B for explicit copy/merge rather than saving it.
    await byComment(page, retained).getByRole('button', { name: '保存', exact: true }).click();
    await expect(draftEditor(page, retained)).toHaveCount(0);
    assert.equal((await json(`/documents/${a.id}`)).annotations.find(item => item.id === a1.id).comment, windowA);
    await byComment(secondPage, retained).getByRole('button', { name: '保存', exact: true }).click();
    await expect(byComment(secondPage, retained).getByRole('alert')).toContainText('其他窗口');
    await expect(draftEditor(secondPage, retained)).toHaveValue(windowB);
    assert.equal((await json(`/documents/${a.id}`)).annotations.find(item => item.id === a1.id).comment, windowA);
    await byComment(secondPage, retained).getByRole('button', { name: '载入最新评论，保留草稿', exact: true }).click();
    await expect(draftEditor(secondPage, retained)).toHaveCount(0);
    await expect(byComment(secondPage, retained).locator('.annotation-comment')).toHaveText(windowA);
    const archivedHistory = secondPage.locator('details').filter({ hasText: '其他窗口与历史批注草稿' });
    if (await archivedHistory.getAttribute('open') === null) await archivedHistory.locator('summary').click();
    await expect.poll(() => archivedHistory.locator('textarea').evaluateAll(fields => fields.map(field => field.value))).toContain(windowB);
    assert.equal(await archivedHistory.locator('textarea').evaluateAll(fields => fields.every(field => field.readOnly)), true);
    await byComment(secondPage, retained).getByRole('button', { name: '编辑批注', exact: true }).click();
    const merged = `${windowA}\n\n手动核对后合并：${windowB}`;
    await draftEditor(secondPage, retained).fill(merged);
    await byComment(secondPage, retained).getByRole('button', { name: '保存', exact: true }).click();
    await expect(draftEditor(secondPage, retained)).toHaveCount(0);
    assert.equal((await json(`/documents/${a.id}`)).annotations.find(item => item.id === a1.id).comment, merged);
    await secondPage.close();
    console.log('PASS: independent annotation slots, real CAS conflict, read-only archival and explicit manual merge prevent cross-window overwrite');

    // Region recovery preserves coordinates and comment, never a persisted PNG.
    await openFromLibrary(page, b);
    // Keep the explicit link on the document whose draft will be reloaded;
    // refreshing an old ?document=a link intentionally opens that old target.
    await page.evaluate(id => history.replaceState(null, '', `/?document=${id}&page=1`), b.id);
    let dialog = await openRegionModal(page);
    const regionDraft = `刷新可恢复但不存图片的区域评论-${key}`;
    await dialog.getByRole('textbox', { name: '批注评论', exact: true }).fill(regionDraft);
    const storedRegions = Object.values(await drafts(page)).filter(value => value.includes(regionDraft));
    assert.equal(storedRegions.length, 1);
    assert.equal(storedRegions[0].includes('data:image'), false);
    const storedRegion = JSON.parse(storedRegions[0]);
    assert.ok(storedRegions[0].includes('rects'), 'Normalized page geometry must be recoverable');
    await page.reload(); await showAnnotations(page);
    await expect(page.getByRole('dialog', { name: /区域批注/ })).toHaveCount(0);
    await page.getByRole('button', { name: '恢复第 1 页批注草稿', exact: true }).click();
    dialog = page.getByRole('dialog', { name: /区域批注/ });
    await expect(dialog.getByRole('textbox', { name: '批注评论', exact: true })).toHaveValue(regionDraft);
    await expect(dialog.locator('img')).toHaveCount(0);
    await expect(dialog).toContainText(/预览|图片/);
    assert.equal(await beforeunloadPrevented(page), true);
    assert.equal((await flushResult(page)).ok, false);

    // The first POST succeeds at the server but loses its response. A manual
    // retry must reuse the frozen requestId/payload and create only one record.
    const postEndpoint = `${base}/api/documents/${b.id}/annotations`;
    const payloads = [];
    let responseLost = false;
    await page.route(postEndpoint, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      payloads.push(route.request().postDataJSON());
      if (!responseLost) {
        responseLost = true;
        const upstream = await route.fetch();
        assert.equal(upstream.status(), 201);
        await route.abort('failed');
      } else await route.continue();
    });
    const beforePost = (await json(`/documents/${b.id}`)).annotations.length;
    await dialog.getByRole('button', { name: '保存批注', exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: '批注评论', exact: true })).toHaveValue(regionDraft);
    await expect(dialog).toContainText(/结果尚未确认|重试/);
    await expect(dialog.getByRole('textbox', { name: '批注评论', exact: true })).toBeDisabled();
    assert.equal((await json(`/documents/${b.id}`)).annotations.length, beforePost + 1);
    assert.ok(Object.values(await drafts(page)).some(value => value.includes(regionDraft)));
    await dialog.getByRole('button', { name: '保存批注', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    assert.equal(payloads.length, 2);
    assert.match(payloads[0].requestId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(payloads[1], payloads[0], 'Uncertain POST retries reuse the original complete payload');
    const finalAnnotations = (await json(`/documents/${b.id}`)).annotations;
    assert.equal(finalAnnotations.length, beforePost + 1);
    const created = finalAnnotations.find(item => item.comment === regionDraft);
    assert.equal(created.page, 1); assert.equal(created.kind, 'region');
    assert.equal(created.rects.length, 1);
    for (const [property, value] of Object.entries(payloads[0].rects[0])) assert.equal(created.rects[0][property], value);
    assert.equal(Object.hasOwn(payloads[0], 'preview'), false);
    assert.equal(await slotPointer(page, b.id, storedRegion.target), 'saved');
    await page.unroute(postEndpoint);
    assert.equal(await beforeunloadPrevented(page), false);
    assert.equal((await flushResult(page)).ok, true);
    // Simulate a recovery record beyond the server's idempotency retention.
    // It must be reviewable but never turn into an automatic duplicate POST.
    dialog = await openRegionModal(page);
    const expiredComment = `超过安全重试时限的合成草稿-${key}`;
    await dialog.getByRole('textbox', { name: '批注评论', exact: true }).fill(expiredComment);
    await page.evaluate(comment => {
      const storageKey = Object.keys(localStorage).find(name => name.startsWith('paperdesk-annotation-draft-') && JSON.parse(localStorage.getItem(name)).comment === comment);
      const entry = JSON.parse(localStorage.getItem(storageKey));
      const { documentId, ...selection } = entry.selection;
      entry.attempt = { firstAttemptAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(), body: { ...selection, comment: entry.comment, color: entry.color, requestId: entry.requestId } };
      localStorage.setItem(storageKey, JSON.stringify(entry));
    }, expiredComment);
    await page.reload(); await showAnnotations(page);
    await page.getByRole('button', { name: '恢复第 1 页批注草稿', exact: true }).click();
    dialog = page.getByRole('dialog', { name: /区域批注/ });
    await expect(dialog.getByRole('textbox', { name: '批注评论', exact: true })).toHaveValue(expiredComment);
    let expiredPosts = 0;
    const observeExpired = request => { if (request.method() === 'POST' && request.url() === postEndpoint) expiredPosts++; };
    page.on('request', observeExpired);
    await dialog.getByRole('button', { name: '保存批注', exact: true }).click();
    await expect(page.locator('.toast[role="alert"]')).toContainText('超出安全重试时限');
    assert.equal(expiredPosts, 0);
    await expect(dialog.getByRole('textbox', { name: '批注评论', exact: true })).toHaveValue(expiredComment);
    assert.equal(await beforeunloadPrevented(page), true);
    await dialog.getByRole('button', { name: '放弃草稿', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    page.off('request', observeExpired);
    assert.equal(await beforeunloadPrevented(page), false);
    assert.equal((await flushResult(page)).ok, true);
    assert.deepEqual(pageErrors, []);
    console.log('PASS: region restoration without PNG, same-payload POST retry, expired-retry rejection and clean unload/desktop release');
  } finally {
    for (const extra of extraPages) if (!extra.isClosed()) await extra.close();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    if (!suppliedPage && !page.isClosed()) await page.close();
  }
}
