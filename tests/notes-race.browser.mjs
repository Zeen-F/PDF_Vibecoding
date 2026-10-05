// Run against an already imported demo in an isolated app instance.
// This intentionally edits the active document's Chinese note; do not use personal data.
// QA_SPACE=9 QA_PAGE=p2 ego-browser nodejs < tests/notes-race.browser.mjs
// This script uses the documented Ego Lite runtime, and must not run via node --test.
const assert = (await import('node:assert/strict')).default;
const fs = await import('node:fs/promises');
if (!process.env.QA_SPACE || !process.env.QA_PAGE) throw new Error('Set QA_SPACE and QA_PAGE to an isolated test page before running.');
const task = await taskSpace(Number(process.env.QA_SPACE));
const page = task.page(process.env.QA_PAGE);
await page.reload();
await page.waitForSelector('textarea[aria-label="中文笔记"]', { state: 'visible', timeout: 15000 });

const valueA = '## Saved version A\n\nReturn to A after a slow save. 回到版本 A。';
const valueB = '## In-flight version B\n\nThis older intermediate value must not overwrite A.';
await page.fill('textarea[aria-label="中文笔记"]', valueA);
await page.waitForFunction(() => document.querySelector('[aria-label="笔记与批注"] [role="status"]')?.innerText.includes('已保存'), undefined, { timeout: 10000 });
await page.evaluate(({ valueB }) => {
  window.__qaOriginalFetch = window.fetch;
  window.__qaHeld = false;
  window.__qaRequests = [];
  window.fetch = async (...args) => {
    const options = args[1] || {};
    if (options.method === 'PATCH' && typeof options.body === 'string') {
      const data = JSON.parse(options.body);
      if (Object.hasOwn(data, 'notesZh')) {
        window.__qaRequests.push(data.notesZh);
        const url = args[0] instanceof Request ? args[0].url : String(args[0]);
        window.__qaDocumentId = new URL(url, location.href).pathname.match(/\/api\/documents\/([^/]+)$/)?.[1];
      }
      if (data.notesZh === valueB && !window.__qaHeld) {
        window.__qaHeld = true;
        await new Promise(resolve => { window.__qaRelease = resolve; });
      }
    }
    return window.__qaOriginalFetch(...args);
  };
}, { valueB });

try {
  await page.fill('textarea[aria-label="中文笔记"]', valueB);
  await page.waitForFunction(() => window.__qaHeld === true, undefined, { timeout: 10000 });
  await page.fill('textarea[aria-label="中文笔记"]', valueA);
  // Arm the download before requesting export while B is still blocked.
  const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
  await page.click('button.export-button');
  await page.evaluate(() => window.__qaRelease());
  const download = await downloadPromise;
  const outputPath = process.env.QA_OUTPUT || (await import('node:path')).join((await import('node:os')).tmpdir(), 'paperdesk-notes-race-export.md');
  await download.saveAs(outputPath);
  const documentId = await page.evaluate(() => window.__qaDocumentId);
  assert.ok(documentId, 'The edited document must be identified from its actual save request');
  const record = JSON.parse((await page.fetch(`/api/documents/${documentId}`)).body);
  assert.equal(record.document.notesZh, valueA, 'The newest A must overwrite the queued B');
  const exported = await fs.readFile(outputPath, 'utf8');
  assert.ok(exported.includes(valueA), 'Export must await the final A save');
  assert.ok(!exported.includes(valueB), 'Export must not contain the stale B');
  await page.waitForFunction(() => document.querySelector('[aria-label="笔记与批注"] [role="status"]')?.innerText.includes('已保存'), undefined, { timeout: 10000 });
  console.log(JSON.stringify({ result: 'PASS', savedLatestA: true, exportedLatestA: true, observedNoteWrites: await page.evaluate(() => window.__qaRequests), outputPath }));
} finally {
  await page.evaluate(() => { window.__qaRelease?.(); if (window.__qaOriginalFetch) window.fetch = window.__qaOriginalFetch; });
}
