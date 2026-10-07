import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { bookmarkedPdf } from './fixtures/toc-browser.mjs';

// Used only by the isolated browser runner. No request reaches a provider.
export function translationTestOptions() {
  let epoch = Date.UTC(2026, 9, 1, 12);
  return {
    fetchImpl: async (url, options) => {
      const endpoint = new URL(url);
      assert.equal(options.method, 'POST');
      const translated = (text, to) => `${to?.toLowerCase() === 'en' ? 'Test translation: ' : '测试译文：'}${text}`;
      if (endpoint.hostname === 'fanyi-api.baidu.com') {
        const body = new URLSearchParams(options.body), text = body.get('q'), to = body.get('to');
        return Response.json({ from: body.get('from') === 'auto' ? 'en' : body.get('from'), to, trans_result: [{ src: text, dst: translated(text, to) }] });
      }
      const body = JSON.parse(options.body);
      if (endpoint.hostname === 'api.cognitive.microsofttranslator.com') {
        assert.equal(endpoint.pathname, '/translate'); assert.equal(endpoint.searchParams.get('api-version'), '3.0');
        assert.equal(body.length, 1);
        return Response.json([{ detectedLanguage: { language: 'en' }, translations: [{ text: translated(body[0].Text, endpoint.searchParams.get('to')), to: endpoint.searchParams.get('to') }] }]);
      }
      if (['api-free.deepl.com', 'api.deepl.com'].includes(endpoint.hostname)) {
        assert.equal(endpoint.pathname, '/v2/translate'); assert.equal(body.text.length, 1);
        return Response.json({ translations: [{ text: translated(body.text[0], body.target_lang), detected_source_language: 'EN' }] });
      }
      assert.ok(endpoint.pathname.endsWith('/chat/completions'), 'Only the synthetic OpenAI-compatible adapter may reach this branch');
      assert.equal(body.stream, false); assert.ok(body.model);
      assert.equal(body.messages.length, 2); assert.equal(body.messages[1].role, 'user');
      const to = /English/i.test(body.messages[0].content) ? 'en' : 'zh';
      return Response.json({ choices: [{ message: { content: translated(body.messages[1].content, to) } }] });
    },
    clock: { now: () => epoch, sleep: async milliseconds => { epoch += milliseconds; } },
    timeoutMs: 15000,
  };
}

