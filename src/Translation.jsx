import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Languages, X, LoaderCircle, Copy, ExternalLink } from 'lucide-react';
import { api } from './api.js';
import './translation.css';

const ALLOWANCE = { standard: 50000, advanced: 1000000 };
const keyOf = selection => selection?.kind !== 'region' && selection?.quote ? JSON.stringify([selection.documentId, selection.page, selection.quote]) : selection?.kind === 'region' ? 'region' : '';
const PROVIDERS = { baidu: '百度翻译', azure: 'Azure Translator', deepl: 'DeepL', 'openai-compatible': '自定义（OpenAI 兼容）' };
const defaults = (provider = 'baidu') => ({ provider, appId: '', apiKey: '', tier: 'standard', monthlyLimit: provider === 'azure' ? '2000000' : '50000', endpoint: provider === 'azure' ? 'https://api.cognitive.microsofttranslator.com/translate' : '', region: '', model: '' });
const formFrom = settings => ({ ...defaults(settings.provider), tier: settings.tier, monthlyLimit: String(settings.monthlyLimit), endpoint: settings.endpoint || defaults(settings.provider).endpoint, region: settings.region || '', model: settings.model || '' });
const limitFor = form => form.provider === 'baidu' ? ALLOWANCE[form.tier] : 10000000;
const blankForm = defaults();

