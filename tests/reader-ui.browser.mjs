import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bookmarkedPdf } from './fixtures/toc-browser.mjs';
import { graphicsOnlyPdf } from './fixtures/scan-browser.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fullCapabilities = { serverTools: {}, updateModelContext: { text: {}, image: {}, structuredContent: {} }, message: { text: {}, image: {} }, openLinks: {} };
const hasContext = value => Boolean(value?.content?.length || value?.structuredContent);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Real MCP transport, real isolated API, and a browser sandbox that cannot fetch
// the local service. Only the parent host's tools/call bridge crosses that gap.
export async function nativeReaderWorkflow({ context, base, onQuestionPreview, onLibraryPreview }) {
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
    const displayTools = new Set(['paperdesk_reader_page', 'paperdesk_reader_get_notes', 'paperdesk_reader_save_notes', 'paperdesk_reader_toc', 'paperdesk_reader_session', 'paperdesk_reader_close', 'paperdesk_reader_library', 'paperdesk_reader_organize', 'paperdesk_reader_theme']);
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

    async function harness({ documentId = book.id, pageNumber = 1, capabilities = fullCapabilities, failOpenLink = false, libraryOnly = false, useClock = false, holdInitialNotes = false } = {}) {
      const page = await context.newPage(); await page.setViewportSize({ width: 1500, height: 1100 });
      if (useClock) await page.clock.install();
      const item = { page, close: () => page.close() }; harnesses.push(item);
      const calls = [], updates = [], messages = [], links = [], errors = [], network = [], holds = [];
      let initialized = false, messageResult = { isError: false };
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
        if (message.method === 'ui/initialize') {
          assert.deepEqual(message.params.appInfo, { name: 'paperdesk-reader', version: '0.8.0' });
          result = { protocolVersion: '2026-01-26', hostInfo: { name: 'isolated-browser-host', version: '1.0.0' }, hostCapabilities: capabilities };
        }
        else if (message.method === 'ui/notifications/initialized') { initialized = true; return; }
        else if (message.method === 'tools/call') result = await client.callTool(message.params);
        else if (message.method === 'ui/update-model-context') { updates.push(message.params); result = {}; }
        else if (message.method === 'ui/message') {
          assert.equal(message.params.role, 'user'); assert.ok(Array.isArray(message.params.content));
          messages.push(message.params); result = messageResult;
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
      Object.assign(item, { page, frame, calls, updates, messages, links, errors, network, url, holdNext, initialNotesHold,
        setMessageResult(value) { messageResult = value; },
        sessionId: () => calls.filter(call => call.method === 'tools/call' && call.params.name === 'paperdesk_reader_session').at(-1)?.params.arguments.sessionId,
        async notify(result) { await page.evaluate(value => document.getElementById('native-panel').contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: value }, '*'), result); },
        async close() { for (const hold of holds) hold.release.resolve(); if (!page.isClosed()) { await page.evaluate(() => document.getElementById('native-panel').contentWindow.postMessage({ jsonrpc: '2.0', id: 'test-teardown', method: 'ui/resource-teardown', params: {} }, '*')).catch(() => {}); await expect.poll(() => page.evaluate(() => window.nativeMessages.some(message => message.id === 'test-teardown' && !message.method)), { timeout: 5000 }).toBe(true).catch(() => {}); await page.close(); } },
      });
      return item;
    }
    const image = (h, number) => h.frame.getByRole('img', { name: `PDF 第 ${number} 页`, exact: true });
    async function ready(h, number) {
      await expect(image(h, number)).toBeVisible();
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
    assert.equal(landing.calls.some(entry => entry.method === 'tools/call' && !['paperdesk_list_documents', 'paperdesk_reader_library'].includes(entry.params.name)), false, 'An empty open request may list library metadata but must not automatically render, read notes or create a reader session');
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
    await expect(notes).toHaveCount(1);
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

    const organizing = await harness({ pageNumber: 2 }); await ready(organizing, 2);
    await organizing.frame.getByRole('button', { name: '展开笔记', exact: true }).click();
    const organizingNotes = organizing.frame.getByRole('textbox', { name: '笔记', exact: true });
    const savedBeforeOrganizing = (await request(`/documents/${book.id}`)).document;
    const retainedDraft = savedBeforeOrganizing.notesZh + '\n\n整理文件夹时必须保留的未保存草稿';
    await organizingNotes.fill(retainedDraft);
    const categories = organizing.frame.getByRole('navigation', { name: '文献分类', exact: true });
    await organizing.frame.getByRole('button', { name: '新建文件夹', exact: true }).click();
    await organizing.frame.getByRole('textbox', { name: '文件夹名称', exact: true }).fill('原生文件夹验收');
    await organizing.frame.getByRole('button', { name: '保存文件夹', exact: true }).click();
    const folderTarget = categories.getByRole('button', { name: '原生文件夹验收', exact: true });
    await expect(folderTarget).toBeVisible();
    const folderId = (await request('/library')).folders.find(folder => folder.name === '原生文件夹验收').id;
    await categories.getByRole('button', { name: '全部文献', exact: true }).click();
    await organizing.frame.locator(`[data-document-id="${book.id}"]`).dragTo(folderTarget);
    await expect.poll(async () => (await request(`/documents/${book.id}`)).document.folderId).toBe(folderId);
    await expect(organizingNotes).toHaveValue(retainedDraft);
    await expect(image(organizing, 2)).toBeVisible();
    await categories.getByRole('button', { name: '原生文件夹验收', exact: true }).click();
    await expect(organizing.frame.getByRole('button', { name: scan.title, exact: true })).toHaveCount(0);
    await organizing.frame.getByRole('button', { name: '重命名文件夹', exact: true }).click();
    await organizing.frame.getByRole('textbox', { name: '文件夹名称', exact: true }).fill('原生重命名验收');
    await organizing.frame.getByRole('button', { name: '保存文件夹', exact: true }).click();
    await expect(categories.getByRole('button', { name: '原生重命名验收', exact: true })).toBeVisible();
    await organizing.frame.locator(`[data-document-id="${book.id}"]`).dragTo(categories.getByRole('button', { name: '未分类', exact: true }));
    await expect.poll(async () => (await request(`/documents/${book.id}`)).document.folderId).toBeNull();
    await categories.getByRole('button', { name: '全部文献', exact: true }).click();
    await organizing.frame.getByRole('combobox', { name: `移动到：${book.title}`, exact: true }).selectOption(folderId);
    await expect.poll(async () => (await request(`/documents/${book.id}`)).document.folderId).toBe(folderId);
    const themeSelect = organizing.frame.getByRole('combobox', { name: '阅读皮肤', exact: true });
    await themeSelect.selectOption('night');
    await expect.poll(async () => (await request('/library')).theme).toBe('night');
    await expect(organizing.frame.locator('html')).toHaveAttribute('data-theme', 'night');
    await expect(organizingNotes).toHaveValue(retainedDraft);
    await onLibraryPreview?.({ page: organizing.page, theme: 'night' });
    const reopened = await harness({ libraryOnly: true });
    await expect(reopened.frame.getByRole('combobox', { name: '阅读皮肤', exact: true })).toHaveValue('night');
    await expect(reopened.frame.getByRole('navigation', { name: '文献分类' }).getByRole('button', { name: '原生重命名验收', exact: true })).toBeVisible();
    await reopened.close();
    await categories.getByRole('button', { name: '原生重命名验收', exact: true }).click();
    await organizing.frame.getByRole('button', { name: '删除文件夹', exact: true }).click();
    await organizing.frame.getByRole('dialog', { name: '删除文件夹', exact: true }).getByRole('button', { name: '确认删除文件夹', exact: true }).click();
    await expect.poll(async () => (await request(`/documents/${book.id}`)).document.folderId).toBeNull();
    await expect(organizingNotes).toHaveValue(retainedDraft);
    assert.equal((await request(`/documents/${book.id}`)).document.notesRevision, savedBeforeOrganizing.notesRevision);
    assert.equal(organizing.calls.some(call => call.params?.name === 'paperdesk_reader_save_notes'), false);
    assert.equal(organizing.messages.length, 0);
    assert.equal(organizing.updates.some(hasContext), false);
    await themeSelect.selectOption('forest');
    await expect.poll(async () => (await request('/library')).theme).toBe('forest');
    await organizing.close();
    console.log('PASS: native folder drag, rename, keyboard moves, safe removal and persisted themes preserve unsaved notes and private display');

    for (const item of harnesses) {
      assert.deepEqual(item.errors, [], 'Native reader must not raise uncaught browser exceptions');
      assert.equal(item.calls.some(call => /^paperdesk_reader_chatgpt_/.test(call.params?.name || '')), false);
      assert.ok(item.links.every(link => new URL(link.url).origin === new URL(base).origin), 'Reader links must stay within the local workspace');
    }
    assert.equal(stderr, '', 'Native MCP transport must keep stderr quiet');
  } finally {
    await Promise.allSettled(harnesses.map(item => item.close()));
    await client?.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}
