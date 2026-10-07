import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { bookmarkedPdf } from './fixtures/toc-browser.mjs';
import { graphicsOnlyPdf } from './fixtures/scan-browser.mjs';

// The caller owns an isolated app/database and browser context. No personal
// library, external service, or preinstalled Codex host is used by this test.
export async function pluginWorkflow({ context, base }) {
  const pages = [], errors = [];
  const open = async url => {
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => errors.push(error.message));
    let sessionId;
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().includes('/api/reader-sessions/')) sessionId = request.url().split('/').at(-1);
    });
    await page.goto(url);
    await expect.poll(() => sessionId).toMatch(/^[0-9a-f-]{36}$/);
    return { page, sessionId: () => sessionId };
  };
  const upload = async (name, bytes) => {
    const body = new FormData();
    body.append('file', new Blob([bytes, Buffer.from('\n% Original plugin browser fixture\n')], { type: 'application/pdf' }), name);
    const response = await fetch(`${base}/api/documents`, { method: 'POST', body });
    assert.equal(response.status, 201);
    return (await response.json()).document;
  };
  const json = async (path, body, method = 'POST') => {
    const response = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, ...(await response.json()) };
  };
  const getDoc = async id => (await (await fetch(`${base}/api/documents/${id}`)).json()).document;
  const getContext = async id => (await (await fetch(`${base}/api/reader-context?sessionId=${id}`)).json());
  try {
    const book = await upload('original-codex-text.pdf', bookmarkedPdf());
    const scan = await upload('original-codex-region.pdf', graphicsOnlyPdf());
    const reader = await open(`${base}/?document=${book.id}&page=2`), page = reader.page;
    await expect(page.getByLabel('PDF 第 2 页', { exact: true })).toBeVisible();
    await expect.poll(async () => (await getContext(reader.sessionId())).page).toBe(2);
    assert.equal((await getContext(reader.sessionId())).selection, null);
    const span = page.locator('.textLayer span').filter({ hasText: /^A short introduction for navigation checks\.$/ });
    await expect(span).toBeVisible();
    const box = await span.boundingBox();
    await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 }); await page.mouse.up();
    await expect(page.getByRole('button', { name: '交给 Codex', exact: true })).toBeVisible();
    const nativeQuote = await page.evaluate(() => window.getSelection()?.toString());
    await expect(page.locator('.selection-summary p')).toHaveText(nativeQuote);
    const quote = await page.locator('.selection-summary p').textContent();
    assert.ok(quote.includes('short introduction'));
    assert.equal((await getContext(reader.sessionId())).selection, null, 'Selecting text alone must remain private');
    await page.getByRole('button', { name: '交给 Codex', exact: true }).click();
    await page.keyboard.press('Shift');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect.poll(async () => (await getContext(reader.sessionId())).selection?.text).toBe(quote);
    assert.equal((await getContext(reader.sessionId())).selection.kind, 'text');
    await expect(page.locator('.codex-status')).toHaveAttribute('data-shared', 'true');
    // Headless targets may remain visible together; drive the real lifecycle
    // listener with a controlled visibility value, then restore the native getter.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.locator('.codex-status')).toHaveAttribute('data-shared', 'false');
    await page.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
    await expect.poll(async () => (await getContext(reader.sessionId())).selection).toBeNull();
    await page.getByRole('button', { name: '交给 Codex', exact: true }).click();
    await expect.poll(async () => (await getContext(reader.sessionId())).selection?.text).toBe(quote);
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expect.poll(async () => (await getContext(reader.sessionId())).selection).toBeNull();
    await expect.poll(async () => (await getContext(reader.sessionId())).page).toBe(3);

    const second = await open(`${base}/?document=${scan.id}&page=1`);
    assert.notEqual(second.sessionId(), reader.sessionId(), 'Each browser tab needs its own UUID');
    await expect.poll(async () => (await fetch(`${base}/api/reader-context`)).status).toBe(409);
    assert.equal((await getContext(second.sessionId())).documentId, scan.id);
    await second.page.getByRole('button', { name: '区域批注', exact: true }).click();
    const paper = await second.page.locator('.pdf-paper').boundingBox();
    await second.page.mouse.move(paper.x + paper.width * .15, paper.y + paper.height * .18); await second.page.mouse.down();
    await second.page.mouse.move(paper.x + paper.width * .48, paper.y + paper.height * .36, { steps: 8 }); await second.page.mouse.up();
    await expect(second.page.getByRole('button', { name: '交给 Codex', exact: true })).toBeVisible();
    assert.equal((await getContext(second.sessionId())).selection, null, 'Region preview must not be sent automatically');
    await second.page.getByRole('button', { name: '交给 Codex', exact: true }).click();
    await expect.poll(async () => (await getContext(second.sessionId())).selection?.kind).toBe('region');
    const region = (await getContext(second.sessionId())).selection;
    assert.equal(region.text, ''); assert.equal(region.rects.length, 1);
    assert.match(region.preview, /^data:image\/png;base64,/);
    const png = Buffer.from(region.preview.split(',')[1], 'base64');
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(png.readUInt32BE(16) > 8 && png.readUInt32BE(20) > 8);
    await second.page.getByRole('button', { name: '取消选择', exact: true }).click();
    await expect.poll(async () => (await getContext(second.sessionId())).selection).toBeNull();
    await second.page.close();
    await expect.poll(async () => (await fetch(`${base}/api/reader-context?sessionId=${second.sessionId()}`)).status).toBe(404);
    console.log('PASS: explicit text/PNG sharing, private selection default, page/selection cleanup and multiple-tab disambiguation');

    const editor = page.getByRole('textbox', { name: '笔记', exact: true });
    await expect(editor).toHaveValue('');
    let stored = await getDoc(book.id);
    const addition = await json(`/documents/${book.id}/notes/append`, { text: '来自 Codex 的已核对补充。', page: 3, requestId: randomUUID(), expectedNotesRevision: stored.notesRevision });
    assert.equal(addition.status, 200);
    await expect(editor).toHaveValue('### 第 3 页\n\n来自 Codex 的已核对补充。', { timeout: 10000 });

    // Hold the response after the first save reached the server. Returning to A
    // while B is in flight must enqueue A against B's acknowledged revision.
    const endpoint = `${base}/api/documents/${book.id}`;
    const original = await editor.inputValue();
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const intercepted = new Promise(resolve => { entered = resolve; });
    let held = false;
    await page.route(endpoint, async route => {
      const body = route.request().method() === 'PATCH' ? route.request().postDataJSON() : null;
      if (body?.notesZh === 'Temporary B' && !held) { held = true; const response = await route.fetch(); entered(); await gate; await route.fulfill({ response }); }
      else await route.continue();
    });
    await editor.fill('Temporary B'); await page.getByRole('button', { name: '保存', exact: true }).click(); await intercepted;
    await editor.fill(original); await page.getByRole('button', { name: '保存', exact: true }).click(); release();
    await expect(page.locator('.save-row [role="status"]')).toHaveText('已保存到本机');
    assert.equal((await getDoc(book.id)).notesZh, original);
    await page.unroute(endpoint);

    // Hold a pending local edit, then simulate a second editor winning CAS.
    // Both a rejected write and a heartbeat must preserve this local draft.
    let releaseConflict, enteredConflict;
    const conflictGate = new Promise(resolve => { releaseConflict = resolve; });
    const conflictingRequest = new Promise(resolve => { enteredConflict = resolve; });
    const draft = '这份本机草稿必须保留，不能被外部追加覆盖。';
    await page.route(endpoint, async route => {
      const body = route.request().method() === 'PATCH' ? route.request().postDataJSON() : null;
      if (body?.notesZh === draft) { enteredConflict(); await conflictGate; }
      await route.continue();
    });
    await editor.fill(draft); await page.getByRole('button', { name: '保存', exact: true }).click(); await conflictingRequest;
    await expect.poll(async () => (await getContext(reader.sessionId())).notesDirty).toBe(true);
    stored = await getDoc(book.id);
    const blocked = await json(`/documents/${book.id}/notes/append`, { text: '不得写入', requestId: randomUUID(), expectedNotesRevision: stored.notesRevision });
    assert.equal(blocked.status, 409);
    const external = '另一编辑窗口已经保存的新版本。';
    assert.equal((await json(`/documents/${book.id}`, { notesZh: external, notesEn: '', expectedNotesRevision: stored.notesRevision }, 'PATCH')).status, 200);
    releaseConflict();
    await expect(page.locator('.notes-conflict')).toBeVisible();
    await expect(editor).toHaveValue(draft);
    assert.equal((await getDoc(book.id)).notesZh, external);
    await page.unroute(endpoint);
    await page.getByRole('button', { name: '保留草稿并载入已保存笔记', exact: true }).click();
    await expect(editor).toHaveValue(external);
    await page.locator('.preserved-drafts summary').click();
    await expect(page.getByRole('textbox', { name: '保留的笔记草稿 1', exact: true })).toHaveValue(draft);
    await expect.poll(async () => (await getContext(reader.sessionId())).notesDirty).toBe(false);
    await page.reload();
    await expect(editor).toHaveValue(external);
    await page.locator('.preserved-drafts summary').click();
    await expect(page.getByRole('textbox', { name: '保留的笔记草稿 1', exact: true })).toHaveValue(draft);
    console.log('PASS: external append refresh, revision-conditional B→A saves, dirty append rejection, conflict preservation and durable draft recovery');

    const sibling = await open(`${base}/?document=${book.id}&page=2`);
    const siblingEditor = sibling.page.getByRole('textbox', { name: '笔记', exact: true });
    const rejectNotes = async route => {
      const body = route.request().method() === 'PATCH' ? route.request().postDataJSON() : null;
      if (body && Object.hasOwn(body, 'notesZh')) await route.abort('failed'); else await route.continue();
    };
    await page.route(endpoint, rejectNotes); await sibling.page.route(endpoint, rejectNotes);
    page.on('dialog', dialog => dialog.accept());
    await editor.fill('窗口甲独立草稿'); await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.save-row [role="status"]')).toHaveText('保存失败，草稿已保留');
    await siblingEditor.fill('窗口乙独立草稿'); await sibling.page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(sibling.page.locator('.save-row [role="status"]')).toHaveText('保存失败，草稿已保留');
    await page.reload(); await expect(editor).toHaveValue('窗口甲独立草稿');
    await expect(siblingEditor).toHaveValue('窗口乙独立草稿');
    await sibling.page.unroute(endpoint); await sibling.page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(sibling.page.locator('.save-row [role="status"]')).toHaveText('已保存到本机');
    await page.reload(); await expect(editor).toHaveValue('窗口甲独立草稿');
    await expect(page.locator('.notes-conflict')).toBeVisible();
    await page.unroute(endpoint);
    await page.getByRole('button', { name: '保留草稿并载入已保存笔记', exact: true }).click();
    await expect(editor).toHaveValue('窗口乙独立草稿');
    await sibling.page.close();

    // A late recovery GET must not replace a newer heartbeat document and then
    // leave the editor permanently stale (its prop revision already changed).
    await page.route(endpoint, rejectNotes);
    await editor.fill('恢复竞态中的原草稿'); await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.save-row [role="status"]')).toHaveText('保存失败，草稿已保留');
    stored = await getDoc(book.id);
    await json(`/documents/${book.id}`, { notesZh: '恢复请求的旧服务版本', notesEn: '', expectedNotesRevision: stored.notesRevision }, 'PATCH');
    await expect(page.locator('.notes-conflict')).toBeVisible();
    await page.unroute(endpoint);
    let releaseRecovery, enteredRecovery, heldRecovery = false;
    const recoveryGate = new Promise(resolve => { releaseRecovery = resolve; });
    const recoveryEntered = new Promise(resolve => { enteredRecovery = resolve; });
    await page.route(endpoint, async route => {
      if (route.request().method() === 'GET' && !heldRecovery) { heldRecovery = true; const response = await route.fetch(); enteredRecovery(); await recoveryGate; await route.fulfill({ response }); }
      else await route.continue();
    });
    await page.getByRole('button', { name: '保留草稿并载入已保存笔记', exact: true }).click(); await recoveryEntered;
    stored = await getDoc(book.id);
    const newest = await json(`/documents/${book.id}`, { notesZh: '恢复期间收到的最新服务版本', notesEn: '', expectedNotesRevision: stored.notesRevision }, 'PATCH');
    await page.waitForResponse(async response => response.request().method() === 'POST' && response.url().includes('/api/reader-sessions/') && (await response.json()).document?.notesRevision === newest.document.notesRevision);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    releaseRecovery();
    await expect(editor).toHaveValue('恢复期间收到的最新服务版本');
    await expect(page.locator('.save-row [role="status"]')).toHaveText('已保存到本机');
    await page.unroute(endpoint);
    console.log('PASS: independent tab draft slots survive failed saves/reload, and late recovery cannot roll back a newer heartbeat');

    const orphan = await open(`${base}/?document=${book.id}&page=2`);
    const orphanText = '关闭窗口后仍应能找到的独立草稿。';
    await orphan.page.route(endpoint, rejectNotes);
    await orphan.page.getByRole('textbox', { name: '笔记', exact: true }).fill(orphanText);
    await orphan.page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(orphan.page.locator('.save-row [role="status"]')).toHaveText('保存失败，草稿已保留');
    // Another live tab can inspect this draft without adopting it or changing
    // the active writer. Losing sessionStorage does not remove that entrance.
    await page.locator('.historical-drafts summary').click();
    await expect.poll(() => page.locator('.historical-drafts textarea').evaluateAll(fields => fields.map(field => field.value))).toContain(orphanText);
    await expect(orphan.page.getByRole('textbox', { name: '笔记', exact: true })).toHaveValue(orphanText);
    const beforeOrphan = await orphan.page.evaluate(id => Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith(`paperdesk-draft-${id}-`)).map(key => [key, localStorage.getItem(key)])), book.id);
    await orphan.page.evaluate(id => localStorage.setItem(`paperdesk-preserved-drafts-${id}`, JSON.stringify([{ text: '旧数组格式保留的草稿', savedAt: '2000-01-01T00:00:00.000Z' }])), book.id);
    await orphan.page.evaluate(() => sessionStorage.clear()); await orphan.page.close();
    const fresh = await open(`${base}/?document=${book.id}&page=2`);
    const noteWrites = [];
    fresh.page.on('request', request => { if (request.url() === endpoint && request.method() === 'PATCH' && Object.hasOwn(request.postDataJSON(), 'notesZh')) noteWrites.push(request.postDataJSON()); });
    await expect(fresh.page.getByRole('textbox', { name: '笔记', exact: true })).toHaveValue('恢复期间收到的最新服务版本');
    await expect.poll(() => fresh.page.locator('.preserved-drafts textarea').evaluateAll(fields => fields.map(field => field.value))).toContain('旧数组格式保留的草稿');
    await fresh.page.locator('.historical-drafts summary').click();
    await expect.poll(() => fresh.page.locator('.historical-drafts textarea').evaluateAll(fields => fields.map(field => field.value))).toContain(orphanText);
    assert.equal(await fresh.page.locator('.historical-drafts textarea').evaluateAll(fields => fields.every(field => field.readOnly)), true);
    const initialFreshUpdate = (await getContext(fresh.sessionId())).updatedAt;
    await expect.poll(async () => (await getContext(fresh.sessionId())).updatedAt).not.toBe(initialFreshUpdate);
    assert.deepEqual(noteWrites, [], 'Viewing an orphaned or active draft must not write it back');
    assert.deepEqual(await fresh.page.evaluate(id => Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith(`paperdesk-draft-${id}-`)).map(key => [key, localStorage.getItem(key)])), book.id), beforeOrphan);

    // Preserve concurrently from two conflicting editors. Both operations use
    // independent UUID keys and both views learn about the other archive.
    await page.route(endpoint, rejectNotes); await fresh.page.route(endpoint, rejectNotes);
    const archiveA = '同时归档的甲草稿', archiveB = '同时归档的乙草稿';
    await editor.fill(archiveA); await page.getByRole('button', { name: '保存', exact: true }).click();
    await fresh.page.getByRole('textbox', { name: '笔记', exact: true }).fill(archiveB);
    await fresh.page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.save-row [role="status"]')).toHaveText('保存失败，草稿已保留');
    await expect(fresh.page.locator('.save-row [role="status"]')).toHaveText('保存失败，草稿已保留');
    stored = await getDoc(book.id);
    await json(`/documents/${book.id}`, { notesZh: '并发归档时的已保存笔记', notesEn: '', expectedNotesRevision: stored.notesRevision }, 'PATCH');
    await expect(page.locator('.notes-conflict')).toBeVisible(); await expect(fresh.page.locator('.notes-conflict')).toBeVisible();
    await Promise.all([
      page.getByRole('button', { name: '保留草稿并载入已保存笔记', exact: true }).click(),
      fresh.page.getByRole('button', { name: '保留草稿并载入已保存笔记', exact: true }).click(),
    ]);
    await expect(editor).toHaveValue('并发归档时的已保存笔记');
    await expect(fresh.page.getByRole('textbox', { name: '笔记', exact: true })).toHaveValue('并发归档时的已保存笔记');
    for (const readerPage of [page, fresh.page]) {
      await expect.poll(() => readerPage.locator('.preserved-drafts textarea').evaluateAll(fields => fields.map(field => field.value))).toEqual(expect.arrayContaining([archiveA, archiveB]));
    }
    const archives = await page.evaluate(id => Object.keys(localStorage).filter(key => key.startsWith(`paperdesk-preserved-draft-${id}-`)).map(key => ({ key, ...JSON.parse(localStorage.getItem(key)) })), book.id);
    assert.equal(archives.filter(entry => [archiveA, archiveB].includes(entry.text)).length, 2);
    assert.notEqual(archives.find(entry => entry.text === archiveA).key, archives.find(entry => entry.text === archiveB).key);
    await page.unroute(endpoint); await fresh.page.close();
    console.log('PASS: read-only orphan/live draft recovery without sessionStorage and concurrent independent archive entries');

    await page.goto(`${base}/?document=${book.id}&page=1e2`);
    await expect(page.getByLabel('PDF 第 1 页', { exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('页码格式无效');
    await page.goto(`${base}/?document=${book.id}&page=9999`);
    await expect(page.getByLabel('PDF 第 1 页', { exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('页码无效');
    await page.close();

    // A wrapper supplies an exact parent origin and per-iframe UUID. A missing
    // or mismatching referrer must never fall back to postMessage('*').
    const embeddedId = randomUUID(), parentPath = `${base}/__plugin_test_parent`;
    const parent = await context.newPage(); pages.push(parent);
    await parent.route(parentPath, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><script>window.messages=[];addEventListener('message',e=>window.messages.push({origin:e.origin,data:e.data}));</script><iframe style="width:1200px;height:900px" referrerpolicy="origin" src="/?document=${book.id}&page=2&embedded=1&readerSession=${embeddedId}&parentOrigin=${encodeURIComponent(base)}"></iframe>` }));
    await parent.goto(parentPath);
    await expect.poll(async () => (await getContext(embeddedId)).page).toBe(2);
    await expect.poll(() => parent.evaluate(() => window.messages.filter(message => message.data?.type === 'paperdesk-context').length)).toBeGreaterThan(0);
    const message = await parent.evaluate(() => window.messages.find(message => message.data?.type === 'paperdesk-context'));
    assert.equal(message.origin, base); assert.equal(message.data.context.sessionId, embeddedId);
    assert.equal(message.data.context.sharedSelection, false); assert.equal(message.data.context.shareId, null);
    await parent.evaluate(() => window.frames[0].postMessage({ type: 'paperdesk-context', documentId: 'wrong', page: 6 }, location.origin));
    assert.equal((await getContext(embeddedId)).page, 2, 'Parent messages do not control reader navigation');
    await parent.close();
    const mismatchId = randomUUID(), rejected = await context.newPage(); pages.push(rejected);
    await rejected.route(parentPath, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><script>window.messages=[];addEventListener('message',e=>window.messages.push(e.data));</script><iframe style="width:1200px;height:900px" referrerpolicy="origin" src="/?document=${book.id}&page=2&embedded=1&readerSession=${mismatchId}&parentOrigin=https%3A%2F%2Fexample.invalid"></iframe>` }));
    await rejected.goto(parentPath);
    await expect.poll(async () => (await getContext(mismatchId)).page).toBe(2);
    // Observe at least one subsequent heartbeat, not a timing-only sleep.
    const initialUpdate = (await getContext(mismatchId)).updatedAt;
    await expect.poll(async () => (await getContext(mismatchId)).updatedAt).not.toBe(initialUpdate);
    assert.deepEqual(await rejected.evaluate(() => window.messages.filter(message => message?.type === 'paperdesk-context')), []);
    assert.deepEqual(errors, []);
    console.log('PASS: strict document/page deep links and exact-origin embedded session notifications');
  } finally {
    await Promise.allSettled(pages.map(page => page.close()));
  }
}
