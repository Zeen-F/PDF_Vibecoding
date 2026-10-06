import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { EmbeddedResourceSchema } from '@modelcontextprotocol/sdk/types.js';
import { bookmarkedPdf } from './fixtures/toc-browser.mjs';
import { graphicsOnlyPdf } from './fixtures/scan-browser.mjs';
import { assertHandoffPrompt, assertCropPng } from './chatgpt-handoff.browser.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fullCapabilities = { serverTools: {}, updateModelContext: { text: {}, image: {}, structuredContent: {} }, message: { text: {}, image: {} }, openLinks: {}, downloadFile: {} };
const hasContext = value => Boolean(value?.content?.length || value?.structuredContent);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Real MCP transport, real isolated API, and a browser sandbox that cannot fetch
// the local service. Only the parent host's tools/call bridge crosses that gap.
export async function nativeReaderWorkflow({ context, base, onQuestionPreview, onChatGPTPreview, chatgptFixture }) {
  const tempDir = await mkdtemp(join(tmpdir(), 'paperdesk-native-reader-'));
  const harnesses = [];
  let client;
  try {
    const status = await (await fetch(`${base}/api/plugin/status`)).json();
    const profile = join(tempDir, 'profile.json');
    await writeFile(profile, JSON.stringify({ workspaceRoot: root, baseUrl: base, libraryId: status.libraryId }));
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'plugins/paperdesk/scripts/start.mjs')], cwd: tempDir, env: { ...process.env, PAPERDESK_PLUGIN_CONFIG: profile }, stderr: 'pipe' });
    let stderr = '';
    transport.stderr.on('data', data => { stderr += data; });
    client = new Client({ name: 'paperdesk-native-browser-test', version: '1.0.0' });
    await client.connect(transport);
    const template = await readFile(join(root, 'plugins/paperdesk/ui/reader.html'), 'utf8');
    const html = template.replace('__PAPERDESK_CONFIG__', JSON.stringify({ baseUrl: base }).replaceAll('<', '\\u003c'));
    assert.ok(!html.includes('__PAPERDESK_CONFIG__'));
    const displayTools = new Set(['paperdesk_reader_page', 'paperdesk_reader_get_notes', 'paperdesk_reader_save_notes', 'paperdesk_reader_toc', 'paperdesk_reader_session', 'paperdesk_reader_close', 'paperdesk_reader_chatgpt_submit', 'paperdesk_reader_chatgpt_get', 'paperdesk_reader_chatgpt_resume']);
    const tools = (await client.listTools()).tools;
    for (const name of displayTools) assert.deepEqual(tools.find(tool => tool.name === name)?._meta?.ui?.visibility, ['app'], `${name} must be app-only`);

    const upload = async (name, bytes) => {
      const body = new FormData(); body.append('file', new Blob([bytes, Buffer.from('\n% Original native reader sandbox regression\n')], { type: 'application/pdf' }), name);
      const response = await fetch(`${base}/api/documents`, { method: 'POST', body });
      assert.equal(response.status, 201);
      return (await response.json()).document;
    };
    const request = async (path, body, method = 'POST') => {
      const response = await fetch(`${base}/api${path}`, body === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, ...(await response.json()) };
    };
    const book = await upload('original-native-text.pdf', bookmarkedPdf());
    const scan = await upload('original-native-region.pdf', graphicsOnlyPdf());
    const privateNotes = 'NATIVE_PRIVATE_NOTE：这段笔记只应在阅读界面显示。';
    assert.equal((await request(`/documents/${book.id}`, { notesZh: privateNotes, notesEn: '' }, 'PATCH')).status, 200);

    async function harness({ documentId = book.id, pageNumber = 1, capabilities = fullCapabilities, failOpenLink = false, libraryOnly = false, useClock = false, holdInitialNotes = false, failClipboard = false } = {}) {
      const page = await context.newPage(); await page.setViewportSize({ width: 1500, height: 1100 });
      if (useClock) await page.clock.install();
      if (failClipboard) await page.addInitScript(() => {
        window.handoffClipboard = { mode: 'reject', calls: [], pending: [] };
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => {
          window.handoffClipboard.calls.push(text);
          if (window.handoffClipboard.mode === 'hold') return new Promise(resolve => window.handoffClipboard.pending.push(resolve));
          throw new Error('Isolated clipboard rejection fixture');
        } } });
      });
      const item = { page, close: () => page.close() }; harnesses.push(item);
      const calls = [], updates = [], messages = [], downloads = [], links = [], errors = [], network = [], holds = [];
      let initialized = false, messageResult = { isError: false }, downloadResult = { isError: false };
      const holdNext = (predicate, phase = 'after') => {
        const hold = { predicate, phase, used: false, entered: deferred(), release: deferred(), finished: deferred() }; holds.push(hold);
        return { entered: hold.entered.promise, finished: hold.finished.promise, release: () => hold.release.resolve() };
      };
      const initialNotesHold = holdInitialNotes ? holdNext(entry => entry.params?.name === 'paperdesk_reader_get_notes') : null;
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', req => { if (/^https?:/.test(req.url())) network.push(req.url()); });
      const opened = await client.callTool({ name: 'paperdesk_open_reader', arguments: libraryOnly ? {} : { documentId, page: pageNumber } });
      assert.notEqual(opened.isError, true);
      await page.exposeBinding('paperdeskHostRpc', async (_source, message) => {
        const entry = { id: message.id, method: message.method, params: message.params }; calls.push(entry);
        const hold = holds.find(item => !item.used && item.predicate(entry));
        if (hold) { hold.used = true; if (hold.phase === 'before') { hold.entered.resolve(); await hold.release.promise; } }
        let result;
        if (message.method === 'ui/initialize') result = { protocolVersion: '2026-01-26', hostInfo: { name: 'isolated-browser-host', version: '1.0.0' }, hostCapabilities: capabilities };
        else if (message.method === 'ui/notifications/initialized') { initialized = true; return; }
        else if (message.method === 'tools/call') result = await client.callTool(message.params);
        else if (message.method === 'ui/update-model-context') { updates.push(message.params); result = {}; }
        else if (message.method === 'ui/message') {
          assert.equal(message.params.role, 'user'); assert.ok(Array.isArray(message.params.content));
          messages.push(message.params); result = messageResult;
        }
        else if (message.method === 'ui/download-file') {
          assert.deepEqual(Object.keys(message.params), ['contents']); assert.equal(message.params.contents.length, 1);
          for (const resource of message.params.contents) EmbeddedResourceSchema.parse(resource);
          downloads.push(message.params); result = downloadResult;
        }
        else if (message.method === 'ui/open-link') { links.push(message.params); if (failOpenLink) throw new Error('模拟宿主拒绝打开链接'); result = {}; }
        else if (message.method === 'ui/notifications/size-changed') return;
        else throw new Error(`Unexpected host RPC: ${message.method}`);
        entry.result = result;
        if (hold?.phase === 'after') { hold.entered.resolve(); await hold.release.promise; }
        if (hold) hold.finished.resolve();
        return result;
      });
      const url = `${base}/__native_reader_harness_${randomUUID()}`;
      await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%}iframe{width:100%;height:100%;border:0}</style></head><body></body></html>' }));
      await page.goto(url);
      const constrained = html.replace(/<head>/i, '<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; connect-src \'none\'; frame-src \'none\'">');
      await page.evaluate(({ source }) => {
        const frame = document.createElement('iframe'); frame.id = 'native-panel'; frame.title = 'Native reader test panel'; frame.setAttribute('sandbox', 'allow-scripts');
        window.nativeMessages = [];
        window.addEventListener('message', async event => {
          if (event.source !== frame.contentWindow || event.data?.jsonrpc !== '2.0') return;
          window.nativeMessages.push({ origin: event.origin, id: event.data.id, method: event.data.method });
          const message = event.data;
          if (!message.method) return;
          try {
            const result = await window.paperdeskHostRpc(message);
            if (Object.hasOwn(message, 'id')) event.source.postMessage({ jsonrpc: '2.0', id: message.id, result }, '*');
          } catch (error) {
            if (Object.hasOwn(message, 'id')) event.source.postMessage({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error.message } }, '*');
          }
        });
        frame.srcdoc = source; document.body.append(frame);
      }, { source: constrained });
      await expect.poll(() => initialized).toBe(true);
      await page.evaluate(result => document.getElementById('native-panel').contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }, '*'), opened);
      const frame = page.frameLocator('#native-panel');
      Object.assign(item, { page, frame, calls, updates, messages, downloads, links, errors, network, url, holdNext, initialNotesHold,
        setMessageResult(value) { messageResult = value; },
        setDownloadResult(value) { downloadResult = value; },
        sessionId: () => calls.filter(call => call.method === 'tools/call' && call.params.name === 'paperdesk_reader_session').at(-1)?.params.arguments.sessionId,
        async notify(result) { await page.evaluate(value => document.getElementById('native-panel').contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: value }, '*'), result); },
        async close() { for (const hold of holds) hold.release.resolve(); if (!page.isClosed()) { await page.evaluate(() => document.getElementById('native-panel').contentWindow.postMessage({ jsonrpc: '2.0', id: 'test-teardown', method: 'ui/resource-teardown', params: {} }, '*')).catch(() => {}); await expect.poll(() => page.evaluate(() => window.nativeMessages.some(message => message.id === 'test-teardown' && !message.method)), { timeout: 5000 }).toBe(true).catch(() => {}); await page.close(); } },
      });
      return item;
    }
    const image = (h, number) => h.frame.getByRole('img', { name: `PDF 第 ${number} 页`, exact: true });
    async function ready(h, number) {
      await expect(image(h, number)).toBeVisible({ timeout: 20000 });
      await expect.poll(() => image(h, number).evaluate(element => element.complete && element.naturalWidth > 0 && element.naturalHeight > 0)).toBe(true);
      await expect.poll(h.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    }
    async function drag(h, from, to) {
      const layer = h.frame.getByLabel('拖动框选区域', { exact: true });
      await expect(layer).toBeVisible(); const box = await layer.boundingBox(); assert.ok(box);
      await h.page.mouse.move(box.x + from[0] * box.width, box.y + from[1] * box.height); await h.page.mouse.down();
      await h.page.mouse.move(box.x + to[0] * box.width, box.y + to[1] * box.height, { steps: 7 }); await h.page.mouse.up();
      await expect(h.frame.getByRole('dialog', { name: '共享预览', exact: true })).toBeVisible();
    }
    async function selectText(h, selected = 'A short introduction') {
      const details = h.frame.locator('#text-pane');
      if (!await details.evaluate(element => element.open)) await details.locator('summary').click();
      const text = h.frame.getByRole('textbox', { name: '本页文字', exact: true });
      const start = (await text.inputValue()).indexOf(selected); assert.ok(start >= 0);
      // A readonly textarea on macOS does not move its caret with Arrow keys.
      // Measure its real font, then drag the actual browser selection. No
      // application selection object or DOM selection range is manufactured.
      await text.scrollIntoViewIfNeeded();
      const box = await text.boundingBox(); assert.ok(box);
      const points = await text.evaluate((element, range) => {
        const style = getComputedStyle(element), prefix = element.value.slice(0, range.start), line = prefix.split('\n').at(-1);
        const canvas = document.createElement('canvas'), drawing = canvas.getContext('2d');
        drawing.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const left = parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth) - element.scrollLeft;
        return { x1: left + drawing.measureText(line).width, x2: left + drawing.measureText(line + range.selected).width,
          y: parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth) + (prefix.split('\n').length - .5) * parseFloat(style.lineHeight) - element.scrollTop };
      }, { start, selected });
      // Collapse a previous selection first; dragging inside an existing native
      // selection starts text drag-and-drop instead of a fresh selection.
      await h.page.mouse.click(box.x + box.width - 20, box.y + 20);
      await h.page.mouse.move(box.x + points.x1, box.y + points.y); await h.page.mouse.down();
      await h.page.mouse.move(box.x + points.x2, box.y + points.y, { steps: 8 }); await h.page.mouse.up();
      assert.equal(await text.evaluate(element => element.value.slice(element.selectionStart, element.selectionEnd)), selected);
      await h.frame.getByRole('button', { name: '预览选中文字', exact: true }).click();
      await expect(h.frame.locator('#preview-quote')).toHaveText(selected);
    }
    function assertQuestion(message, h, doc, pageNumber, selected) {
      assert.equal(message.role, 'user');
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      assert.ok(text.includes(doc.id) && text.includes(h.sessionId()));
      assert.match(text, new RegExp(`"pdfPage":${pageNumber}(?:,|})`));
      assert.ok(!text.includes(privateNotes) && !text.includes('for navigation checks.') && !text.includes('必须保留的原生面板草稿'));
      if (selected) assert.ok(text.includes(selected));
      return text;
    }
    const currentContext = h => request(`/reader-context?sessionId=${h.sessionId()}`);

    const landing = await harness({ libraryOnly: true });
    await expect(landing.frame.getByRole('button', { name: book.title, exact: true })).toBeVisible();
    await expect(landing.frame.locator('#status')).toContainText('选择一篇文献');
    assert.equal(landing.calls.some(entry => entry.method === 'tools/call' && entry.params.name !== 'paperdesk_list_documents'), false, 'An empty open request may list metadata but must not automatically render, read notes or create a reader session');
    assert.equal(landing.updates.some(hasContext), false);
    await landing.close();

    const normal = await harness({ pageNumber: 2 }); await ready(normal, 2);
    assert.ok(await image(normal, 2).evaluate(element => {
      const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 150;
      const drawing = canvas.getContext('2d'); drawing.drawImage(element, 0, 0, canvas.width, canvas.height);
      const rgba = drawing.getImageData(0, 0, canvas.width, canvas.height).data;
      return rgba.some((value, index) => index % 4 !== 3 && value < 200);
    }), 'The returned PNG must contain visible PDF content, not a blank placeholder');
    assert.equal(await normal.page.evaluate(() => window.nativeMessages.every(message => message.origin === 'null')), true, 'The reader really runs in an opaque origin');
    assert.deepEqual(normal.network, [normal.url], 'Reader cannot depend on localhost image/script/fetch requests');
    await expect(normal.frame.locator('iframe')).toHaveCount(0);
    assert.equal(normal.updates.some(hasContext), false, 'Opening must not publish page pixels, text or notes to the model');
    const scanCallsBeforeForgery = normal.calls.filter(entry => entry.params?.arguments?.documentId === scan.id).length;
    await normal.page.evaluate(async forged => {
      const attacker = document.createElement('iframe'); attacker.hidden = true; attacker.setAttribute('sandbox', 'allow-scripts');
      const loaded = new Promise(resolve => { attacker.onload = resolve; });
      attacker.srcdoc = `<script>window.parent.frames[0].postMessage(${JSON.stringify(forged)}, '*');<\/script>`;
      document.body.append(attacker); await loaded;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      attacker.remove();
    }, { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { url: `${base}/?document=${scan.id}&page=2`, document: scan } } });
    assert.equal(normal.calls.filter(entry => entry.params?.arguments?.documentId === scan.id).length, scanCallsBeforeForgery, 'A sibling window must not impersonate the parent host');
    await expect(image(normal, 2)).toBeVisible();
    await normal.frame.getByRole('button', { name: '展开目录', exact: true }).click();
    await expect(normal.frame.getByRole('navigation', { name: '章节目录', exact: true })).toBeVisible();
    await expect(normal.frame.getByRole('button', { name: '1.1 Scope，PDF 第 3 页', exact: true })).toBeVisible();
    await normal.frame.getByRole('button', { name: '展开笔记', exact: true }).click();
    const notes = normal.frame.getByRole('textbox', { name: '笔记', exact: true });
    await expect(notes).toHaveValue(privateNotes);
    for (const entry of normal.calls.filter(call => call.method === 'tools/call' && displayTools.has(call.params.name) && call.result && !call.result.isError)) {
      assert.ok(entry.result._meta, `${entry.params.name} needs a UI-only payload`);
      const visible = JSON.stringify({ content: entry.result.content, structuredContent: entry.result.structuredContent });
      assert.ok(!visible.includes(privateNotes) && !visible.includes('A short introduction') && !visible.includes('iVBOR'), 'Rendering data must stay out of model-visible fields');
    }
    await normal.frame.getByRole('button', { name: '下一页', exact: true }).click(); await ready(normal, 3);
    await normal.frame.getByRole('button', { name: '上一页', exact: true }).click(); await ready(normal, 2);
    const latePage = normal.holdNext(entry => entry.method === 'tools/call' && entry.params.name === 'paperdesk_reader_page' && entry.params.arguments.page === 1);
    await normal.frame.getByRole('button', { name: '上一页', exact: true }).click(); await latePage.entered;
    await normal.frame.getByLabel('PDF 页码', { exact: true }).fill('2');
    await normal.frame.getByLabel('PDF 页码', { exact: true }).press('Enter');
    await ready(normal, 2); latePage.release(); await latePage.finished;
    await normal.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(image(normal, 2)).toBeVisible();
    console.log('PASS: opaque sandbox renders through real MCP only, keeps display data in _meta, and ignores a late page image');

    await notes.fill('原生面板手动保存的笔记'); await normal.frame.getByRole('button', { name: '保存笔记', exact: true }).click();
    await expect.poll(async () => (await request(`/documents/${book.id}`)).document.notesZh).toBe('原生面板手动保存的笔记');
    const saved = (await request(`/documents/${book.id}`)).document;
    await notes.fill('必须保留的原生面板草稿');
    await normal.frame.getByRole('button', { name: scan.title, exact: true }).click();
    await expect(notes).toHaveValue('必须保留的原生面板草稿'); await expect(image(normal, 2)).toBeVisible();
    await request(`/documents/${book.id}`, { notesZh: '另一个窗口保存的新笔记', notesEn: '', expectedNotesRevision: saved.notesRevision }, 'PATCH');
    await normal.frame.getByRole('button', { name: '保存笔记', exact: true }).click();
    await expect(normal.frame.locator('#error-box')).toContainText(/更新|版本|冲突/);
    await expect(notes).toHaveValue('必须保留的原生面板草稿');
    assert.equal((await request(`/documents/${book.id}`)).document.notesZh, '另一个窗口保存的新笔记');
    assert.ok(normal.calls.some(entry => entry.params?.name === 'paperdesk_reader_save_notes' && entry.result?.isError), 'The conflict must come from a real CAS request');
    await normal.frame.getByRole('button', { name: '核对最新笔记', exact: true }).click();
    await expect(normal.frame.getByRole('textbox', { name: '最新已保存笔记', exact: true })).toHaveValue('另一个窗口保存的新笔记');
    await expect(notes).toHaveValue('必须保留的原生面板草稿');
    const merged = '另一个窗口保存的新笔记\n\n必须保留的原生面板草稿';
    await notes.fill(merged); await normal.frame.getByRole('button', { name: '合并后保存', exact: true }).click();
    await expect.poll(async () => (await request(`/documents/${book.id}`)).document.notesZh).toBe(merged);
    await expect(notes).toHaveValue(merged);
    await normal.close();
    console.log('PASS: manual CAS saves, conflict preservation and dirty-note navigation protection');

    const region = await harness({ documentId: scan.id }); await ready(region, 1);
    await region.frame.getByRole('button', { name: '框选区域', exact: true }).click();
    await drag(region, [.15, .18], [.50, .36]);
    assert.equal((await currentContext(region)).selection, null);
    assert.equal(region.updates.some(hasContext), false);
    await region.frame.getByRole('dialog', { name: '共享预览', exact: true }).getByRole('button', { name: '交给 Codex', exact: true }).click();
    await expect.poll(() => region.updates.some(update => update.content?.some(block => block.type === 'image'))).toBe(true);
    const shared = await currentContext(region);
    assert.equal(shared.selection.kind, 'region'); assert.equal(shared.selection.text, ''); assert.equal(shared.selection.rects.length, 1);
    for (const [key, value] of Object.entries({ x: .15, y: .18, width: .35, height: .18 })) assert.ok(Math.abs(shared.selection.rects[0][key] - value) < .005, `Shared ${key} must match the visible dragged region`);
    assert.match(shared.selection.preview, /^data:image\/png;base64,/);
    await region.frame.getByRole('button', { name: '取消共享', exact: true }).click();
    await expect.poll(async () => (await currentContext(region)).selection).toBeNull();
    await expect.poll(() => hasContext(region.updates.at(-1))).toBe(false);
    await drag(region, [.5, .36], [.15, .18]);
    const delayedShare = region.holdNext(entry => entry.method === 'tools/call' && entry.params.name === 'paperdesk_reader_session' && entry.params.arguments.selection !== null);
    await region.frame.getByRole('dialog', { name: '共享预览', exact: true }).getByRole('button', { name: '交给 Codex', exact: true }).click(); await delayedShare.entered;
    await region.frame.getByRole('button', { name: '取消共享', exact: true }).click(); delayedShare.release();
    await expect.poll(async () => (await currentContext(region)).selection).toBeNull();
    await expect.poll(() => hasContext(region.updates.at(-1))).toBe(false);

    await drag(region, [.15, .18], [.50, .36]);
    await region.frame.getByRole('dialog', { name: '共享预览', exact: true }).getByRole('button', { name: '交给 Codex', exact: true }).click();
    await expect.poll(() => region.updates.at(-1)?.content?.some(block => block.type === 'image')).toBe(true);
    await region.frame.getByRole('button', { name: '展开笔记', exact: true }).click();
    const hiddenDraft = '隐藏面板期间也必须保护的未保存草稿';
    await region.frame.getByRole('textbox', { name: '笔记', exact: true }).fill(hiddenDraft);
    await expect.poll(async () => (await currentContext(region)).notesDirty).toBe(true);
    const child = region.page.frames()[1];
    // This is an explicit sandbox lifecycle simulation, not a claim about OS
    // window visibility. The browser executes the real UI event handler and
    // its real SDK/API cleanup with an overridden test-fixture visibility.
    const visibility = state => child.evaluate(value => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);
    await visibility('hidden');
    await expect.poll(async () => (await currentContext(region)).status).toBe(404);
    await expect.poll(() => region.updates.at(-1)?.content).toEqual([]);
    const hiddenSnapshot = region.calls.filter(entry => entry.params?.name === 'paperdesk_reader_session').at(-1).params.arguments;
    assert.equal(hiddenSnapshot.visible, false); assert.equal(hiddenSnapshot.selection, null); assert.equal(hiddenSnapshot.notesDirty, true);
    const scanNotes = (await request(`/documents/${scan.id}`)).document;
    const hiddenAppend = await request(`/documents/${scan.id}/notes/append`, { text: '不得绕过后台草稿保护', expectedNotesRevision: scanNotes.notesRevision, requestId: randomUUID() });
    assert.equal(hiddenAppend.status, 409, 'A hidden reader must continue protecting its unsaved notes');
    await visibility('visible');
    await expect.poll(async () => (await currentContext(region)).status).toBe(200);
    assert.equal((await currentContext(region)).selection, null, 'Returning to the panel must not restore the previous shared region');
    assert.equal((await currentContext(region)).notesDirty, true);
    await expect(region.frame.getByRole('textbox', { name: '笔记', exact: true })).toHaveValue(hiddenDraft);
    await region.frame.getByRole('textbox', { name: '笔记', exact: true }).fill(scanNotes.notesZh);
    await expect.poll(async () => (await currentContext(region)).notesDirty).toBe(false);
    assert.deepEqual(region.updates.at(-1).content, []);
    assert.equal(await region.page.frames()[1].evaluate(url => fetch(`${url}/api/plugin/status`).then(() => false, () => true), base), true, 'CSP must really reject child fetch');
    await region.close();
    console.log('PASS: forward/reverse region previews require confirmation, inject images from opaque origin, and clear after a delayed share');
    console.log('PASS: simulated sandbox hide clears shared context, preserves dirty-note protection, and returns without resharing');

    const noImage = await harness({ documentId: scan.id, capabilities: { ...fullCapabilities, updateModelContext: { text: {}, structuredContent: {} } } });
    await ready(noImage, 1); await noImage.frame.getByRole('button', { name: '框选区域', exact: true }).click(); await drag(noImage, [.15, .18], [.50, .36]);
    await noImage.frame.getByRole('dialog', { name: '共享预览', exact: true }).getByRole('button', { name: '交给 Codex', exact: true }).click();
    await expect(noImage.frame.locator('#error-box')).toContainText(/图片|图像/);
    assert.equal(noImage.updates.some(hasContext), false, 'No-image host must not pretend a region was shared');
    await noImage.close();

    const noTools = await harness({ pageNumber: 2, capabilities: { openLinks: {} }, failOpenLink: true });
    await expect(noTools.frame.locator('#error-box')).toContainText(/宿主|工具|不支持/);
    await noTools.frame.getByRole('button', { name: '重试', exact: true }).click();
    await expect(noTools.frame.locator('#error-box')).toBeVisible();
    await noTools.frame.locator('#browser-button').click();
    await expect.poll(() => noTools.links.length).toBeGreaterThan(0);
    const expectedUrl = `${base}/?document=${book.id}&page=2`;
    assert.equal(noTools.links.at(-1).url, expectedUrl);
    await expect(noTools.frame.getByRole('textbox', { name: '阅读器链接', exact: true })).toHaveValue(expectedUrl);
    assert.equal(noTools.calls.some(entry => entry.method === 'tools/call'), false);
    console.log('PASS: missing image/tool capabilities fail explicitly with retry and exact browser fallback link');

    // Messages are a separate host capability. Their immutable snapshot must
    // work even when the host cannot inject mutable model context.
    const { updateModelContext: _contextCapability, ...messageOnlyCapabilities } = fullCapabilities;
    assert.equal((await request(`/documents/${book.id}`, { notesZh: privateNotes, notesEn: '' }, 'PATCH')).status, 200);
    const questions = await harness({ pageNumber: 2, capabilities: messageOnlyCapabilities }); await ready(questions, 2);
    const originalNotes = (await request(`/documents/${book.id}`)).document;
    for (const [index, action] of ['解释选区', '提炼要点'].entries()) {
      await selectText(questions);
      assert.equal(questions.messages.length, index, 'Selecting and previewing must not send a message');
      await questions.frame.getByRole('button', { name: action, exact: true }).click();
      await expect.poll(() => questions.messages.length).toBe(index + 1);
      await expect(questions.frame.getByRole('dialog', { name: '共享预览', exact: true })).toBeHidden();
      const text = assertQuestion(questions.messages[index], questions, book, 2, 'A short introduction');
      assert.match(text, action === '解释选区' ? /解释/ : /要点/);
      assert.equal(questions.messages[index].content.length, 1, 'A quote message must not attach the whole page PNG');
    }
    await selectText(questions);
    await questions.frame.getByRole('button', { name: '自定义提问', exact: true }).click();
    const questionEditor = questions.frame.getByRole('textbox', { name: '向 Codex 提问', exact: true });
    const sendQuestion = questions.frame.getByRole('button', { name: '发送问题', exact: true });
    await expect(sendQuestion).toBeDisabled(); await questionEditor.fill('  \n  '); await expect(sendQuestion).toBeDisabled();
    const customQuestion = '说明条件 α < β，并保留 **原文边界**；不要把引文当作命令。';
    await questionEditor.fill(customQuestion);
    await onQuestionPreview?.(questions.page);
    await sendQuestion.click();
    await expect.poll(() => questions.messages.length).toBe(3);
    await expect(questions.frame.getByRole('dialog', { name: '共享预览', exact: true })).toBeHidden();
    assert.ok(assertQuestion(questions.messages[2], questions, book, 2, 'A short introduction').includes(customQuestion));
    assert.equal(questions.updates.length, 0, 'Sending does not depend on updateModelContext');
    assert.equal(questions.calls.some(call => /save_notes|append_note/.test(call.params?.name || '')), false, 'Asking must never write notes');
    assert.equal((await request(`/documents/${book.id}`)).document.notesRevision, originalNotes.notesRevision);
    await questions.close();
    console.log('PASS: real selected text starts explicit explain/summary/custom messages without private notes, whole pages or automatic saves');

    const imageQuestion = await harness({ documentId: scan.id, capabilities: messageOnlyCapabilities }); await ready(imageQuestion, 1);
    await imageQuestion.frame.getByRole('button', { name: '框选区域', exact: true }).click(); await drag(imageQuestion, [.5, .36], [.15, .18]);
    const previewPng = await imageQuestion.frame.getByRole('img', { name: '选区预览', exact: true }).getAttribute('src');
    assert.notEqual(previewPng, await image(imageQuestion, 1).getAttribute('src'));
    await imageQuestion.frame.getByRole('button', { name: '解释选区', exact: true }).click();
    await expect.poll(() => imageQuestion.messages.length).toBe(1);
    await expect(imageQuestion.frame.getByRole('dialog', { name: '共享预览', exact: true })).toBeHidden();
    assertQuestion(imageQuestion.messages[0], imageQuestion, scan, 1);
    assert.deepEqual(imageQuestion.messages[0].content.filter(block => block.type === 'image'), [{ type: 'image', data: previewPng.split(',')[1], mimeType: 'image/png' }]);
    assert.equal(imageQuestion.messages[0].content.length, 2);
    await imageQuestion.close();

    for (const mode of ['no-message', 'no-message-image']) {
      const isRegion = mode === 'no-message-image';
      const { message: _messageCapability, ...noMessageCapabilities } = fullCapabilities;
      const unsupported = await harness({ documentId: isRegion ? scan.id : book.id, pageNumber: isRegion ? 1 : 2, capabilities: isRegion ? { ...fullCapabilities, message: { text: {} } } : noMessageCapabilities });
      await ready(unsupported, isRegion ? 1 : 2);
      if (isRegion) { await unsupported.frame.getByRole('button', { name: '框选区域', exact: true }).click(); await drag(unsupported, [.15, .18], [.5, .36]); }
      else await selectText(unsupported);
      await unsupported.frame.getByRole('button', { name: '提炼要点', exact: true }).click();
      const fallback = unsupported.frame.getByRole('textbox', { name: '待发送问题', exact: true });
      await expect(fallback).toBeVisible(); await expect(fallback).toHaveAttribute('readonly', '');
      assert.ok((await fallback.inputValue()).includes(isRegion ? scan.id : book.id));
      await expect(unsupported.frame.locator('#question-status')).toContainText('尚未发送');
      await expect(unsupported.frame.getByRole('dialog', { name: '共享预览', exact: true })).toBeVisible();
      assert.equal(unsupported.messages.length, 0);
      await unsupported.frame.getByRole('dialog', { name: '共享预览', exact: true }).getByRole('button', { name: '交给 Codex', exact: true }).click();
      await expect.poll(() => unsupported.updates.some(hasContext)).toBe(true);
      assert.equal(unsupported.messages.length, 0, 'The existing share action must remain share-only');
      await unsupported.close();
    }
    console.log('PASS: region messages contain only the preview crop; unsupported message/image hosts retain explicit copy-and-share fallback');

    const rejected = await harness({ pageNumber: 2 }); await ready(rejected, 2); await selectText(rejected);
    await rejected.frame.getByRole('button', { name: '自定义提问', exact: true }).click();
    await rejected.frame.getByRole('textbox', { name: '向 Codex 提问', exact: true }).fill(customQuestion);
    rejected.setMessageResult({ isError: true });
    await rejected.frame.getByRole('button', { name: '发送问题', exact: true }).click();
    await expect(rejected.frame.locator('#question-status')).toContainText(/拒绝/);
    await expect(rejected.frame.getByRole('textbox', { name: '向 Codex 提问', exact: true })).toHaveValue(customQuestion);
    await expect(rejected.frame.getByRole('dialog', { name: '共享预览', exact: true })).toBeVisible();
    assert.equal(rejected.messages.length, 1);
    rejected.setMessageResult({ isError: false });
    await rejected.frame.getByRole('button', { name: '发送问题', exact: true }).click();
    await expect.poll(() => rejected.messages.length).toBe(2);
    await expect(rejected.frame.getByRole('dialog', { name: '共享预览', exact: true })).toBeHidden();
    assert.deepEqual(rejected.messages[0], rejected.messages[1], 'Only a manual retry may resend the same confirmed question');
    await rejected.close();

    const cancelled = await harness({ pageNumber: 2 }); await ready(cancelled, 2); await selectText(cancelled);
    const preparation = cancelled.holdNext(entry => entry.params?.name === 'paperdesk_reader_session' && entry.params.arguments.selection !== null);
    await cancelled.frame.getByRole('button', { name: '解释选区', exact: true }).click(); await preparation.entered;
    await expect(cancelled.frame.getByRole('button', { name: '解释选区', exact: true })).toBeDisabled();
    await cancelled.frame.getByRole('button', { name: '取消共享', exact: true }).click();
    preparation.release(); await preparation.finished;
    await expect.poll(async () => (await currentContext(cancelled)).selection).toBeNull();
    assert.equal(cancelled.messages.length, 0, 'Cancelling while preparation is in flight must stop the pending message');
    await cancelled.close();

    const uncertain = await harness({ pageNumber: 2, useClock: true }); await ready(uncertain, 2); await selectText(uncertain);
    const acknowledgement = uncertain.holdNext(entry => entry.method === 'ui/message');
    await uncertain.frame.getByRole('button', { name: '解释选区', exact: true }).click(); await acknowledgement.entered;
    await expect(uncertain.frame.getByRole('button', { name: '解释选区', exact: true })).toBeDisabled();
    await expect(uncertain.frame.getByRole('button', { name: '提炼要点', exact: true })).toBeDisabled();
    assert.equal(uncertain.messages.length, 1);
    await uncertain.page.clock.fastForward(15001);
    await expect(uncertain.frame.locator('#question-status')).toContainText(/未能确认.*查看当前对话/);
    await expect(uncertain.frame.getByRole('button', { name: '解释选区', exact: true })).toBeDisabled();
    acknowledgement.release(); await acknowledgement.finished;
    await expect(uncertain.frame.locator('#question-status')).toContainText('未能确认');
    await uncertain.frame.getByRole('button', { name: '取消共享', exact: true }).click();
    await expect(uncertain.frame.locator('#status')).toContainText('历史对话中的内容仍会保留');
    await expect.poll(async () => (await currentContext(uncertain)).selection).toBeNull();
    assert.equal(uncertain.messages.length, 1, 'Late acknowledgement and cancellation cannot resend or retract the accepted message');
    await uncertain.close();
    console.log('PASS: rejected questions keep editable drafts; cancelled preparation sends nothing; timeout and late acknowledgement never auto-resend');

    const refreshed = await harness({ pageNumber: 2 }); await ready(refreshed, 2);
    await refreshed.frame.getByRole('button', { name: '展开笔记', exact: true }).click();
    const refreshEditor = refreshed.frame.getByRole('textbox', { name: '笔记', exact: true });
    await expect(refreshEditor).toHaveValue(privateNotes);
    const append = async text => {
      const before = (await request(`/documents/${book.id}`)).document;
      const result = await request(`/documents/${book.id}/notes/append`, { text, expectedNotesRevision: before.notesRevision, requestId: randomUUID() });
      assert.equal(result.status, 200); return result.document;
    };
    const appended = await append('用户明确要求记录的回答');
    await refreshed.notify({ structuredContent: { documentId: book.id, appended: true, notesRevision: appended.notesRevision } });
    await expect(refreshEditor).toHaveValue(appended.notesZh);
    const manual = await append('由普通工具追加，随后手动刷新');
    await refreshed.frame.getByRole('button', { name: '刷新笔记', exact: true }).click();
    await expect(refreshEditor).toHaveValue(manual.notesZh);
    const retriedPayload = { text: '首次成功通知丢失后幂等重试的回答', expectedNotesRevision: manual.notesRevision, requestId: randomUUID() };
    const firstAttempt = await request(`/documents/${book.id}/notes/append`, retriedPayload);
    assert.equal(firstAttempt.status, 200); assert.equal(firstAttempt.appended, true);
    const retryAttempt = await request(`/documents/${book.id}/notes/append`, retriedPayload);
    assert.equal(retryAttempt.status, 200); assert.equal(retryAttempt.appended, false);
    assert.equal(retryAttempt.document.notesRevision, firstAttempt.document.notesRevision);
    await refreshed.notify({ structuredContent: { documentId: book.id, appended: false, notesRevision: retryAttempt.document.notesRevision } });
    await expect(refreshEditor).toHaveValue(retryAttempt.document.notesZh);
    // The append completes while clean; its host notification arrives after
    // typing starts. This models a real notification race without bypassing
    // the backend's protection against appends to a dirty session.
    const pendingNotice = await append('通知晚于编辑到达的已保存回答');
    const draft = `${retryAttempt.document.notesZh}\n\n必须保留的刷新中草稿`;
    await refreshEditor.fill(draft);
    await refreshed.frame.getByRole('button', { name: '刷新笔记', exact: true }).click();
    await expect(refreshEditor).toHaveValue(draft); await expect(refreshed.frame.locator('#error-box')).toContainText(/草稿|未保存/);
    await refreshed.notify({ structuredContent: { documentId: book.id, appended: true, notesRevision: pendingNotice.notesRevision } });
    await expect(refreshed.frame.locator('#note-error')).toContainText(/草稿未被替换/);
    await expect(refreshEditor).toHaveValue(draft);
    await refreshed.frame.getByRole('button', { name: '核对最新笔记', exact: true }).click();
    await expect(refreshed.frame.getByRole('textbox', { name: '最新已保存笔记', exact: true })).toHaveValue(pendingNotice.notesZh);
    await expect(refreshEditor).toHaveValue(draft);
    assert.equal((await request(`/documents/${book.id}`)).document.notesZh, pendingNotice.notesZh);
    assert.equal(refreshed.messages.length, 0, 'Refreshing private notes must not send conversation messages');
    assert.equal(refreshed.calls.some(call => call.params?.name === 'paperdesk_reader_save_notes'), false);
    await refreshed.close();
    console.log('PASS: explicit and append-triggered note refreshes update clean editors and preserve drafts when a notification arrives late');

    const staleNotes = await harness({ pageNumber: 2 }); await ready(staleNotes, 2);
    await staleNotes.frame.getByRole('button', { name: '展开笔记', exact: true }).click();
    const staleEditor = staleNotes.frame.getByRole('textbox', { name: '笔记', exact: true });
    await expect(staleEditor).toHaveValue(pendingNotice.notesZh);
    const heldRefresh = staleNotes.holdNext(entry => entry.params?.name === 'paperdesk_reader_get_notes');
    await staleNotes.frame.getByRole('button', { name: '刷新笔记', exact: true }).click(); await heldRefresh.entered;
    const newerEdit = `${pendingNotice.notesZh}\n\n刷新请求期间完成的新保存`;
    await staleEditor.fill(newerEdit); await staleNotes.frame.getByRole('button', { name: '保存笔记', exact: true }).click();
    await expect.poll(async () => (await request(`/documents/${book.id}`)).document.notesZh).toBe(newerEdit);
    await expect(staleNotes.frame.getByRole('button', { name: '保存笔记', exact: true })).toBeDisabled();
    const newerRevision = (await request(`/documents/${book.id}`)).document.notesRevision;
    heldRefresh.release(); await heldRefresh.finished;
    await expect(staleNotes.frame.getByRole('button', { name: '刷新笔记', exact: true })).toBeEnabled();
    await expect(staleEditor).toHaveValue(newerEdit);
    const nextEdit = `${newerEdit}\n\n后续编辑仍使用新版本`;
    await staleEditor.fill(nextEdit); await staleNotes.frame.getByRole('button', { name: '保存笔记', exact: true }).click();
    await expect.poll(async () => (await request(`/documents/${book.id}`)).document.notesZh).toBe(nextEdit);
    assert.equal(staleNotes.calls.filter(call => call.params?.name === 'paperdesk_reader_save_notes').at(-1).params.arguments.expectedNotesRevision, newerRevision);
    await staleNotes.close();

    const initialNotes = await harness({ pageNumber: 2, holdInitialNotes: true }); await ready(initialNotes, 2); await initialNotes.initialNotesHold.entered;
    await initialNotes.frame.getByRole('button', { name: '展开笔记', exact: true }).click();
    const initialEditor = initialNotes.frame.getByRole('textbox', { name: '笔记', exact: true });
    const firstAppend = await append('首次笔记读取未返回时到达的追加');
    await initialNotes.notify({ structuredContent: { documentId: book.id, appended: true, notesRevision: firstAppend.notesRevision } });
    await expect(initialEditor).toHaveValue(firstAppend.notesZh);
    initialNotes.initialNotesHold.release(); await initialNotes.initialNotesHold.finished;
    await initialNotes.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(initialEditor).toHaveValue(firstAppend.notesZh);
    assert.equal(initialNotes.calls.some(call => call.params?.name === 'paperdesk_reader_save_notes'), false);
    await initialNotes.close();
    console.log('PASS: late note reads cannot roll back a newer manual save or an append received during initial loading');

    const prepareChatGPT = async h => {
      await h.frame.getByRole('button', { name: '交给 ChatGPT', exact: true }).click();
      const section = h.frame.getByRole('region', { name: 'ChatGPT 提问准备', exact: true });
      await expect(section).toBeVisible();
      if (!await section.locator('details').evaluate(element => element.open)) await section.locator('summary').filter({ hasText: '手动备用方式' }).click();
      return section;
    };
    const assertHandoffPrivate = async h => {
      assert.equal(h.messages.length, 0, 'Manual ChatGPT handoff must never start a Codex reply');
      assert.equal(h.updates.length, 0, 'Manual ChatGPT handoff must not inject anything into Codex context');
      assert.equal((await currentContext(h)).selection, null);
      assert.ok(h.calls.filter(call => call.params?.name === 'paperdesk_reader_session').every(call => call.params.arguments.selection === null));
      assert.deepEqual(h.network, [h.url], 'No document context may be carried in a remote network request');
      assert.equal(h.calls.some(call => /save_notes|append_note/.test(call.params?.name || '')), false);
    };
    const handoffText = await harness({ pageNumber: 2, failClipboard: true }); await ready(handoffText, 2); await selectText(handoffText);
    let handoffSection = await prepareChatGPT(handoffText);
    let portablePrompt = handoffSection.getByRole('textbox', { name: '准备给 ChatGPT 的问题', exact: true });
    let portableQuestion = handoffSection.getByRole('textbox', { name: '向 ChatGPT 提问', exact: true });
    await expect(portablePrompt).toHaveAttribute('readonly', '');
    await expect(portableQuestion).toHaveAttribute('maxlength', '4000');
    assertHandoffPrompt(await portablePrompt.inputValue(), { title: book.title, page: 2, quote: 'A short introduction', excluded: [book.id, handoffText.sessionId(), privateNotes, 'for navigation checks.'] });
    await portableQuestion.fill(' \n ');
    await expect(handoffSection.getByRole('button', { name: '复制 ChatGPT 提问', exact: true })).toBeDisabled();
    const handoffQuestion = '只解释选区中的条件 α < β，不读取其他资料。';
    await portableQuestion.fill(handoffQuestion);
    assert.ok((await portablePrompt.inputValue()).includes(handoffQuestion));
    await handoffSection.getByRole('button', { name: '复制 ChatGPT 提问', exact: true }).click();
    await expect(handoffText.frame.locator('#chatgpt-status')).toContainText(/手动复制/);
    assert.equal(await portablePrompt.evaluate(element => element.selectionStart === 0 && element.selectionEnd === element.value.length), true);
    await handoffSection.getByRole('button', { name: '打开 ChatGPT', exact: true }).click();
    await expect.poll(() => handoffText.links.length).toBe(1);
    assert.deepEqual(handoffText.links[0], { url: 'https://chatgpt.com/' }, 'Opening ChatGPT must not append a prompt, document ID, query or fragment to the URL');
    await assertHandoffPrivate(handoffText);
    await handoffText.page.frames()[1].evaluate(() => { window.handoffClipboard.mode = 'hold'; });
    await handoffSection.getByRole('button', { name: '复制 ChatGPT 提问', exact: true }).click();
    await expect.poll(() => handoffText.page.frames()[1].evaluate(() => window.handoffClipboard.pending.length)).toBe(1);
    const clipboardCalls = await handoffText.page.frames()[1].evaluate(() => window.handoffClipboard.calls.length);
    await handoffText.frame.getByRole('button', { name: '取消共享', exact: true }).click();
    await expect(handoffSection).toBeHidden();
    await handoffText.frame.getByRole('button', { name: '下一页', exact: true }).click(); await ready(handoffText, 3);
    await selectText(handoffText, 'Scope is a child of Introduction.');
    handoffSection = await prepareChatGPT(handoffText);
    portableQuestion = handoffSection.getByRole('textbox', { name: '向 ChatGPT 提问', exact: true });
    await expect(portableQuestion).not.toHaveValue(handoffQuestion);
    assertHandoffPrompt(await handoffSection.getByRole('textbox', { name: '准备给 ChatGPT 的问题', exact: true }).inputValue(), { title: book.title, page: 3, quote: 'Scope is a child of Introduction.', excluded: [handoffQuestion, 'A short introduction'] });
    await expect(handoffSection.getByRole('button', { name: '复制 ChatGPT 提问', exact: true })).toBeDisabled();
    const pendingStatus = await handoffText.frame.locator('#chatgpt-status').textContent();
    const pendingPrompt = await handoffSection.getByRole('textbox', { name: '准备给 ChatGPT 的问题', exact: true }).inputValue();
    await handoffText.page.frames()[1].evaluate(() => { window.handoffClipboard.pending.shift()(); window.handoffClipboard.mode = 'reject'; });
    await expect(handoffSection.getByRole('button', { name: '复制 ChatGPT 提问', exact: true })).toBeEnabled();
    assert.match(pendingStatus, /等待上次复制/);
    await expect(handoffText.frame.locator('#chatgpt-status')).toHaveText('');
    await expect(handoffSection.getByRole('textbox', { name: '准备给 ChatGPT 的问题', exact: true })).toHaveValue(pendingPrompt);
    assert.equal(await handoffText.page.frames()[1].evaluate(() => window.handoffClipboard.calls.length), clipboardCalls, 'A new page cannot overlap clipboard writes or be overwritten by an old completion');
    await assertHandoffPrivate(handoffText); await handoffText.close();

    const handoffRegion = await harness({ documentId: scan.id, failClipboard: true }); await ready(handoffRegion, 1);
    await handoffRegion.frame.getByRole('button', { name: '框选区域', exact: true }).click(); await drag(handoffRegion, [.5, .36], [.15, .18]);
    const handoffPng = await handoffRegion.frame.getByRole('img', { name: '选区预览', exact: true }).getAttribute('src');
    const handoffPageSize = await image(handoffRegion, 1).evaluate(element => ({ width: element.naturalWidth, height: element.naturalHeight }));
    handoffSection = await prepareChatGPT(handoffRegion);
    assertHandoffPrompt(await handoffSection.getByRole('textbox', { name: '准备给 ChatGPT 的问题', exact: true }).inputValue(), { title: scan.title, page: 1, excluded: [scan.id, handoffRegion.sessionId(), privateNotes] });
    handoffRegion.setDownloadResult({ isError: true });
    await handoffSection.getByRole('button', { name: '保存选区图片', exact: true }).click();
    await expect.poll(() => handoffRegion.downloads.length).toBe(1);
    await expect(handoffRegion.frame.locator('#chatgpt-status')).toContainText(/拒绝|取消|未.*保存|未.*下载/);
    await expect(handoffSection).toBeVisible();
    await expect(handoffRegion.frame.getByRole('img', { name: '选区预览', exact: true })).toHaveAttribute('src', handoffPng);
    handoffRegion.setDownloadResult({ isError: false });
    await handoffSection.getByRole('button', { name: '保存选区图片', exact: true }).click();
    await expect.poll(() => handoffRegion.downloads.length).toBe(2);
    const downloadedResource = handoffRegion.downloads[1].contents[0].resource;
    assert.equal(downloadedResource.uri, 'file:///paperdesk-page-1-selection.png');
    assert.equal(downloadedResource.mimeType, 'image/png');
    assertCropPng(Buffer.from(downloadedResource.blob, 'base64'), handoffPng, handoffPageSize);
    await expect(handoffRegion.frame.locator('#chatgpt-status')).toContainText('宿主已接受');
    await expect(handoffRegion.frame.locator('#chatgpt-status')).toContainText('确认文件已保存');
    await expect(handoffRegion.frame.locator('#chatgpt-image-fallback')).toBeHidden();
    await onChatGPTPreview?.(handoffRegion.page);
    await assertHandoffPrivate(handoffRegion);
    const portableBeforeHide = await handoffSection.getByRole('textbox', { name: '准备给 ChatGPT 的问题', exact: true }).inputValue();
    const handoffVisibility = value => handoffRegion.page.frames()[1].evaluate(state => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    }, value);
    // Sandbox lifecycle simulation: opening another app must not discard the
    // local handoff snapshot, although no model-shared selection may survive.
    await handoffVisibility('hidden');
    await expect.poll(async () => (await currentContext(handoffRegion)).status).toBe(404);
    await handoffVisibility('visible');
    await expect.poll(async () => (await currentContext(handoffRegion)).status).toBe(200);
    await expect(handoffSection).toBeVisible();
    await expect(handoffSection.getByRole('textbox', { name: '准备给 ChatGPT 的问题', exact: true })).toHaveValue(portableBeforeHide);
    await expect(handoffRegion.frame.getByRole('img', { name: '选区预览', exact: true })).toHaveAttribute('src', handoffPng);
    await assertHandoffPrivate(handoffRegion);
    await handoffRegion.frame.getByRole('button', { name: '取消共享', exact: true }).click();
    await handoffRegion.frame.getByRole('button', { name: '下一页', exact: true }).click(); await ready(handoffRegion, 2);
    await drag(handoffRegion, [.2, .25], [.65, .45]); handoffSection = await prepareChatGPT(handoffRegion);
    assert.notEqual(await handoffRegion.frame.getByRole('img', { name: '选区预览', exact: true }).getAttribute('src'), handoffPng);
    assertHandoffPrompt(await handoffSection.getByRole('textbox', { name: '准备给 ChatGPT 的问题', exact: true }).inputValue(), { title: scan.title, page: 2, excluded: [scan.id] });
    await assertHandoffPrivate(handoffRegion); await handoffRegion.close();
    console.log('PASS: native ChatGPT handoff stays private, opens only the fixed URL and downloads the exact preview through the SDK resource schema');

    const { downloadFile: _downloadCapability, openLinks: _openCapability, ...noExportCapabilities } = fullCapabilities;
    const noExport = await harness({ documentId: scan.id, capabilities: noExportCapabilities }); await ready(noExport, 1);
    await noExport.frame.getByRole('button', { name: '框选区域', exact: true }).click(); await drag(noExport, [.15, .18], [.5, .36]);
    handoffSection = await prepareChatGPT(noExport);
    await handoffSection.getByRole('button', { name: '保存选区图片', exact: true }).click();
    await expect(noExport.frame.locator('#chatgpt-status')).toContainText('尚未保存');
    await expect(noExport.frame.getByRole('button', { name: '在浏览器保存图片', exact: true })).toBeVisible();
    await expect(noExport.frame.getByRole('img', { name: '选区预览', exact: true })).toBeVisible();
    assert.equal(noExport.downloads.length, 0);
    await handoffSection.getByRole('button', { name: '打开 ChatGPT', exact: true }).click();
    await expect(noExport.frame.getByRole('textbox', { name: 'ChatGPT 网址', exact: true })).toHaveValue('https://chatgpt.com/');
    assert.equal(noExport.links.length, 0);
    await assertHandoffPrivate(noExport); await noExport.close();
    console.log('PASS: absent native download/open capabilities retain the preview and offer truthful manual browser fallbacks');

    if (chatgptFixture) {
      // This is the same private native panel, with real SDK calls to the local
      // queue. Only its external executor is simulated; never start EGO here.
      const automatic = await harness({ documentId: book.id, pageNumber: 2 }); await ready(automatic, 2);
      const beforeNotes = (await request(`/documents/${book.id}`)).document.notesRevision;
      await selectText(automatic);
      const automaticSection = automatic.frame.getByRole('region', { name: 'ChatGPT 提问准备', exact: true });
      await automaticSection.getByRole('textbox', { name: '向 ChatGPT 提问', exact: true }).fill('模拟原生选文解释。');
      await automaticSection.getByRole('button', { name: '向 ChatGPT 提问', exact: true }).click();
      const submitCalls = () => automatic.calls.filter(call => call.params?.name === 'paperdesk_reader_chatgpt_submit');
      await expect.poll(() => submitCalls().length).toBe(1);
      const submitted = submitCalls()[0].params.arguments;
      assert.deepEqual(submitted.selection, { kind: 'text', text: 'A short introduction' });
      assert.equal(submitted.documentId, book.id); assert.equal(submitted.page, 2);
      const textRun = await chatgptFixture.runFor(submitted.requestId);
      await textRun.emit({ state: 'waiting', dispatchInvoked: true });
      await automatic.frame.getByRole('button', { name: '取消共享', exact: true }).click();
      await automatic.frame.getByRole('button', { name: '下一页', exact: true }).click(); await ready(automatic, 3);
      textRun.finish({ state: 'completed', response: '模拟原生回答，仅对应第 2 页的选文。' });
      await expect(automatic.frame.getByRole('dialog', { name: '共享预览', exact: true })).toBeHidden();
      await automatic.frame.getByRole('button', { name: '查看回答', exact: true }).click();
      const answerDialog = automatic.frame.getByRole('dialog', { name: 'ChatGPT 回答', exact: true });
      await expect(answerDialog.getByRole('textbox', { name: 'ChatGPT 回答', exact: true })).toHaveValue('模拟原生回答，仅对应第 2 页的选文。');
      await expect(answerDialog).toContainText('PDF 第 2 页');
      assert.equal(submitCalls().length, 1);
      await assertHandoffPrivate(automatic);
      assert.equal((await request(`/documents/${book.id}`)).document.notesRevision, beforeNotes);
      for (const call of automatic.calls.filter(call => call.params?.name?.startsWith('paperdesk_reader_chatgpt_') && call.result)) {
        assert.deepEqual(call.result.structuredContent, { ok: true });
        assert.ok(call.result._meta.chatgptJob);
        const modelVisible = JSON.stringify({ content: call.result.content, structuredContent: call.result.structuredContent });
        assert.doesNotMatch(modelVisible, /模拟原生|A short introduction|PRIVATE/);
      }
      await automatic.close();

      const automaticRegion = await harness({ documentId: scan.id }); await ready(automaticRegion, 1);
      await automaticRegion.frame.getByRole('button', { name: '框选区域', exact: true }).click(); await drag(automaticRegion, [.5, .36], [.15, .18]);
      const automaticPng = await automaticRegion.frame.getByRole('img', { name: '选区预览', exact: true }).getAttribute('src');
      const automaticPageSize = await image(automaticRegion, 1).evaluate(element => ({ width: element.naturalWidth, height: element.naturalHeight }));
      await automaticRegion.frame.getByRole('button', { name: '向 ChatGPT 提问', exact: true }).click();
      await expect.poll(() => automaticRegion.calls.some(call => call.params?.name === 'paperdesk_reader_chatgpt_submit')).toBe(true);
      const regionArgs = automaticRegion.calls.find(call => call.params?.name === 'paperdesk_reader_chatgpt_submit').params.arguments;
      assert.deepEqual(regionArgs.selection, { kind: 'region', text: '', preview: automaticPng });
      const regionRun = await chatgptFixture.runFor(regionArgs.requestId);
      assertCropPng(Buffer.from(regionRun.job.selection.preview.split(',')[1], 'base64'), automaticPng, automaticPageSize);
      regionRun.finish({ state: 'needs_user', canResume: true, message: '模拟需要用户处理。' });
      await automaticRegion.frame.locator('#preview-view-answers').click();
      const regionAnswer = automaticRegion.frame.getByRole('dialog', { name: 'ChatGPT 回答', exact: true });
      await expect(regionAnswer.getByRole('button', { name: '我已完成，继续连接', exact: true })).toBeVisible();
      assert.equal(automaticRegion.calls.some(call => call.params?.name === 'paperdesk_reader_chatgpt_resume'), false);
      await regionAnswer.getByRole('button', { name: '我已完成，继续连接', exact: true }).click();
      const resumed = await chatgptFixture.runFor(regionArgs.requestId, { resume: true });
      resumed.finish({ state: 'completed', response: '模拟图形回答。', dispatchInvoked: true });
      await expect(regionAnswer.getByRole('textbox', { name: 'ChatGPT 回答', exact: true })).toHaveValue('模拟图形回答。');
      assert.equal(automaticRegion.calls.filter(call => call.params?.name === 'paperdesk_reader_chatgpt_submit').length, 1);
      assert.equal(automaticRegion.calls.filter(call => call.params?.name === 'paperdesk_reader_chatgpt_resume').length, 1);
      await assertHandoffPrivate(automaticRegion); await automaticRegion.close();
      const inline = await harness({ documentId: book.id, pageNumber: 2 }); await ready(inline, 2); await selectText(inline);
      await inline.frame.getByRole('button', { name: '向 ChatGPT 提问', exact: true }).click();
      await expect.poll(() => inline.calls.some(call => call.params?.name === 'paperdesk_reader_chatgpt_submit')).toBe(true);
      const inlineId = inline.calls.find(call => call.params?.name === 'paperdesk_reader_chatgpt_submit').params.arguments.requestId;
      const completeReply = '模拟内联完整回答。\n\n第二段继续保留，回答不会写入笔记。';
      (await chatgptFixture.runFor(inlineId)).finish({ state: 'completed', response: completeReply, dispatchInvoked: true });
      const inlineReply = inline.frame.getByRole('dialog', { name: '共享预览', exact: true }).getByRole('textbox', { name: 'ChatGPT 回答预览', exact: true });
      await expect(inlineReply).toBeVisible(); await expect(inlineReply).toHaveAttribute('readonly', ''); await expect(inlineReply).toHaveValue(completeReply);
      assert.equal((await request(`/documents/${book.id}`)).document.notesRevision, beforeNotes);
      await assertHandoffPrivate(inline); await inline.close();
      console.log('PASS: opaque native automatic ChatGPT uses private MCP job results, exact text/crop snapshots and explicit resume without Codex messages or context');
    }

    for (const item of harnesses) assert.deepEqual(item.errors, [], 'Native reader must not raise uncaught browser exceptions');
    assert.equal(stderr, '', 'Native MCP transport must keep stderr quiet');
  } finally {
    await Promise.allSettled(harnesses.map(item => item.close()));
    await client?.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}
