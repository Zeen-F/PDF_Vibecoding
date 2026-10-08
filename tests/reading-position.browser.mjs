import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect } from '@playwright/test';
import { bookmarkedPdf } from './fixtures/toc-browser.mjs';

// Original PDFs and a temporary server supplied by the browser runner only.
export async function readingPositionWorkflow({ context, base, dataDir }) {
  assert.ok(dataDir, 'Reading-position fault injection requires the runner-owned temporary data directory');
  let db;
  const upload = async label => {
    const body = new FormData();
    body.append('file', new Blob([bookmarkedPdf(), `\n% reading-position-${randomUUID()}\n`], { type: 'application/pdf' }), `${label}.pdf`);
    const response = await fetch(`${base}/api/documents`, { method: 'POST', body });
    assert.equal(response.status, 201);
    return (await response.json()).document;
  };
  const a = await upload('位置队列甲'), b = await upload('位置队列乙');
  const endpoint = id => `${base}/api/documents/${id}`;
  const read = async id => (await (await fetch(endpoint(id))).json()).document;
  const page = await context.newPage(), failures = [];
  page.on('pageerror', error => failures.push(error.message));
  const current = number => page.getByLabel(`PDF 第 ${number} 页`, { exact: true });
  let release;
  try {
    await page.goto(`${base}/?document=${a.id}&page=1`);
    await expect(current(1)).toBeVisible();
    await page.getByRole('combobox', { name: '翻页方式', exact: true }).selectOption('paged');
    await page.getByRole('combobox', { name: '页面布局', exact: true }).selectOption('1');
    const expandLibrary = page.getByRole('button', { name: '展开文献栏', exact: true });
    if (await expandLibrary.count()) await expandLibrary.click();
    let entered;
    const held = new Promise(resolve => { entered = resolve; });
    const unblock = new Promise(resolve => { release = resolve; });
    const order = []; let delayedBody;
    await page.route(endpoint(a.id), async route => {
      const request = route.request();
      if (request.method() !== 'PATCH' || !Object.hasOwn(request.postDataJSON(), 'lastPage')) return route.continue();
      const number = request.postDataJSON().lastPage;
      order.push(number);
      if (number === 2) { delayedBody = request.postDataJSON(); entered(); await unblock; }
      await route.continue();
    });
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await held;
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(current(3)).toBeVisible();
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(current(4)).toBeVisible();
    assert.deepEqual(order, [2], 'New pages must wait for the older write, even while its request has not reached SQLite');
    release();
    await expect.poll(async () => (await read(a.id)).lastPage).toBe(4);
    assert.deepEqual(order, [2, 4], 'Intermediate queued pages must merge into the most recent page');
    await page.unroute(endpoint(a.id));
    await page.goto(`${base}/?document=${a.id}`);
    await expect(current(4)).toBeVisible();
    const stale = await fetch(endpoint(a.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(delayedBody) });
    assert.equal(stale.status, 200); assert.equal((await stale.json()).positionStale, true);
    assert.equal((await read(a.id)).lastPage, 4);
    console.log('PASS: delayed old reading-position request, merged newest page, persisted reopen and late-token rejection');

    // Switching must wait for the previous document, then use B's own page.
    let enteredSwitch;
    const heldSwitch = new Promise(resolve => { enteredSwitch = resolve; });
    const unblockSwitch = new Promise(resolve => { release = resolve; });
    await page.route(endpoint(a.id), async route => {
      if (route.request().method() === 'PATCH' && route.request().postDataJSON().lastPage === 5) { enteredSwitch(); await unblockSwitch; }
      await route.continue();
    });
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await heldSwitch;
    await page.locator(`[data-document-id="${b.id}"] .document-item`).click();
    await expect(page.locator('.opening-mask')).toBeVisible();
    await expect(page.locator('.header-title h1')).toHaveText(a.title);
    release();
    await expect(page.locator('.header-title h1')).toHaveText(b.title);
    await expect(current(1)).toBeVisible();
    assert.equal((await read(a.id)).lastPage, 5);
    assert.equal((await read(b.id)).lastPage, 1);
    await page.unroute(endpoint(a.id));
    await page.locator(`[data-document-id="${a.id}"] .document-item`).click();
    await expect(current(5)).toBeVisible();
    console.log('PASS: document switch waits for the final position and does not mix document pages');

    // Failed writes survive a reload in this tab; a separate tab does not borrow
    // the draft. An online event retries the retained position after recovery.
    // Real SQLite failure, including a departing keepalive and the next load's
    // retry. A page.route mock can be bypassed during a navigation's teardown.
    db = new DatabaseSync(join(dataDir, 'paperdesk.sqlite'));
    db.exec(`CREATE TRIGGER reading_position_browser_failure BEFORE UPDATE OF last_page ON documents
      WHEN NEW.id = '${a.id}' AND NEW.last_page <> OLD.last_page
      BEGIN SELECT RAISE(ABORT, 'synthetic browser position failure'); END;`);
    await page.getByRole('button', { name: '上一页', exact: true }).click();
    await expect(current(4)).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('阅读位置未保存');
    assert.equal((await read(a.id)).lastPage, 5);
    const other = await context.newPage();
    try {
      await other.goto(`${base}/?document=${a.id}`);
      await expect(other.getByLabel('PDF 第 5 页', { exact: true })).toBeVisible();
    } finally { await other.close(); }
    page.on('dialog', dialog => dialog.accept());
    await page.goto(base);
    await expect(current(4)).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('阅读位置未保存');
    assert.equal((await read(a.id)).lastPage, 5);
    db.exec('DROP TRIGGER reading_position_browser_failure;');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(async () => (await read(a.id)).lastPage).toBe(4);
    await page.reload();
    await expect(current(4)).toBeVisible();
    console.log('PASS: failed reading position retained across reload, independent tab, explicit connection recovery');

    // This invokes the same renderer callback as Electron's IPC bridge, using a
    // controlled bridge only. It does not claim a real Electron window test.
    const desktopPage = await context.newPage();
    try {
      await desktopPage.addInitScript(() => {
        window.paperdeskDesktop = { onLibrarySwitch: () => () => {}, onFlushRequest: handler => { window.positionFlushHandler = handler; return () => {}; } };
      });
      await desktopPage.goto(`${base}/?document=${a.id}`);
      await expect(desktopPage.getByLabel('PDF 第 4 页', { exact: true })).toBeVisible();
      let enteredFlush;
      const heldFlush = new Promise(resolve => { enteredFlush = resolve; });
      const unblockFlush = new Promise(resolve => { release = resolve; });
      await desktopPage.route(endpoint(a.id), async route => {
        if (route.request().method() === 'PATCH' && route.request().postDataJSON().lastPage === 5) { enteredFlush(); await unblockFlush; }
        await route.continue();
      });
      await desktopPage.getByRole('button', { name: '下一页', exact: true }).click(); await heldFlush;
      await desktopPage.getByRole('button', { name: '下一页', exact: true }).click();
      await expect(desktopPage.getByLabel('PDF 第 6 页', { exact: true })).toBeVisible();
      const flushed = desktopPage.evaluate(async () => { window.positionFlushState = 'pending'; await window.positionFlushHandler(); window.positionFlushState = 'done'; });
      await expect.poll(() => desktopPage.evaluate(() => window.positionFlushState)).toBe('pending');
      assert.equal((await read(a.id)).lastPage, 4);
      release(); await flushed;
      assert.equal((await read(a.id)).lastPage, 6);
      console.log('PASS: simulated desktop flush callback waits for the most recent reading position');
    } finally { release?.(); await desktopPage.close(); }
    assert.deepEqual(failures, []);
  } finally { release?.(); db?.exec('DROP TRIGGER IF EXISTS reading_position_browser_failure;'); db?.close(); await page.close(); }
}
