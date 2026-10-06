import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
import { buildBridgePrompt, inspectChatDom } from '../server/chatgpt-ego.mjs';

// Synthetic mounted DOM only. This does not open ChatGPT, call EGO, send a
// message, or prove compatibility with a live account or future website build.
const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const binding = { documentEpoch: 'fixture-document', modelEpoch: 'fixture-model', creationOrdinary: true, chatId: conversationId, runKey: 'synthetic-chat' };
const selection = '  α = β\n保持原始空白与 "JSON" 引号 🧪\n  ';
const prompt = buildBridgePrompt({ title: '原创合成资料', page: 7, question: '请解释公式。', selection: { kind: 'text', text: selection } });

const fixtureHtml = `<!doctype html><meta charset="utf-8"><title>Synthetic Chat DOM</title>
<style>body{font:16px sans-serif} [hidden]{display:none!important} [data-user-message-bubble]{white-space:pre-wrap} .sr-only{position:absolute;width:1px;height:1px;overflow:hidden}</style>
<main>
  <form data-chatgpt-composer hidden id="home-composer"><div contenteditable="true" role="textbox">Hidden home composer</div></form>
  <div id="thread">
    <div id="user-group">
      <div data-chatgpt-search-unit-key="fixture:user" data-chatgpt-search-message-ids="user-1 user-1"><div data-user-message-bubble></div></div>
      <div class="turn-action-controls"><button aria-label="Copy message">User copy control</button></div>
    </div>
    <div id="assistant-group">
      <div data-chatgpt-search-unit-key="fixture:assistant" data-chatgpt-search-message-ids="assistant-1 assistant-1">
        <div data-chatgpt-selection-conversation-id="${conversationId}"></div>
        <div data-markdown-text-style="assistant-message"><h2>合成公式回答</h2><p>设 <span data-math-source="I = C \\frac{dV}{dt}" data-math-display="false"><span class="katex-mathml"><math><mi>MATHML_DUPLICATE</mi></math></span><span>VISUAL_MATH_DUPLICATE</span></span>，<strong>仅一次公式</strong>。</p><p data-math-source="V_o = A V_i" data-math-display="true">DISPLAY_DUPLICATE</p><div class="code-block"><button aria-label="Copy">Copy</button><pre><code>const value = 1;</code></pre></div></div>
      </div>
      <div id="response-actions" class="turn-action-controls"><button aria-label="Copy response">Response copy control</button></div>
    </div>
  </div>
  <div role="group" aria-label="Composer mode"><button id="chat-mode" aria-pressed="true">Chat</button><button id="work-mode" aria-pressed="false">Work</button></div>
  <form data-chatgpt-composer id="thread-composer">
    <div data-above-composer-conversation-id="chatgpt:${conversationId}"></div>
    <div contenteditable="true" role="textbox" aria-label="询问 ChatGPT"></div>
    <button type="button" aria-label="选择 ChatGPT 模型" aria-expanded="false">Extra High</button>
    <button type="button" aria-label="Send">Send</button>
  </form>
</main>`;

