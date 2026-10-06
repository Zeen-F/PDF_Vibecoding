import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { bookmarkedPdf } from './fixtures/toc-browser.mjs';
import { graphicsOnlyPdf } from './fixtures/scan-browser.mjs';
import { assertCropPng } from './chatgpt-handoff.browser.mjs';

// No browser account or external execution is involved. The real queue/API/MCP
// call this controllable executor; tests decide when an original reply arrives.
export function createChatgptRunnerFixture() {
  const runs = [], connectionCalls = [];
  let connectionState = 'closed';
  const connection = () => ({ engine: 'managed-browser', state: connectionState, message: connectionState === 'ready' ? '连接窗口已打开。' : '连接窗口已关闭。' });
  const runner = {
    async connectionStatus() { connectionCalls.push('get'); return connection(); },
    async openConnection() { connectionCalls.push('open'); connectionState = 'ready'; return connection(); },
    async closeConnection() { connectionCalls.push('close'); connectionState = 'closed'; return connection(); },
    async run(job, emit, { resume = false } = {}) {
      let finish;
      const result = new Promise(resolve => { finish = resolve; });
      runs.push({ job: structuredClone(job), resume, emit, finish });
      return result;
    },
    close() { for (const run of runs) run.finish({ state: 'failed', message: 'Isolated test executor closed.' }); },
  };
  return {
    runner, runs, connectionCalls,
    async runFor(id, { resume = false } = {}) {
      await expect.poll(() => runs.some(run => run.job.id === id && run.resume === resume)).toBe(true);
      return runs.find(run => run.job.id === id && run.resume === resume);
    },
  };
}