const Translation = forwardRef(function Translation({ documentId, page, selection, onModalChange }, ref) {
  const [activeProvider, setActiveProvider] = useState('baidu');
  const [settings, setSettings] = useState(null), [settingsOpen, setSettingsOpen] = useState(false);
  const [form, setForm] = useState(blankForm), [settingsBusy, setSettingsBusy] = useState(false), [settingsError, setSettingsError] = useState(''), [settingsStatus, setSettingsStatus] = useState(''), [confirmClear, setConfirmClear] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const testVersion = useRef(0), testController = useRef(null);
  const testing = testResult?.state === 'loading';
  const [result, setResult] = useState(null), [target, setTarget] = useState('zh'), [copyStatus, setCopyStatus] = useState(''), [copyBusy, setCopyBusy] = useState(false);
  const opener = useRef(null);
  const dialog = useRef(null), resultField = useRef(null), settingsVersion = useRef(0), requestVersion = useRef(0), controller = useRef(null), active = useRef(null), mounted = useRef(true), copying = useRef(false);
  const selectionKey = keyOf(selection), context = useRef({ documentId, page, selectionKey });
  context.current = { documentId, page, selectionKey };
  const closeResult = () => { ++requestVersion.current; controller.current?.abort(); active.current = null; setResult(null); setCopyStatus(''); };
  const clearTest = () => { ++testVersion.current; testController.current?.abort(); testController.current = null; setTestResult(null); };
  const updateForm = update => { clearTest(); setForm(update); };
  const closeSettings = () => { clearTest(); ++settingsVersion.current; setSettingsOpen(false); setForm(value => ({ ...value, appId: '', apiKey: '' })); setConfirmClear(false); setSettingsBusy(false); onModalChange(false); };
  const loadProfile = async provider => {
    clearTest();
    const version = ++settingsVersion.current;
    setForm(defaults(provider)); setSettings(null); setSettingsError(''); setSettingsStatus(''); setConfirmClear(false); setSettingsBusy(true);
    try {
      const data = await api(`/translation/settings${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`);
      if (!mounted.current || version !== settingsVersion.current) return;
      setSettings(data.settings); setActiveProvider(data.settings.activeProvider); setForm(formFrom(data.settings));
    } catch (error) { if (mounted.current && version === settingsVersion.current) setSettingsError(error.message); }
    finally { if (mounted.current && version === settingsVersion.current) setSettingsBusy(false); }
  };
  const openSettings = () => {
    opener.current = window.document.activeElement;
    setSettingsOpen(true); onModalChange(true); void loadProfile();
  };
  const stillCurrent = (version, snapshot) => mounted.current && version === requestVersion.current && context.current.documentId === snapshot.documentId && context.current.page === snapshot.page && (!context.current.selectionKey || context.current.selectionKey === keyOf(snapshot));
  const translate = async (snapshot, to = target) => {
    if (!snapshot?.quote || snapshot.kind === 'region' || snapshot.documentId !== context.current.documentId || snapshot.page !== context.current.page) return;
    const frozen = { documentId: snapshot.documentId, page: snapshot.page, quote: snapshot.quote };
    const version = ++requestVersion.current;
    controller.current?.abort(); controller.current = new AbortController(); active.current = frozen;
    setResult({ snapshot: frozen, state: 'loading', to }); setCopyStatus('');
    try {
      const data = await api('/translation', { method: 'POST', body: JSON.stringify({ text: frozen.quote, from: 'auto', to }), signal: controller.current.signal });
      if (!stillCurrent(version, frozen)) return;
      setSettings(previous => previous?.provider === data.settings.provider ? data.settings : previous); setActiveProvider(data.settings.activeProvider); setResult({ snapshot: frozen, state: 'ready', to, translation: data.translation });
    } catch (error) {
      if (error.name !== 'AbortError' && stillCurrent(version, frozen)) setResult({ snapshot: frozen, state: 'error', to, error: error.message });
    }
  };
  useImperativeHandle(ref, () => ({ openSettings, translate, closeResult }));
  useEffect(() => {
    const snapshot = active.current;
    // Controls in this card may clear the browser's DOM selection. A new PDF
    // selection, page, or book invalidates the snapshot; reading the result does not.
    if (snapshot && (documentId !== snapshot.documentId || page !== snapshot.page || (selectionKey && selectionKey !== keyOf(snapshot)))) closeResult();
  }, [documentId, page, selectionKey]);
  useEffect(() => {
    if (!settingsOpen) return;
    dialog.current?.showModal();
    return () => { if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); };
  }, [settingsOpen]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++requestVersion.current; ++settingsVersion.current; controller.current?.abort(); ++testVersion.current; testController.current?.abort(); }; }, []);
  const candidateBody = () => {
    const monthlyLimit = Number(form.monthlyLimit);
    if (!form.monthlyLimit.trim() || !Number.isSafeInteger(monthlyLimit) || monthlyLimit < 0 || monthlyLimit > limitFor(form)) throw new Error('请输入允许范围内的整数上限，0 表示暂停发送。');
    const body = { provider: form.provider, monthlyLimit };
    if (form.provider === 'baidu') { body.tier = form.tier; if (form.appId.trim()) body.appId = form.appId.trim(); }
    else { body.endpoint = form.endpoint.trim(); if (form.provider === 'azure') body.region = form.region.trim(); if (form.provider === 'openai-compatible') body.model = form.model.trim(); }
    if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();
    return body;
  };
  const testTranslation = async () => {
    if (settingsBusy || testController.current || !dialog.current?.querySelector('form').reportValidity()) return;
    let body;
    try { body = candidateBody(); }
    catch (error) { setTestResult({ state: 'error', error: error.message }); return; }
    const version = ++testVersion.current, abort = new AbortController();
    testController.current = abort;
    setTestResult({ state: 'loading' }); setSettingsError(''); setSettingsStatus('');
    try {
      const data = await api('/translation/test', { method: 'POST', body: JSON.stringify(body), signal: abort.signal });
      if (mounted.current && version === testVersion.current) setTestResult({ state: 'ready', ...data.test });
    } catch (error) {
      if (error.name !== 'AbortError' && mounted.current && version === testVersion.current) setTestResult({ state: 'error', error: error.message });
    } finally { if (version === testVersion.current) testController.current = null; }
  };
  const saveSettings = async event => {
    event.preventDefault(); if (settingsBusy || testController.current) return;
    let body;
    try { body = candidateBody(); }
    catch (error) { setSettingsError(error.message); return; }
    clearTest();
    const version = ++settingsVersion.current;
    setSettingsBusy(true); setSettingsError(''); setSettingsStatus('');
    try {
      const data = await api('/translation/settings', { method: 'PUT', body: JSON.stringify(body) });
      if (!mounted.current || version !== settingsVersion.current) return;
      setSettings(data.settings); setActiveProvider(data.settings.activeProvider); setForm(formFrom(data.settings)); setSettingsStatus('翻译设置已保存。'); setConfirmClear(false);
    } catch (error) { if (mounted.current && version === settingsVersion.current) setSettingsError(error.message); }
    finally { if (mounted.current && version === settingsVersion.current) setSettingsBusy(false); }
  };
  const clearSettings = async () => {
    if (settingsBusy || testController.current) return;
    clearTest();
    const version = ++settingsVersion.current; setSettingsBusy(true); setSettingsError(''); setSettingsStatus('');
    try {
      const data = await api(`/translation/settings?provider=${encodeURIComponent(form.provider)}`, { method: 'DELETE' });
      if (!mounted.current || version !== settingsVersion.current) return;
      setSettings(data.settings); setActiveProvider(data.settings.activeProvider); setForm(formFrom(data.settings)); setConfirmClear(false); setSettingsStatus('已清除保存的翻译密钥。');
    } catch (error) { if (mounted.current && version === settingsVersion.current) setSettingsError(error.message); }
    finally { if (mounted.current && version === settingsVersion.current) setSettingsBusy(false); }
  };
  const copyResult = async () => {
    if (copying.current || result?.state !== 'ready') return;
    const version = requestVersion.current, text = result.translation.translatedText;
    copying.current = true; setCopyBusy(true); setCopyStatus('');
    try { await navigator.clipboard.writeText(text); if (version === requestVersion.current && mounted.current) setCopyStatus('译文已复制。'); }
    catch { if (version === requestVersion.current && mounted.current) { resultField.current?.focus(); resultField.current?.select(); setCopyStatus('复制未完成，已选中译文，请手动复制。'); } }
    finally { copying.current = false; if (mounted.current) setCopyBusy(false); }
  };
  return <>
    {settingsOpen && <dialog ref={dialog} className="translation-dialog" aria-label="翻译设置" aria-modal="true" onKeyDown={event => { if (event.key !== 'Tab') return; const controls = [...event.currentTarget.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')]; const first = controls[0], last = controls.at(-1); if (event.shiftKey && window.document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && window.document.activeElement === last) { event.preventDefault(); first?.focus(); } }} onCancel={event => { event.preventDefault(); closeSettings(); }}>
      <form onSubmit={saveSettings}>
        <div className="translation-heading"><h2><Languages size={19}/> 翻译设置</h2><button type="button" className="icon-button" aria-label="关闭翻译设置" onClick={closeSettings}><X size={19}/></button></div>
        <p className="translation-intro">使用你自己的翻译 API。只有点击“翻译”时，选中的文字才发送给当前启用的服务，无需 Codex，也不会自动写入笔记。</p>
        <label>翻译服务<select autoFocus aria-label="翻译服务" value={form.provider} disabled={settingsBusy} onChange={event => void loadProfile(event.target.value)}>{Object.entries(PROVIDERS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <p className="translation-help">当前启用：{PROVIDERS[activeProvider] || '尚未配置'}。保存设置后启用所选服务；查看其他服务不会切换正在使用的配置。</p>
        {form.provider === 'baidu' && <a className="translation-provider-link" href="https://fanyi-api.baidu.com/access/0/1" target="_blank" rel="noopener noreferrer">百度翻译开放平台 <ExternalLink size={13}/></a>}
        <p className="translation-account" role="status">{settingsBusy && !settings ? '正在读取设置…' : settings?.configured ? `${PROVIDERS[form.provider]} · 已配置${form.provider === 'baidu' ? ` · APP ID ${settings.appIdHint}` : ' · 已保存密钥'}` : '尚未配置翻译账号'}</p>
        <div className={form.provider === 'baidu' ? 'translation-form-grid' : ''}>{form.provider === 'baidu' && <label>APP ID<input aria-label="百度 APP ID" autoComplete="off" spellCheck="false" value={form.appId} onChange={event => updateForm(value => ({ ...value, appId: event.target.value }))} placeholder={settings?.configured ? '留空保留当前账号' : '填写百度 APP ID'} disabled={settingsBusy}/></label>}<label>API Key<input type="password" aria-label="翻译 API Key" autoComplete="new-password" value={form.apiKey} onChange={event => updateForm(value => ({ ...value, apiKey: event.target.value }))} placeholder={settings?.configured ? '留空保留该服务的已存密钥' : '填写该服务的 API Key'} disabled={settingsBusy}/></label></div>
        {form.provider === 'baidu' ? <><label>百度账号版本<select aria-label="百度账号版本" value={form.tier} disabled={settingsBusy} onChange={event => { const tier = event.target.value; updateForm(value => ({ ...value, tier, monthlyLimit: String(value.monthlyLimit.trim() && Number.isSafeInteger(Number(value.monthlyLimit)) && Number(value.monthlyLimit) >= 0 ? Math.min(Number(value.monthlyLimit), ALLOWANCE[tier]) : ALLOWANCE[tier]) })); }}><option value="standard">标准版 · 每月 5 万字符</option><option value="advanced">高级版 · 每月 100 万字符</option></select></label><p className="translation-help">按百度已开通的版本选择；此处不会为账号升级。</p></> : <>
          {form.provider === 'deepl' ? <label>DeepL 接口<select aria-label="DeepL 接口" value={form.endpoint} disabled={settingsBusy} onChange={event => updateForm(value => ({ ...value, endpoint: event.target.value }))}><option value="">按密钥类型自动选择</option><option value="https://api-free.deepl.com/v2/translate">API Free · api-free.deepl.com</option><option value="https://api.deepl.com/v2/translate">API · api.deepl.com</option></select></label> : <label>完整 API 地址<input type="url" aria-label="完整 API 地址" autoComplete="off" spellCheck="false" value={form.endpoint} placeholder={form.provider === 'azure' ? 'https://api.cognitive.microsofttranslator.com/translate' : 'https://your-service.example/v1/chat/completions'} disabled={settingsBusy} onChange={event => updateForm(value => ({ ...value, endpoint: event.target.value }))}/></label>}
          {form.provider === 'azure' && <label>Azure 区域（可选）<input aria-label="Azure 区域" value={form.region} disabled={settingsBusy} placeholder="与 Azure 资源一致，例如 eastasia" onChange={event => updateForm(value => ({ ...value, region: event.target.value }))}/></label>}
          {form.provider === 'openai-compatible' && <label>模型名称<input aria-label="模型名称" value={form.model} disabled={settingsBusy} required placeholder="填写该服务实际提供的模型名称" onChange={event => updateForm(value => ({ ...value, model: event.target.value }))}/></label>}
          <p className="translation-help">填写完整接口地址。远程地址必须是 HTTPS，仅自定义服务的本机 localhost 可用 HTTP。更换接口域名时，请重新填写密钥。</p>
        </>}
        <label>本机月度上限（字符）<input type="number" aria-label="本机月度上限" inputMode="numeric" min="0" max={limitFor(form)} step="1" value={form.monthlyLimit} disabled={settingsBusy} onChange={event => updateForm(value => ({ ...value, monthlyLimit: event.target.value }))}/></label>
        {settings && <div className="translation-usage"><strong>本机用量估算 · {settings.month}</strong><span>已用 {settings.usedCharacters.toLocaleString()} 字符 · 本机剩余 {settings.remainingCharacters.toLocaleString()} 字符</span><span>单次最多 {settings.maxCharacters.toLocaleString()} 字符 / {settings.maxBytes.toLocaleString()} 字节，不会截断选文。</span></div>}
        <p className="translation-help">{form.provider === 'baidu' ? '额度可能被纸间之外的调用共用，实际用量与费用以百度控制台为准。' : form.provider === 'azure' ? '每月 200 万免费字符仅适用于实际开通的 Azure F0 资源，其他资源按服务价格计费。' : form.provider === 'deepl' ? 'DeepL Developer 的 100 万字符是总试用额度，不是每月额度；请以账号控制台为准。' : '此入口只支持 OpenAI 兼容的 chat/completions 协议。费用取决于服务与模型，字符数不能换算为 token 或费用。'} 本机上限只约束这里的请求，不代表免费额度，设为 0 可暂停发送。</p>
        {settingsError && <p className="translation-error" role="alert">{settingsError}</p>}{settingsStatus && <p className="translation-status" role="status">{settingsStatus}</p>}
        {confirmClear && <div className="translation-clear-confirm"><p>清除本机保存的 {PROVIDERS[form.provider]} 账号和密钥？其他服务、文献与笔记不受影响。</p><button type="button" className="text-button" disabled={settingsBusy} onClick={() => setConfirmClear(false)}>取消</button><button type="button" className="text-button danger" disabled={settingsBusy || testing} onClick={clearSettings}>确认清除密钥</button></div>}
        <p className="translation-help translation-test-help">测试仅发送固定示例，会使用少量接口额度；测试不会保存或切换配置。</p>
        {testResult && <section className="translation-test-result" aria-label="翻译测试结果">
          {testing ? <p className="translation-status" role="status"><LoaderCircle size={15} className="spin"/> 正在测试翻译…</p> : testResult.state === 'error' ? <p className="translation-error" role="alert">测试失败：{testResult.error}</p> : <><p className="translation-status" role="status">测试成功 · {PROVIDERS[testResult.provider]} · {testResult.elapsedMs} ms</p><label>测试原文<textarea aria-label="测试原文" readOnly value={testResult.sourceText}/></label><label>测试译文<textarea aria-label="测试译文" readOnly value={testResult.translatedText}/></label></>}
        </section>}
        <div className="translation-actions translation-settings-actions"><button type="button" className="text-button danger" disabled={!settings?.configured || settingsBusy || testing} onClick={() => setConfirmClear(true)}>清除已存密钥</button><div className="translation-settings-submit"><button type="button" className="secondary-button" disabled={settingsBusy || testing} onClick={testTranslation}>{testing ? <LoaderCircle size={15} className="spin"/> : null} 测试翻译</button><button className="primary-button" disabled={settingsBusy || testing}>{settingsBusy ? <LoaderCircle size={15} className="spin"/> : null} 保存翻译设置</button></div></div>
      </form>
    </dialog>}
    {result && <section className="translation-card" role="region" aria-label="选文翻译">
      <div className="translation-heading"><h2><Languages size={17}/> 选文翻译 <small>第 {result.snapshot.page} 页</small></h2><button className="icon-button" aria-label="关闭翻译结果" onClick={closeResult}><X size={18}/></button></div>
      <p className="translation-help">{PROVIDERS[result.translation?.provider] || '翻译服务'} · 仅发送本次选文，不写入笔记。</p>
      <label className="translation-target">翻译为<select aria-label="翻译目标语言" value={target} onChange={event => { setTarget(event.target.value); void translate(result.snapshot, event.target.value); }}><option value="zh">中文</option><option value="en">English</option></select></label>
      <label>原文<textarea aria-label="翻译原文" readOnly value={result.snapshot.quote}/></label>
      {result.state === 'loading' ? <p className="translation-status" role="status"><LoaderCircle size={15} className="spin"/> 正在翻译…</p> : result.state === 'error' ? <div><p className="translation-error" role="alert">{result.error}</p><div className="translation-actions"><button className="text-button" onClick={openSettings}>检查翻译设置</button><button className="primary-button" onClick={() => translate(result.snapshot, target)}>重试翻译</button></div></div> : <><label>译文<textarea ref={resultField} aria-label="译文" readOnly value={result.translation.translatedText}/></label><div className="translation-actions"><span className="translation-help">{result.translation.cached ? '使用本机缓存' : `本次 ${result.translation.characters.toLocaleString()} 字符`}</span><button className="text-button" disabled={copyBusy} onClick={copyResult}><Copy size={13}/> 复制译文</button></div>{copyStatus && <p className="translation-status" role="status">{copyStatus}</p>}</>}
    </section>}
  </>;
});
export default Translation;
