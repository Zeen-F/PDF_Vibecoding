import { chromium as installedChromium } from 'playwright';
import { mkdir, chmod, lstat, readFile, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// A dedicated browser context is owned by Paperdesk. Never connect to an
// existing debugging port or borrow a daily browser/EGO user-data directory.
export function createManagedBrowser({ profileDir, chromium = installedChromium, headless = false, idleMs = 60_000 } = {}) {
  if (!path.isAbsolute(profileDir || '')) throw new Error('A dedicated absolute profile directory is required');
  let context, starting, closing, opening, idleTimer, nextId = 1, permanentClose = false, connectionPage, creatingSpace = false;
  const spaces = new Map(), token = randomUUID(), lockFile = path.join(profileDir, 'paperdesk-owner.json');
  const status = (state, message) => ({ engine: 'managed-browser', state, message });
  const clearIdle = () => { clearTimeout(idleTimer); idleTimer = undefined; };
  async function releaseLock() {
    try { if (JSON.parse(await readFile(lockFile, 'utf8')).token === token) await unlink(lockFile); } catch {}
  }
  async function lockProfile() {
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    const info = await lstat(profileDir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe browser profile');
    await chmod(profileDir, 0o700);
    const identity = JSON.stringify({ pid: process.pid, token });
    try { await writeFile(lockFile, identity, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const file = await lstat(lockFile);
      if (!file.isFile() || file.isSymbolicLink()) throw new Error('Unsafe browser owner');
      const old = JSON.parse(await readFile(lockFile, 'utf8'));
      if (!Number.isSafeInteger(old.pid) || old.pid < 1 || typeof old.token !== 'string') throw new Error('Invalid browser owner');
      try { process.kill(old.pid, 0); throw new Error('BROWSER_PROFILE_BUSY'); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      // Only this exact dead-process ownership file is eligible for recovery.
      if (JSON.parse(await readFile(lockFile, 'utf8')).token !== old.token) throw new Error('BROWSER_PROFILE_BUSY');
      await unlink(lockFile); await writeFile(lockFile, identity, { flag: 'wx', mode: 0o600 });
    }
  }
  async function ensureContext() {
    if (permanentClose) throw new Error('SERVICE_CLOSED');
    clearIdle();
    if (closing) await closing;
    if (permanentClose) throw new Error('SERVICE_CLOSED');
    if (context) return context;
    if (starting) return starting;
    starting = (async () => {
      await lockProfile();
      try {
        const opened = await chromium.launchPersistentContext(profileDir, {
          headless, viewport: { width: 1120, height: 860 }, locale: 'zh-CN', acceptDownloads: false, timeout: 30_000,
        });
        if (permanentClose) { await opened.close(); throw new Error('SERVICE_CLOSED'); }
        context = opened;
        context.on('close', () => {
          if (context === opened) { context = undefined; connectionPage = undefined; spaces.clear(); clearIdle(); void releaseLock(); }
        });
        return context;
      } catch (error) { await releaseLock(); throw error; }
    })();
    try { return await starting; } finally { starting = undefined; }
  }
  async function closeContext() {
    if (closing) return closing;
    closing = (async () => {
    clearIdle();
    if (starting) await starting.catch(() => {});
    const old = context; context = undefined; connectionPage = undefined; spaces.clear();
    if (old) await old.close();
    await releaseLock();
    })();
    try { await closing; } finally { closing = undefined; }
  }
  function scheduleIdle() {
    clearIdle();
    if (spaces.size || !context) return;
    idleTimer = setTimeout(() => { void closeContext().catch(() => {}); }, idleMs);
    idleTimer.unref?.();
  }
  function wrapPage(record) {
    const actual = record.actual;
    const action = () => { if (record.ownership !== 'agent' || actual.isClosed()) throw new Error('USER_CONTROL_REQUIRED'); };
    const options = value => { const { label: _label, ...rest } = value || {}; return rest; };
    return {
      async url() { return actual.url(); },
      async goto(url, value) { action(); return actual.goto(url, options(value)); },
      async evaluate(fn, arg) { action(); return actual.evaluate(fn, arg); },
      async waitForFunction(fn, arg, value) { action(); return actual.waitForFunction(fn, arg, value); },
      async click(selector, value) { action(); return actual.locator(selector).click(options(value)); },
      async fill(selector, value) { action(); return actual.locator(selector).fill(value); },
      async press(selector, key) { action(); return actual.locator(selector).press(key); },
      async waitForFileChooser(value) { action(); const chooser = await actual.waitForEvent('filechooser', value); return { setFiles: files => { action(); return chooser.setFiles(files); } }; },
    };
  }
  function task(record) {
    return {
      spaceId: record.id, name: record.name,
      get ownership() { return record.ownership; },
      page(label) { if (label !== 'p1') throw new Error('Unknown owned page'); return wrapPage(record); },
      async handOff() { record.ownership = 'user'; await record.actual.bringToFront(); },
      async finish({ keep = [] } = {}) {
        if (keep.length) throw new Error('Managed questions do not retain finished browser pages');
        if (!record.actual.isClosed()) await record.actual.close();
        spaces.delete(record.id); scheduleIdle();
      },
    };
  }
  return {
    runParameter: 'paperdesk_run', userBrowserLabel: '纸间连接窗口', accountLock: path.join(profileDir, 'account-mutation.lock'),
    async taskSpace(nameOrId) {
      if (typeof nameOrId === 'number') {
        const record = spaces.get(nameOrId); if (!record || record.actual.isClosed()) throw new Error('SPACE_IDENTITY_CHANGED');
        if (record.ownership !== 'agent') throw new Error('USER_CONTROL_REQUIRED');
        return task(record);
      }
      for (const [id, record] of spaces) if (record.actual.isClosed()) spaces.delete(id);
      if (creatingSpace || spaces.size) throw new Error('ANOTHER_BROWSER_QUESTION_ACTIVE');
      creatingSpace = true;
      try {
        if (opening) await opening;
        const opened = await ensureContext();
        const blank = opened.pages().find(page => page.url() === 'about:blank' && page !== connectionPage);
        const actual = blank || await opened.newPage();
        if (permanentClose || context !== opened) throw new Error('SERVICE_CLOSED');
        const record = { id: nextId++, name: nameOrId, actual, ownership: 'agent' };
        spaces.set(record.id, record); return task(record);
      } finally { creatingSpace = false; }
    },
    async listTaskSpaces() { return [...spaces.values()].filter(record => !record.actual.isClosed()).map(record => ({ id: record.id, taskId: record.name, name: record.name, ownership: record.ownership })); },
    async takeOverTaskSpace(id) { const record = spaces.get(id); if (!record || record.actual.isClosed()) throw new Error('SPACE_IDENTITY_CHANGED'); record.ownership = 'agent'; return task(record); },
    async preparePage(ownedTask, page, ledger, resume) {
      if (!resume || !['LOGIN_REQUIRED', 'AUTH_REQUIRED', 'PAGE_BLOCKED', 'CAPTCHA_REQUIRED', 'LOGIN_OR_VERIFICATION_REQUIRED'].includes(ledger.errorCode)) return;
      const record = spaces.get(ownedTask.spaceId);
      if (!record || ledger.dispatchInvoked || ledger.promptHash || ledger.attachmentReceipt) return;
      const current = new URL(await page.url());
      if (current.origin !== 'https://chatgpt.com' || current.pathname !== '/') return;
      if (current.searchParams.get('paperdesk_run') === ledger.runKey) return;
      const clean = await record.actual.evaluate(() => {
        const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
        const forms = [...document.querySelectorAll('main form[data-chatgpt-composer]')].filter(visible);
        const editors = forms.length === 1 ? [...forms[0].querySelectorAll('[contenteditable=true][role=textbox]')].filter(visible) : [];
        return editors.length === 1 && !editors[0].innerText.trim()
          && ![...document.querySelectorAll('main [data-message-author-role],main [data-chatgpt-search-message-ids],main [data-composer-attachments] [role=button]')].some(visible);
      });
      if (clean) await page.goto('https://chatgpt.com/?paperdesk_run=' + encodeURIComponent(ledger.runKey), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    },
    async open() {
      if (permanentClose) throw new Error('SERVICE_CLOSED');
      if (creatingSpace) return status('connecting', '问题正在启动专用连接窗口，请稍候。');
      if (opening) return opening;
      opening = (async () => {
      const opened = await ensureContext();
      const waiting = [...spaces.values()].find(record => record.ownership === 'user' && !record.actual.isClosed());
      if (waiting) { await waiting.actual.bringToFront(); return status('needs_user', '请在已打开的纸间连接窗口完成登录或验证，再回纸间继续。'); }
      if (spaces.size) return status('ready', 'ChatGPT 问题正在连接，纸间会自动管理窗口。');
      if (!connectionPage || connectionPage.isClosed()) {
        connectionPage = opened.pages().find(page => page.url() === 'about:blank') || await opened.newPage();
        await connectionPage.goto('https://chatgpt.com/?paperdesk_connect=1', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      }
      await connectionPage.bringToFront();
      return status('ready', '连接窗口已打开。首次使用请在窗口中登录 ChatGPT；窗口可用不代表已登录。');
      })();
      try { return await opening; } finally { opening = undefined; }
    },
    async status() {
      if (starting) return status('connecting', '正在启动纸间连接窗口…');
      if ([...spaces.values()].some(record => record.ownership === 'user')) return status('needs_user', '请在纸间连接窗口完成登录或验证，再继续原任务。');
      return context ? status('ready', '纸间连接窗口可用，提问时会核对登录和模型状态。') : status('closed', '提问时自动启动连接窗口，无需运行 EGO Lite。');
    },
    async disconnect() { await closeContext(); return status('closed', '连接窗口已关闭，登录配置保留在本机，下次提问自动启动。'); },
    async discardUnsent(name) {
      const record = [...spaces.values()].find(item => item.name === name);
      if (!record || record.ownership !== 'agent') return;
      if (!record.actual.isClosed()) await record.actual.close();
      spaces.delete(record.id); scheduleIdle();
    },
    async close() { permanentClose = true; await closeContext(); },
  };
}