test('synthetic Chat DOM proofs and answer extraction', { timeout: 30000 }, async t => {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixtureHtml); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  const load = async (url = `/c/${conversationId}`) => {
    await page.goto(base + url);
    await page.evaluate(({ prompt, binding }) => {
      document.querySelector('[data-user-message-bubble]').textContent = prompt;
      const editor = document.querySelector('#thread-composer [contenteditable]');
      window.__paperdeskChatDocument = { epoch: binding.documentEpoch, editor };
      window.__paperdeskChatModel = { epoch: binding.modelEpoch, button: document.querySelector('#thread-composer [aria-label="选择 ChatGPT 模型"]'), invalid: false };
    }, { prompt, binding });
  };
  const inspect = (proof = binding) => page.evaluate(inspectChatDom, proof);
  const usableProof = state => state.routeMatches && state.ordinaryChat && !state.auth && !state.blocking && state.sameDocument && state.sameComposer && state.forms === 1 && state.editors === 1;
  const addImage = async (target, composer = false) => page.evaluate(async ({ target, composer }) => {
    const canvas = document.createElement('canvas'); canvas.width = 3; canvas.height = 2;
    const context = canvas.getContext('2d'); context.fillStyle = '#3567ab'; context.fillRect(0, 0, 3, 2);
    const image = document.createElement('img'); image.src = canvas.toDataURL('image/png'); image.width = 30; image.height = 20;
    const container = document.querySelector(target);
    if (composer) {
      const wrapper = document.createElement('div'); wrapper.setAttribute('data-composer-attachments', '');
      const card = document.createElement('div'); card.className = 'composer-attachment-surface'; card.setAttribute('role', 'button'); card.setAttribute('aria-label', 'selection.png');
      card.append(image); wrapper.append(card); container.append(wrapper);
      window.__paperdeskChatAttachment = { card, image, src: image.getAttribute('src'), name: 'selection.png' };
    } else container.append(image);
    await image.decode();
  }, { target, composer });

  await t.test('current message IDs, hidden home composer, and outer response action identify exactly one complete answer', async () => {
    await load(); const state = await inspect();
    assert.equal(state.forms, 1); assert.equal(state.editors, 1);
    assert.equal(state.sameComposer, true); assert.equal(state.modelValid, true);
    assert.equal(state.ordinaryChat, true); assert.equal(state.groupChat, true); assert.equal(usableProof(state), true);
    assert.deepEqual(state.turns.map(turn => [turn.role, turn.id]), [['user', 'user-1'], ['assistant', 'assistant-1']]);
    assert.equal(state.turns[0].text, prompt, 'The full prompt and JSON-encoded selected text must be preserved');
    assert.ok(state.turns[0].text.includes(JSON.stringify(selection)));
    assert.equal(state.responseId, 'assistant-1'); assert.equal(state.terminal, true); assert.equal(state.pending, false);
    assert.deepEqual(state.terminalButtons, ['Copy response']);
    assert.equal(state.localConversationId, conversationId); assert.equal(state.responseConversationId, conversationId);
  });

  await t.test('Markdown and math source are extracted once without visual or MathML duplicates or action labels', async () => {
    await load(); const { response } = await inspect();
    assert.match(response, /^## 合成公式回答/);
    assert.equal(response.split(String.raw`$I = C \frac{dV}{dt}$`).length - 1, 1);
    assert.equal(response.split('$$V_o = A V_i$$').length - 1, 1);
    assert.ok(response.includes('**仅一次公式**')); assert.ok(response.includes('```\nconst value = 1;\n```'));
    for (const excluded of ['MATHML_DUPLICATE', 'VISUAL_MATH_DUPLICATE', 'DISPLAY_DUPLICATE', 'Copy', 'Response copy control', 'User copy control']) assert.ok(!response.includes(excluded), excluded);
  });

  await t.test('user Copy message and code Copy alone are not response completion; busy response remains pending', async () => {
    await load();
    await page.locator('#response-actions').evaluate(node => node.remove());
    let state = await inspect(); assert.equal(state.terminal, false);
    await load();
    await page.locator('#assistant-group [data-markdown-text-style]').evaluate(node => node.setAttribute('aria-busy', 'true'));
    state = await inspect(); assert.equal(state.terminal, true); assert.equal(state.pending, true);
  });

  await t.test('multiple assistant messages or ambiguous message IDs cannot provide a unique answer', async () => {
    await load();
    await page.locator('[data-chatgpt-search-unit-key="fixture:assistant"]').evaluate(node => node.after(node.cloneNode(true)));
    let state = await inspect(); assert.equal(state.response, ''); assert.equal(state.responseId, ''); assert.equal(state.terminal, false);
    await load();
    await page.locator('[data-chatgpt-search-unit-key="fixture:assistant"]').evaluate(node => node.setAttribute('data-chatgpt-search-message-ids', 'assistant-1 assistant-2'));
    state = await inspect(); assert.equal(state.responseId, '');
  });

  await t.test('pending local and WEB routes never become canonical chat IDs, and unrelated routes do not match', async () => {
    const localConversationId = 'local-chatgpt:synthetic-owned';
    await load('/c/' + encodeURIComponent(localConversationId));
    let state = await inspect({ ...binding, localConversationId });
    assert.equal(state.savedId, null); assert.equal(state.routeMatches, true);
    state = await inspect({ ...binding, localConversationId: 'local-chatgpt:another-task' });
    assert.equal(state.savedId, null); assert.equal(state.routeMatches, false);
    await load('/c/WEB%3Asynthetic-pending');
    state = await inspect(); assert.equal(state.savedId, null); assert.equal(state.routeMatches, true);
    await load('/c/unknown-route');
    state = await inspect(); assert.equal(state.savedId, null); assert.equal(state.routeMatches, false);
    await load('/c/%E0%A4%A');
    state = await inspect(); assert.equal(state.savedId, null); assert.equal(state.routeMatches, false);
    await load('/c/ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    state = await inspect(); assert.equal(state.savedId, 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee'); assert.equal(state.routeMatches, false);
    await load(); state = await inspect(); assert.equal(state.savedId, conversationId); assert.equal(state.routeMatches, true);
  });

  await t.test('image cards identify aria-only filenames, report upload activity, and bind the same card and image identity', async () => {
    await load(); await addImage('#thread-composer', true);
    let state = await inspect();
    assert.equal(await page.locator('.composer-attachment-surface').innerText(), '');
    assert.equal(state.attachments.length, 1); assert.equal(state.attachmentText, 'selection.png');
    assert.equal(state.attachments[0].label, 'selection.png'); assert.equal(state.attachments[0].busy, false); assert.equal(state.attachmentWitness, true);
    await page.locator('.composer-attachment-surface').evaluate(card => { const progress = document.createElement('div'); progress.setAttribute('role', 'progressbar'); progress.textContent = 'Uploading'; card.append(progress); });
    state = await inspect(); assert.equal(state.attachments[0].busy, true);
    await page.locator('[role="progressbar"]').evaluate(node => node.hidden = true);
    state = await inspect(); assert.equal(state.attachments[0].busy, false);
    await page.locator('.composer-attachment-surface').evaluate(card => card.setAttribute('aria-busy', 'true'));
    state = await inspect(); assert.equal(state.attachments[0].busy, true, 'A busy card itself is also an upload in progress');
    await page.locator('.composer-attachment-surface').evaluate(card => { card.removeAttribute('aria-busy'); card.replaceWith(card.cloneNode(true)); });
    state = await inspect(); assert.equal(state.attachmentText, 'selection.png'); assert.equal(state.attachmentWitness, false, 'Same filename and pixels do not prove the original card survived');
    await load(); await addImage('#thread-composer', true);
    await page.locator('.composer-attachment-surface img').evaluate(image => image.replaceWith(image.cloneNode(true)));
    state = await inspect(); assert.equal(state.attachmentWitness, false, 'Replacing only the image also invalidates the witness');
    await load(); await addImage('#thread-composer', true);
    await page.locator('.composer-attachment-surface img').evaluate(image => image.src = 'data:image/png;base64,broken');
    state = await inspect(); assert.equal(state.attachmentWitness, false, 'Changing an existing image source must be detected');
  });

  await t.test('sent region images are settled only after decoding with one image and no pending user upload', async () => {
    await load(); let state = await inspect();
    assert.deepEqual(state.sentAttachment, { count: 0, settled: false });
    await addImage('[data-chatgpt-search-unit-key="fixture:user"]');
    state = await inspect(); assert.deepEqual(state.sentAttachment, { count: 1, settled: true });
    assert.equal(state.turns[0].text, prompt, 'Image controls must not contaminate the original prompt');
    await page.locator('[data-chatgpt-search-unit-key="fixture:user"]').evaluate(node => { const progress = document.createElement('div'); progress.setAttribute('role', 'progressbar'); progress.textContent = 'Uploading'; node.append(progress); });
    state = await inspect(); assert.deepEqual(state.sentAttachment, { count: 1, settled: false });
    await page.locator('[role="progressbar"]').evaluate(node => node.remove());
    await page.locator('[data-chatgpt-search-unit-key="fixture:user"]').evaluate(node => node.setAttribute('aria-busy', 'true'));
    state = await inspect(); assert.equal(state.sentAttachment.settled, false, 'The user message upload container may itself be busy');
    await page.locator('[data-chatgpt-search-unit-key="fixture:user"]').evaluate(node => node.removeAttribute('aria-busy'));
    await addImage('[data-chatgpt-search-unit-key="fixture:user"]');
    state = await inspect(); assert.deepEqual(state.sentAttachment, { count: 2, settled: false });
    await load();
    await page.locator('[data-chatgpt-search-unit-key="fixture:user"]').evaluate(async node => { const image = document.createElement('img'); image.width = 30; image.height = 20; image.src = 'data:image/png;base64,broken'; node.append(image); await image.decode().catch(() => {}); });
    state = await inspect(); assert.deepEqual(state.sentAttachment, { count: 1, settled: false });
  });

  await t.test('Work mode, login, blocking dialog, mismatched document and foreign root each invalidate the applicable safety proof', async () => {
    await load();
    await page.evaluate(() => { document.querySelector('#chat-mode').setAttribute('aria-pressed', 'false'); document.querySelector('#work-mode').setAttribute('aria-pressed', 'true'); });
    let state = await inspect(); assert.equal(state.ordinaryChat, false); assert.equal(usableProof(state), false);
    await load();
    await page.evaluate(() => { const button = document.createElement('button'); button.textContent = 'Sign in'; document.querySelector('main').append(button); });
    state = await inspect(); assert.equal(state.auth, true); assert.equal(usableProof(state), false);
    await load();
    await page.evaluate(() => { const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.textContent = 'Synthetic verification dialog'; document.body.append(dialog); });
    state = await inspect(); assert.equal(state.blocking, true); assert.equal(usableProof(state), false);
    await load();
    state = await inspect({ ...binding, documentEpoch: 'another-document' }); assert.equal(state.sameDocument, false); assert.equal(usableProof(state), false);
    await load('/?ego_run=foreign-task');
    state = await inspect(); assert.equal(state.routeMatches, false); assert.equal(usableProof(state), false);
    await load('/?ego_run=synthetic-chat');
    state = await inspect(); assert.equal(state.routeMatches, true);
  });
});