export async function translationWorkflow({ context, base, onTranslationPreview }) {
  const page = await context.newPage(), calls = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url() === `${base}/api/translation` && request.method() === 'POST') calls.push(request.postDataJSON()); });
  const json = async (path, body, method = 'GET') => {
    const response = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(response.ok, `${method} ${path}: ${response.status}`); return response.json();
  };
  const form = new FormData(); form.append('file', new Blob([bookmarkedPdf(), `\n% translation ${randomUUID()}\n`], { type: 'application/pdf' }), '原创翻译验收.pdf');
  const imported = await fetch(`${base}/api/documents`, { method: 'POST', body: form }); assert.equal(imported.status, 201); const { document: book } = await imported.json();
  const privateNote = 'PRIVATE 笔记：这里只记录自己的思考，不能作为翻译请求发送。';
  await json(`/documents/${book.id}`, { notesZh: privateNote, notesEn: '' }, 'PATCH');
  const before = (await json(`/documents/${book.id}`)).document;
  const appId = '2026100712345678', secret = 'synthetic-translation-key-only';
  const settingsEndpoint = `${base}/api/translation/settings`, translationEndpoint = `${base}/api/translation`;
  const selectText = async (pattern = /^A short introduction for navigation checks\.$/) => {
    const span = page.locator('.textLayer span').filter({ hasText: pattern }); await expect(span).toBeVisible();
    await expect(page.locator('.pdf-paper')).not.toHaveClass(/is-loading/);
    await span.click({ trial: true }); // Wait for the PDF layout to settle after a viewport change.
    const box = await span.boundingBox();
    // Start a fresh selection instead of dragging the browser's existing selection.
    await page.mouse.click(box.x - 8, box.y + box.height / 2);
    await page.mouse.move(box.x + 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 10 }); await page.mouse.up();
    const domText = await page.evaluate(() => window.getSelection()?.toString()); assert.ok(domText?.length > 10);
    await expect(page.getByRole('button', { name: '翻译', exact: true })).toBeVisible();
    const quote = await page.locator('.selection-summary p').textContent(); assert.equal(quote, domText);
    return quote;
  };
  try {
    await page.goto(`${base}/?document=${book.id}&page=2`);
    await expect(page.getByRole('textbox', { name: '笔记', exact: true })).toHaveValue(privateNote);
    await page.getByRole('button', { name: '翻译设置', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '翻译设置', exact: true });
    await expect(settings).toBeVisible();
    await expect(settings.getByRole('link', { name: '百度翻译开放平台', exact: true })).toHaveAttribute('href', 'https://fanyi-api.baidu.com/access/0/1');
    await expect(settings.getByLabel('翻译 API Key', { exact: true })).toHaveAttribute('type', 'password');
    await settings.getByLabel('百度 APP ID', { exact: true }).fill(appId);
    await settings.getByLabel('翻译 API Key', { exact: true }).fill(secret);
    await settings.getByLabel('本机月度上限', { exact: true }).fill('0');
    await settings.getByLabel('百度账号版本', { exact: true }).selectOption('advanced');
    await expect(settings.getByLabel('本机月度上限', { exact: true })).toHaveValue('0');
    await settings.getByLabel('百度账号版本', { exact: true }).selectOption('standard');
    await settings.getByLabel('本机月度上限', { exact: true }).fill('50000');
    await page.route(settingsEndpoint, route => route.request().method() === 'PUT' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '隔离测试：设置暂时无法保存。' }) }) : route.continue());
    await settings.getByRole('button', { name: '保存翻译设置', exact: true }).click();
    await expect(settings.getByRole('alert')).toContainText('暂时无法保存');
    await expect(settings.getByLabel('翻译 API Key', { exact: true })).toHaveValue(secret);
    await expect(settings.getByLabel('百度 APP ID', { exact: true })).toHaveValue(appId);
    await page.unroute(settingsEndpoint);
    await settings.getByRole('button', { name: '保存翻译设置', exact: true }).click();
    await expect(settings).toContainText('翻译设置已保存');
    await expect(settings.getByLabel('翻译 API Key', { exact: true })).toHaveValue('');
    await expect(settings.getByLabel('百度 APP ID', { exact: true })).toHaveValue('');
    const publicSettings = await json('/translation/settings');
    assert.equal(publicSettings.settings.configured, true);
    assert.ok(!JSON.stringify(publicSettings).includes(secret)); assert.ok(!JSON.stringify(publicSettings).includes(appId));
    await expect(settings).toContainText('本机用量估算'); await expect(settings).toContainText('以百度控制台为准');
    await settings.getByRole('button', { name: '保存翻译设置', exact: true }).focus(); await page.keyboard.press('Tab');
    await expect(settings.getByRole('button', { name: '关闭翻译设置', exact: true })).toBeFocused();
    await onTranslationPreview?.(page, 'settings-forest');
    await settings.getByLabel('翻译 API Key', { exact: true }).fill('unsaved-secret-to-clear');
    await page.keyboard.press('Escape'); await expect(settings).toHaveCount(0);
    await page.getByRole('button', { name: '翻译设置', exact: true }).click();
    await expect(settings.getByLabel('翻译 API Key', { exact: true })).toHaveValue('');
    assert.equal(await page.evaluate(value => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }).includes(value), secret), false);
    await settings.getByRole('button', { name: '关闭翻译设置', exact: true }).click();
    assert.equal(calls.length, 0, 'Configuring translation must not send any text');
    console.log('PASS: translation settings redact credentials, preserve failed form drafts, clear passwords and use no browser credential storage');

    const quote = await selectText(); assert.equal(calls.length, 0, 'Selecting text does not translate automatically');
    await page.getByRole('button', { name: '翻译', exact: true }).click();
    const result = page.getByRole('region', { name: '选文翻译', exact: true });
    await expect(result.getByRole('textbox', { name: '翻译原文', exact: true })).toHaveValue(quote);
    await expect(result.getByRole('textbox', { name: '译文', exact: true })).toHaveValue(`测试译文：${quote}`);
    assert.deepEqual(calls[0], { text: quote, from: 'auto', to: 'zh' });
    await onTranslationPreview?.(page, 'result-forest');
    await result.getByRole('combobox', { name: '翻译目标语言', exact: true }).selectOption('en');
    await expect(result.getByRole('textbox', { name: '译文', exact: true })).toHaveValue(`Test translation: ${quote}`);
    await result.getByRole('combobox', { name: '翻译目标语言', exact: true }).selectOption('zh');
    await expect(result).toContainText('使用本机缓存');
    const used = (await json('/translation/settings')).settings.usedCharacters;
    await result.getByRole('button', { name: '关闭翻译结果', exact: true }).click();
    await selectText(); await page.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(result).toContainText('使用本机缓存');
    assert.equal((await json('/translation/settings')).settings.usedCharacters, used);
    assert.equal((await json(`/documents/${book.id}`)).document.notesRevision, before.notesRevision);
    assert.ok(calls.every(body => !JSON.stringify(body).includes(privateNote) && Object.keys(body).sort().join(',') === 'from,text,to'));
    console.log('PASS: actual PDF mouse selection becomes an exact source snapshot, targets and cache work, and notes remain untouched');

    // Hold the old result after the mock provider has completed. Changing pages
    // must discard it even if the transport acknowledgement arrives later.
    await result.getByRole('button', { name: '关闭翻译结果', exact: true }).click();
    let release, entered;
    const held = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    await page.route(translationEndpoint, async route => { const response = await route.fetch(); entered(); await gate; await route.fulfill({ response }).catch(() => {}); });
    await selectText(); await page.getByRole('button', { name: '翻译', exact: true }).click(); await held;
    await expect(result).toContainText('正在翻译');
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(result).toHaveCount(0); release(); await page.unroute(translationEndpoint);
    await expect(page.getByLabel('PDF 第 3 页', { exact: true })).toBeVisible(); await expect(result).toHaveCount(0);
    await page.getByRole('button', { name: '上一页', exact: true }).click();
    await selectText(); await page.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(result.getByRole('textbox', { name: '译文', exact: true })).toHaveValue(`测试译文：${quote}`);
    await selectText(/^1 Introduction$/); await expect(result).toHaveCount(0);
    await page.route(translationEndpoint, route => route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ error: '选文超过本次翻译上限，请重新选择；不会截断。' }) }));
    const shortQuote = await page.locator('.selection-summary p').textContent();
    await page.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(result.getByRole('alert')).toContainText('不会截断');
    await expect(result.getByRole('textbox', { name: '翻译原文', exact: true })).toHaveValue(shortQuote);
    await page.unroute(translationEndpoint); await result.getByRole('button', { name: '重试翻译', exact: true }).click();
    await expect(result.getByRole('textbox', { name: '译文', exact: true })).toHaveValue(`测试译文：${shortQuote}`);
    console.log('PASS: late translation cannot land on another page/selection; limit failures retain complete source and explicit retry');

    await page.getByRole('button', { name: '主题：夜读', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
    await page.setViewportSize({ width: 688, height: 853 });
    await onTranslationPreview?.(page, 'result-night-narrow');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const box = await result.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 688);
    await result.getByRole('button', { name: '关闭翻译结果', exact: true }).click();
    await page.getByRole('button', { name: '翻译设置', exact: true }).click();
    await expect(settings).toBeVisible(); await onTranslationPreview?.(page, 'settings-night-narrow');
    const dialogBox = await settings.boundingBox(); assert.ok(dialogBox.x >= 0 && dialogBox.width <= 688 && dialogBox.height <= 853);
    await settings.getByRole('button', { name: '清除已存密钥', exact: true }).click();
    await expect(settings).toContainText('文献与笔记不受影响');
    await settings.getByRole('button', { name: '确认清除密钥', exact: true }).click();
    await expect(settings).toContainText('尚未配置翻译账号');
    assert.equal((await json('/translation/settings')).settings.configured, false);
    await settings.getByRole('button', { name: '关闭翻译设置', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await selectText(); await page.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(result.getByRole('alert')).toBeVisible(); await expect(result.getByRole('textbox', { name: '译文', exact: true })).toHaveCount(0);
    assert.equal((await json(`/documents/${book.id}`)).document.notesZh, privateNote);
    await result.getByRole('button', { name: '关闭翻译结果', exact: true }).click();
    await page.getByRole('button', { name: '取消选择', exact: true }).click();
    const beforeRegion = calls.length;
    await page.getByRole('button', { name: '区域批注', exact: true }).click();
    const paper = await page.locator('.pdf-paper').boundingBox();
    await page.mouse.move(paper.x + paper.width * .2, paper.y + paper.height * .2); await page.mouse.down();
    await page.mouse.move(paper.x + paper.width * .45, paper.y + paper.height * .35, { steps: 8 }); await page.mouse.up();
    await expect(page.getByText('图片选区需先识别文字', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '翻译', exact: true })).toHaveCount(0);
    assert.equal(calls.length, beforeRegion, 'A region selection never sends a PNG to the text provider');
    console.log('PASS: night/narrow translation controls, confirmed credential removal and unconfigured error preserve the notebook');

    await page.getByRole('button', { name: '取消选择', exact: true }).click();
    await page.getByRole('button', { name: '区域批注', exact: true }).click();
    await page.getByRole('button', { name: '翻译设置', exact: true }).click();
    const provider = settings.getByRole('combobox', { name: '翻译服务', exact: true });
    const chooseProvider = async id => {
      await provider.selectOption(id);
      await expect(settings.getByRole('button', { name: '保存翻译设置', exact: true })).toBeEnabled();
      await expect(provider).toHaveValue(id);
    };
    const saveProfile = async () => {
      await settings.getByRole('button', { name: '保存翻译设置', exact: true }).click();
      await expect(settings).toContainText('翻译设置已保存');
      await expect(settings.getByLabel('翻译 API Key', { exact: true })).toHaveValue('');
    };
    const azureKey = 'synthetic-azure-key', customKey = 'synthetic-custom-key', deeplKey = 'synthetic-deepl-key:fx';
    await chooseProvider('azure');
    await expect(settings.getByLabel('本机月度上限', { exact: true })).toHaveValue('2000000');
    await expect(settings.getByLabel('完整 API 地址', { exact: true })).toHaveValue('https://api.cognitive.microsofttranslator.com/translate');
    await settings.getByLabel('翻译 API Key', { exact: true }).fill(azureKey);
    await settings.getByLabel('Azure 区域', { exact: true }).fill('eastasia');
    await saveProfile();
    let activeSettings = (await json('/translation/settings')).settings;
    assert.equal(activeSettings.provider, 'azure'); assert.equal(activeSettings.activeProvider, 'azure'); assert.equal(activeSettings.region, 'eastasia');
    await settings.getByRole('button', { name: '关闭翻译设置', exact: true }).click();
    const azureQuote = await selectText(); await page.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(result.getByRole('textbox', { name: '翻译原文', exact: true })).toHaveValue(azureQuote);
    await expect(result.getByRole('textbox', { name: '译文', exact: true })).toHaveValue(`测试译文：${azureQuote}`);
    await expect(result).toContainText('Azure Translator');
    await onTranslationPreview?.(page, 'result-azure');
    await result.getByRole('button', { name: '关闭翻译结果', exact: true }).click();

    await page.getByRole('button', { name: '翻译设置', exact: true }).click();
    await chooseProvider('openai-compatible');
    assert.equal((await json('/translation/settings')).settings.provider, 'azure', 'Inspecting a profile must not activate it');
    await expect(settings.getByLabel('模型名称', { exact: true })).toHaveValue('');
    await settings.getByLabel('翻译 API Key', { exact: true }).fill(customKey);
    await settings.getByLabel('完整 API 地址', { exact: true }).fill('https://translation.example.test/v1/chat/completions');
    await settings.getByLabel('模型名称', { exact: true }).fill('laboratory-translator-v42');
    await page.setViewportSize({ width: 688, height: 853 });
    await onTranslationPreview?.(page, 'settings-custom-night-narrow');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await saveProfile();
    activeSettings = (await json('/translation/settings')).settings;
    assert.equal(activeSettings.provider, 'openai-compatible'); assert.equal(activeSettings.model, 'laboratory-translator-v42');
    assert.equal(activeSettings.endpoint, 'https://translation.example.test/v1/chat/completions');
    assert.ok(!JSON.stringify(activeSettings).includes(customKey));
    // A new host cannot receive the previously saved secret just because the
    // editor retains the selected profile. Failure must preserve the draft.
    await settings.getByLabel('完整 API 地址', { exact: true }).fill('https://other.example.test/v1/chat/completions');
    await settings.getByRole('button', { name: '保存翻译设置', exact: true }).click();
    await expect(settings.getByRole('alert')).toBeVisible();
    await expect(settings.getByLabel('完整 API 地址', { exact: true })).toHaveValue('https://other.example.test/v1/chat/completions');
    assert.equal((await json('/translation/settings')).settings.endpoint, activeSettings.endpoint);
    await settings.getByLabel('完整 API 地址', { exact: true }).fill(activeSettings.endpoint);
    await saveProfile();
    await settings.getByRole('button', { name: '关闭翻译设置', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    const customQuote = await selectText(); await page.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(result.getByRole('textbox', { name: '翻译原文', exact: true })).toHaveValue(customQuote);
    await expect(result.getByRole('textbox', { name: '译文', exact: true })).toHaveValue(`测试译文：${customQuote}`);
    await expect(result).toContainText('自定义（OpenAI 兼容）');
    await result.getByRole('combobox', { name: '翻译目标语言', exact: true }).selectOption('en');
    await expect(result.getByRole('textbox', { name: '译文', exact: true })).toHaveValue(`Test translation: ${customQuote}`);
    await result.getByRole('combobox', { name: '翻译目标语言', exact: true }).selectOption('zh');
    await expect(result).toContainText('使用本机缓存');
    await result.getByRole('button', { name: '关闭翻译结果', exact: true }).click();

    await page.getByRole('button', { name: '翻译设置', exact: true }).click();
    await chooseProvider('deepl');
    await expect(settings.getByLabel('本机月度上限', { exact: true })).toHaveValue('50000');
    await expect(settings.getByLabel('DeepL 接口', { exact: true })).toHaveValue('');
    await settings.getByLabel('翻译 API Key', { exact: true }).fill(deeplKey);
    await saveProfile();
    await expect(settings.getByLabel('DeepL 接口', { exact: true })).toHaveValue('https://api-free.deepl.com/v2/translate');
    await settings.getByRole('button', { name: '关闭翻译设置', exact: true }).click();
    const deeplQuote = await selectText(); await page.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(result.getByRole('textbox', { name: '翻译原文', exact: true })).toHaveValue(deeplQuote);
    await expect(result.getByRole('textbox', { name: '译文', exact: true })).toHaveValue(`测试译文：${deeplQuote}`);
    await expect(result).toContainText('DeepL');
    await result.getByRole('button', { name: '关闭翻译结果', exact: true }).click();
    await page.getByRole('button', { name: '翻译设置', exact: true }).click();
    await chooseProvider('azure');
    await expect(settings.getByLabel('翻译 API Key', { exact: true })).toHaveValue('');
    await expect(settings.getByLabel('Azure 区域', { exact: true })).toHaveValue('eastasia');
    await saveProfile();
    assert.equal((await json('/translation/settings')).settings.provider, 'azure');
    await chooseProvider('openai-compatible');
    await expect(settings.getByLabel('模型名称', { exact: true })).toHaveValue('laboratory-translator-v42');
    await settings.getByRole('button', { name: '清除已存密钥', exact: true }).click();
    await settings.getByRole('button', { name: '确认清除密钥', exact: true }).click();
    await expect(settings).toContainText('尚未配置翻译账号');
    assert.equal((await json('/translation/settings?provider=openai-compatible')).settings.configured, false);
    assert.equal((await json('/translation/settings?provider=deepl')).settings.configured, true);
    assert.equal((await json('/translation/settings')).settings.provider, 'azure');
    await settings.getByRole('button', { name: '关闭翻译设置', exact: true }).click();
    const restoredQuote = await selectText(); await page.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(result.getByRole('textbox', { name: '翻译原文', exact: true })).toHaveValue(restoredQuote);
    await expect(result.getByRole('textbox', { name: '译文', exact: true })).toHaveValue(`测试译文：${restoredQuote}`);
    await expect(result).toContainText('Azure Translator');
    for (const id of ['baidu', 'azure', 'deepl', 'openai-compatible']) {
      const profile = await json(`/translation/settings?provider=${id}`);
      assert.ok([secret, azureKey, customKey, deeplKey].every(key => !JSON.stringify(profile).includes(key)));
    }
    assert.equal(await page.evaluate(values => values.some(value => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }).includes(value)), [secret, azureKey, customKey, deeplKey]), false);
    assert.equal((await json(`/documents/${book.id}`)).document.notesRevision, before.notesRevision);
    assert.ok(calls.every(body => !JSON.stringify(body).includes(privateNote) && Object.keys(body).sort().join(',') === 'from,text,to'));
    assert.deepEqual(errors, []);
    console.log('PASS: four translation adapters, saved independent profiles, arbitrary compatible model/endpoint, host-change key guard and targeted key removal');
  } finally { await page.close(); }
}