export async function chatgptAutomationWorkflow({ context, base, fixture }) {
  assert.ok(fixture?.runner, 'Automatic ChatGPT acceptance requires the isolated executor; never use EGO here');
  const pages = [], errors = [], requests = [], sessions = [];
  const api = async (path, body, method = 'POST') => {
    const response = await fetch(`${base}/api${path}`, body === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok(response.ok, `${response.status} ${await response.clone().text()}`); return response.json();
  };
  const upload = async (name, bytes) => {
    const body = new FormData(); body.append('file', new Blob([bytes, '\n% Original automatic bridge fixture\n'], { type: 'application/pdf' }), name);
    const response = await fetch(`${base}/api/documents`, { method: 'POST', body }); assert.equal(response.status, 201); return (await response.json()).document;
  };
  const book = await upload('automatic-original-text.pdf', bookmarkedPdf());
  const scan = await upload('automatic-original-image.pdf', graphicsOnlyPdf());
  const privateNote = 'AUTOMATION_PRIVATE_NOTE never sent or overwritten';
  const before = (await api(`/documents/${book.id}`, { notesZh: privateNote, notesEn: '' }, 'PATCH')).document;
  const postRequests = () => requests.filter(request => request.method === 'POST' && request.path === '/api/chatgpt/jobs');
  const dialog = page => page.getByRole('dialog', { name: 'ChatGPT 提问准备', exact: true });
  const answers = page => page.getByRole('dialog', { name: 'ChatGPT 回答', exact: true });
  const jobCard = (page, id) => answers(page).locator(`[data-job-id="${id}"]`);
  async function open(doc, number) {
    const page = await context.newPage(); pages.push(page); await page.setViewportSize({ width: 1440, height: 1000 });
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/chatgpt/jobs')) requests.push({ path, method: request.method(), body: request.postDataJSON() });
      if (request.method() === 'POST' && path.startsWith('/api/reader-sessions/')) sessions.push(request.postDataJSON());
    });
    await page.addInitScript(() => { window.automationMessages = []; window.addEventListener('message', event => { if (event.data?.method) window.automationMessages.push(event.data.method); }); });
    await page.goto(`${base}/?document=${doc.id}&page=${number}`);
    await expect(page.getByLabel(`PDF 第 ${number} 页`, { exact: true })).toBeVisible(); return page;
  }
  async function selectText(page) {
    const span = page.locator('.textLayer span').filter({ hasText: /^1 Introduction$/ });
    await expect(span).toBeVisible(); await span.scrollIntoViewIfNeeded(); await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('.pdf-paper')).not.toHaveClass(/is-loading/);
    const points = await span.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const rect = range.getBoundingClientRect(), layer = element.closest('.textLayer').getBoundingClientRect();
      return { start: rect.left + .25, lastGlyph: rect.right - .25, end: Math.min(rect.right + 4, layer.right - 1), y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(points.start, points.y); await page.mouse.down();
    await page.mouse.move(points.lastGlyph, points.y, { steps: 12 }); await page.mouse.move(points.end, points.y); await page.mouse.up();
    const quote = await page.evaluate(() => window.getSelection().toString()); assert.equal(quote, '1 Introduction');
    await expect(page.locator('.selection-summary p')).toHaveText(quote);
    await page.getByRole('button', { name: '交给 ChatGPT', exact: true }).click();
    await expect(dialog(page).locator('blockquote')).toHaveText(quote); return quote;
  }
  async function selectRegion(page, reverse = false) {
    const toggle = page.getByRole('button', { name: '区域批注', exact: true });
    if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
    const layer = page.getByLabel('拖动框选批注区域', { exact: true }); await expect(layer).toBeVisible();
    const box = await layer.boundingBox(), from = reverse ? [.55, .38] : [.15, .18], to = reverse ? [.15, .18] : [.55, .38];
    await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]); await page.mouse.down();
    await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 8 }); await page.mouse.up();
    await page.getByRole('button', { name: '交给 ChatGPT', exact: true }).click();
    return dialog(page).getByRole('img').getAttribute('src');
  }
  async function submit(page, question) {
    await dialog(page).getByRole('textbox', { name: '向 ChatGPT 提问', exact: true }).fill(question);
    const count = postRequests().length;
    await dialog(page).getByRole('button', { name: '向 ChatGPT 提问', exact: true }).click();
    await expect.poll(() => postRequests().length).toBe(count + 1);
    await expect(dialog(page).getByRole('button', { name: '向 ChatGPT 提问', exact: true })).toBeDisabled();
    return postRequests().at(-1).body;
  }
  async function view(page) {
    if (await dialog(page).isVisible()) await dialog(page).getByRole('button', { name: '查看回答', exact: true }).click();
    else await page.getByRole('button', { name: '查看回答', exact: true }).click();
    await expect(answers(page)).toBeVisible();
  }
  try {
    const page = await open(book, 2);
    const connectionStart = fixture.connectionCalls.length;
    await page.getByRole('button', { name: '连接 ChatGPT', exact: true }).click();
    const connectionPanel = page.getByRole('region', { name: 'ChatGPT 连接', exact: true });
    await expect(connectionPanel).toBeVisible();
    await connectionPanel.getByRole('button', { name: '打开连接窗口', exact: true }).click();
    await expect(connectionPanel.getByLabel('ChatGPT 连接状态', { exact: true })).toContainText('连接窗口已打开');
    await connectionPanel.getByRole('button', { name: '刷新连接状态', exact: true }).click();
    await connectionPanel.getByRole('button', { name: '关闭连接', exact: true }).click();
    await expect(connectionPanel.getByLabel('ChatGPT 连接状态', { exact: true })).toContainText('连接窗口已关闭');
    assert.equal(fixture.connectionCalls.slice(connectionStart).filter(action => action === 'open').length, 1);
    assert.equal(fixture.connectionCalls.slice(connectionStart).filter(action => action === 'close').length, 1);
    await page.getByRole('button', { name: '连接 ChatGPT', exact: true }).click();
    const quote = await selectText(page);
    await dialog(page).getByRole('textbox', { name: '向 ChatGPT 提问', exact: true }).fill(' \n ');
    await expect(dialog(page).getByRole('button', { name: '向 ChatGPT 提问', exact: true })).toBeDisabled();
    const body = await submit(page, '只解释这个原创标题。'), run = await fixture.runFor(body.requestId);
    assert.deepEqual(Object.keys(body).sort(), ['documentId', 'page', 'question', 'requestId', 'selection']);
    assert.deepEqual(body.selection, { kind: 'text', text: quote }); assert.equal(body.documentId, book.id); assert.equal(body.page, 2);
    assert.deepEqual(run.job.selection, body.selection); assert.ok(!JSON.stringify(run.job).includes(privateNote));
    assert.ok(!JSON.stringify(run.job).includes('A short introduction for navigation checks.'));
    await run.emit({ state: 'waiting', dispatchInvoked: true });
    await dialog(page).getByRole('button', { name: '关闭 ChatGPT 提问准备', exact: true }).click();
    await page.getByRole('button', { name: '下一页', exact: true }).click(); await expect(page.getByLabel('PDF 第 3 页', { exact: true })).toBeVisible();
    const libraryToggle = page.getByRole('button', { name: '展开文献栏', exact: true }); if (await libraryToggle.isVisible()) await libraryToggle.click();
    await page.locator('.document-item').filter({ hasText: scan.title }).click();
    await expect(page.locator('.header-title h1')).toHaveText(scan.title);
    const reply = '模拟执行端回答：只解释原创标题。<script>window.replyExecuted=true</script>';
    run.finish({ state: 'completed', response: reply });
    await expect.poll(async () => (await api(`/chatgpt/jobs/${body.requestId}`)).job.state).toBe('completed');
    await expect(dialog(page)).toBeHidden();
    await expect(page.getByRole('button', { name: '查看回答', exact: true })).toBeHidden();
    await page.locator('.document-item').filter({ hasText: book.title }).click(); await view(page);
    await expect(jobCard(page, body.requestId).getByRole('textbox', { name: 'ChatGPT 回答', exact: true })).toHaveValue(reply);
    await expect(jobCard(page, body.requestId)).toContainText('PDF 第 2 页');
    assert.equal(await page.evaluate(() => window.replyExecuted), undefined);
    assert.equal(postRequests().filter(request => request.body.requestId === body.requestId).length, 1);
    const followupInput = jobCard(page, body.requestId).getByRole('textbox', { name: '继续向 ChatGPT 提问', exact: true });
    const followupButton = jobCard(page, body.requestId).getByRole('button', { name: '继续提问', exact: true });
    await expect(followupButton).toBeDisabled(); await followupInput.fill('只继续解释这个标题的用途。');
    const beforeFollowup = postRequests().length; await followupButton.click();
    await expect.poll(() => postRequests().length).toBe(beforeFollowup + 1);
    await expect(followupInput).toBeDisabled(); await expect(followupInput).toHaveValue('只继续解释这个标题的用途。');
    const followupBody = postRequests().at(-1).body;
    assert.deepEqual(followupBody, { ...body, requestId: followupBody.requestId, parentJobId: body.requestId, question: '只继续解释这个标题的用途。' });
    assert.notEqual(followupBody.requestId, body.requestId); assert.ok(!JSON.stringify(followupBody).includes(reply));
    const followupRun = await fixture.runFor(followupBody.requestId);
    assert.equal(followupRun.job.page, 2); assert.equal(followupRun.job.documentId, book.id); assert.deepEqual(followupRun.job.selection, body.selection);
    assert.equal(followupRun.job.followupContext.at(-1).response, reply);
    followupRun.finish({ state: 'completed', response: '模拟追问回答：仍然绑定原始第 2 页。', dispatchInvoked: true });
    const childReply = jobCard(page, followupBody.requestId).getByRole('textbox', { name: 'ChatGPT 回答', exact: true });
    await expect(childReply).toHaveValue('模拟追问回答：仍然绑定原始第 2 页。'); await expect(childReply).toHaveAttribute('readonly', '');
    await expect(jobCard(page, followupBody.requestId)).toContainText('PDF 第 2 页');
    assert.equal((await api(`/documents/${book.id}`)).document.notesRevision, before.notesRevision);
    await answers(page).getByRole('button', { name: '关闭 ChatGPT 回答', exact: true }).click();
    console.log('PASS: managed connection controls and actual mouse quote/follow-up preserve the original source, private notes and late-answer identity');

    const regionPage = await open(scan, 1), preview = await selectRegion(regionPage, true);
    const imageSize = await regionPage.getByLabel('PDF 第 1 页', { exact: true }).evaluate(canvas => ({ width: canvas.width, height: canvas.height }));
    const regionBody = await submit(regionPage, '解释这个框选图，不处理其他页面。'), regionRun = await fixture.runFor(regionBody.requestId);
    assert.deepEqual(regionBody.selection, { kind: 'region', text: '', preview });
    assertCropPng(Buffer.from(regionRun.job.selection.preview.split(',')[1], 'base64'), preview, imageSize);
    regionRun.finish({ state: 'needs_user', canResume: true, message: '模拟需要用户登录。' });
    await view(regionPage); const regionCard = jobCard(regionPage, regionBody.requestId);
    await expect(regionCard.getByRole('button', { name: '我已完成，继续连接', exact: true })).toBeVisible();
    await regionCard.getByRole('button', { name: '刷新任务状态', exact: true }).click();
    assert.equal(fixture.runs.filter(item => item.job.id === regionBody.requestId).length, 1, 'Polling cannot resume execution');
    await regionCard.getByRole('button', { name: '我已完成，继续连接', exact: true }).click();
    const resumed = await fixture.runFor(regionBody.requestId, { resume: true }); assert.deepEqual(resumed.job.selection, regionBody.selection);
    resumed.finish({ state: 'completed', response: '模拟图片回答：该区域包含原创图形。', dispatchInvoked: true });
    await expect(regionCard.getByRole('textbox', { name: 'ChatGPT 回答', exact: true })).toHaveValue('模拟图片回答：该区域包含原创图形。');
    assert.equal(requests.filter(request => request.method === 'POST' && request.path.endsWith(`${regionBody.requestId}/resume`)).length, 1);
    await answers(regionPage).getByRole('button', { name: '关闭 ChatGPT 回答', exact: true }).click();
    console.log('PASS: reverse region crop is byte-exact and paused jobs continue only after an explicit user action');

    // Drop the HTTP acknowledgement after the real API accepted the job. The
    // interface must query that UUID, without repeating the submission.
    await selectRegion(regionPage); let dropped = false;
    await regionPage.route(`${base}/api/chatgpt/jobs`, async route => {
      if (route.request().method() === 'POST' && !dropped) { dropped = true; await route.fetch(); return route.abort('failed'); }
      await route.continue();
    });
    const lostBody = await submit(regionPage, '模拟提交回执丢失。'), lostRun = await fixture.runFor(lostBody.requestId);
    await expect.poll(() => requests.some(request => request.method === 'GET' && request.path.endsWith(lostBody.requestId))).toBe(true);
    lostRun.finish({ state: 'completed', response: '回执虽丢失，任务只执行一次。', dispatchInvoked: true });
    const inlineAnswer = dialog(regionPage).getByRole('textbox', { name: 'ChatGPT 回答预览', exact: true });
    await expect(inlineAnswer).toBeVisible();
    await expect(inlineAnswer).toHaveAttribute('readonly', '');
    await expect(inlineAnswer).toHaveValue('回执虽丢失，任务只执行一次。');
    assert.equal((await api(`/documents/${book.id}`)).document.notesRevision, before.notesRevision);
    assert.equal((await api(`/documents/${scan.id}`)).document.notesZh, '');
    await view(regionPage); await expect(jobCard(regionPage, lostBody.requestId).getByRole('textbox', { name: 'ChatGPT 回答', exact: true })).toHaveValue('回执虽丢失，任务只执行一次。');
    assert.equal(postRequests().filter(request => request.body.requestId === lostBody.requestId).length, 1);
    await answers(regionPage).getByRole('button', { name: '关闭 ChatGPT 回答', exact: true }).click();
    await regionPage.unroute(`${base}/api/chatgpt/jobs`);

    // No job was accepted: only a user-confirmed retry may repeat the SAME
    // UUID/body. It still flows through the real deduplicating API afterwards.
    await selectRegion(regionPage); let aborted = false;
    await regionPage.route(`${base}/api/chatgpt/jobs`, async route => {
      if (route.request().method() === 'POST' && !aborted) { aborted = true; return route.abort('failed'); }
      await route.continue();
    });
    const retryBody = await submit(regionPage, '原请求未到服务，明确重试。');
    await view(regionPage); const retryCard = jobCard(regionPage, retryBody.requestId);
    await expect(retryCard.getByRole('button', { name: '重新确认提交', exact: true })).toBeVisible();
    assert.equal(fixture.runs.some(item => item.job.id === retryBody.requestId), false);
    assert.equal(postRequests().filter(request => request.body.requestId === retryBody.requestId).length, 1);
    await retryCard.getByRole('button', { name: '重新确认提交', exact: true }).click();
    const retryRun = await fixture.runFor(retryBody.requestId); retryRun.finish({ state: 'completed', response: '显式重试只执行一次。' });
    await expect(retryCard.getByRole('textbox', { name: 'ChatGPT 回答', exact: true })).toHaveValue('显式重试只执行一次。');
    const retried = postRequests().filter(request => request.body.requestId === retryBody.requestId); assert.equal(retried.length, 2); assert.deepEqual(retried[0].body, retried[1].body);
    await answers(regionPage).getByRole('button', { name: '关闭 ChatGPT 回答', exact: true }).click();
    await regionPage.unroute(`${base}/api/chatgpt/jobs`);
    console.log('PASS: lost acknowledgements only query the original UUID; an unaccepted request requires an explicit identical retry');

    // Deliberately last: uncertain is a durable queue stop, not a test-only
    // condition to clear by resending or manufacturing a fresh request ID.
    await selectRegion(regionPage); const uncertainBody = await submit(regionPage, '模拟已发送但结果不确定。');
    (await fixture.runFor(uncertainBody.requestId)).finish({ state: 'uncertain', dispatchInvoked: true, message: '模拟发送后连接中断，请核对原会话。' });
    await view(regionPage); const uncertainCard = jobCard(regionPage, uncertainBody.requestId);
    await expect(uncertainCard).toContainText('此任务不会自动重新发送');
    await expect(uncertainCard.getByRole('button', { name: '我已完成，继续连接', exact: true })).toHaveCount(0);
    await expect(uncertainCard.getByRole('button', { name: '重新确认提交', exact: true })).toHaveCount(0);
    await uncertainCard.getByRole('button', { name: '刷新任务状态', exact: true }).click();
    assert.equal(postRequests().filter(request => request.body.requestId === uncertainBody.requestId).length, 1);
    const after = (await api(`/documents/${book.id}`)).document;
    assert.equal(after.notesRevision, before.notesRevision); assert.equal(after.notesZh, privateNote);
    assert.deepEqual((await api(`/documents/${scan.id}`)).annotations, []);
    assert.ok(sessions.length > 0 && sessions.every(session => session.selection === null));
    for (const page of pages) assert.equal((await page.evaluate(() => window.automationMessages)).some(method => ['ui/message', 'ui/update-model-context'].includes(method)), false);
    assert.deepEqual(errors, []);
    console.log('PASS: uncertain jobs never resend, answers do not modify notes/annotations, and automatic ChatGPT never injects a Codex selection');
  } finally { await Promise.allSettled(pages.map(page => page.close())); }
}
