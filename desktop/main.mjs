import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDesktopRuntime, validateExistingLibrary } from './runtime.mjs';
import { readDesktopSettings, writeDesktopSettings } from './settings.mjs';

const desktopDir = path.dirname(fileURLToPath(import.meta.url));
const userData = path.resolve(process.env.PAPERDESK_DESKTOP_USER_DATA || path.join(app.getPath('appData'), 'Paperdesk'));
app.setName('Paperdesk');
app.setPath('userData', userData);
let runtime, window, ready = false, quitting = false, quitPending = false, switching = false, flushing;
const pendingFlush = new Map();

ipcMain.on('paperdesk:flush-result', (event, result) => {
  if (event.sender !== window?.webContents || !isReaderUrl(event.sender.getURL())) return;
  const pending = pendingFlush.get(result?.id);
  if (!pending) return;
  pendingFlush.delete(result.id);
  clearTimeout(pending.timer);
  if (result.ok === true) pending.resolve();
  else pending.reject(new Error(typeof result.error === 'string' ? result.error.slice(0, 300) : '笔记保存未完成。'));
});

function isReaderUrl(value) {
  try { return Boolean(runtime && new URL(value).origin === runtime.baseUrl); } catch { return false; }
}

function flushNotes() {
  if (!window || window.isDestroyed() || !ready) return Promise.resolve();
  if (flushing) return flushing;
  flushing = new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      pendingFlush.delete(id);
      reject(new Error('保存确认尚未返回。窗口已保留，请确认笔记保存后重试。'));
    }, 10_000);
    pendingFlush.set(id, { resolve, reject, timer });
    window.webContents.send('paperdesk:flush-request', id);
  }).finally(() => { flushing = null; });
  return flushing;
}

async function showError(message, error) {
  const options = {
    type: 'error', title: '纸间 Paperdesk', message,
    detail: error?.message || '请检查文献库权限与磁盘空间后重试。', buttons: ['知道了'],
  };
  if (window && !window.isDestroyed()) await dialog.showMessageBox(window, options);
  else await dialog.showMessageBox(options);
}

function guard(action) {
  return () => { void action().catch(error => showError('操作未完成', error)); };
}

async function chooseLibrary() {
  if (switching || quitting) return;
  switching = true;
  window.webContents.send('paperdesk:library-switch', true);
  try {
    await flushNotes();
    const choice = await dialog.showOpenDialog(window, {
      title: '打开已有文献库', buttonLabel: '打开文献库',
      message: '选择包含 paperdesk.sqlite 和 pdfs 的完整文献库。请先正常停止原阅读服务。',
      properties: ['openDirectory'],
    });
    if (choice.canceled || !choice.filePaths[0]) return;
    const dataDir = path.resolve(choice.filePaths[0]);
    if (dataDir === runtime.dataDir) return;
    await validateExistingLibrary(dataDir);
    const previous = runtime;
    ready = false;
    let next;
    try {
      await previous.close();
      next = await startDesktopRuntime({ dataDir });
      await writeDesktopSettings(userData, { dataDir, port: Number(new URL(next.baseUrl).port) });
      runtime = next;
    } catch (error) {
      await next?.close().catch(() => {});
      runtime = await startDesktopRuntime({ dataDir: previous.dataDir, preferredPort: Number(new URL(previous.baseUrl).port) });
      await window.loadURL(runtime.baseUrl);
      throw error;
    }
    await window.loadURL(runtime.baseUrl);
    updateMenu();
  } finally {
    switching = false;
    if (window && !window.isDestroyed()) window.webContents.send('paperdesk:library-switch', false);
  }
}

function updateMenu() {
  const application = {
    label: 'Paperdesk', submenu: [
      { role: 'about', label: '关于纸间 Paperdesk' },
      { type: 'separator' }, { role: 'hide', label: '隐藏纸间' }, { role: 'hideOthers', label: '隐藏其他' }, { role: 'unhide', label: '显示全部' },
      { type: 'separator' }, { role: 'quit', label: '退出纸间', accelerator: 'CmdOrCtrl+Q' },
    ],
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    application,
    { label: '文件', submenu: [
      { id: 'open-existing-library', label: '打开已有文献库…', click: guard(chooseLibrary) },
      { label: '在 Finder 中显示文献库', click: guard(async () => {
        const error = await shell.openPath(runtime.dataDir); if (error) throw new Error(error);
      }) },
      { label: '在浏览器中打开', click: guard(() => shell.openExternal(runtime.baseUrl)) },
      { type: 'separator' }, { role: 'close', label: '关闭窗口' },
    ] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '显示', submenu: [{ role: 'togglefullscreen', label: '进入全屏' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
  ]));
}

function createWindow() {
  window = new BrowserWindow({
    title: '纸间 Paperdesk', width: 1440, height: 960, minWidth: 780, minHeight: 560, show: false,
    backgroundColor: '#f5f1e8',
    webPreferences: {
      preload: path.join(desktopDir, 'preload.cjs'), contextIsolation: true,
      sandbox: true, nodeIntegration: false, webSecurity: true,
    },
  });
  const canWriteClipboard = (contents, permission, origin) => permission === 'clipboard-sanitized-write'
    && contents === window.webContents && isReaderUrl(contents.getURL()) && isReaderUrl(origin);
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(canWriteClipboard(contents, permission, details.requestingUrl || contents.getURL()));
  });
  window.webContents.session.setPermissionCheckHandler((contents, permission, origin) => canWriteClipboard(contents, permission, origin));
  window.webContents.setWindowOpenHandler(({ url }) => {
    // Only the existing translation account link may open the system browser.
    if (url === 'https://fanyi-api.baidu.com/access/0/1') void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => { if (!isReaderUrl(url)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('did-finish-load', () => { ready = true; });
  window.webContents.on('render-process-gone', () => { ready = false; });
  window.once('ready-to-show', () => window.show());
  window.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    void flushNotes().then(() => window.hide()).catch(error => showError('笔记尚未保存，窗口已保留', error));
  });
  window.webContents.session.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({ title: '导出 Markdown', defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) });
  });
  return window.loadURL(runtime.baseUrl);
}

async function quit() {
  if (quitting || quitPending) return;
  if (switching) return;
  quitPending = true;
  if (window && !window.isDestroyed()) window.webContents.send('paperdesk:library-switch', true);
  try {
    await flushNotes();
  } catch (error) {
    quitPending = false;
    window?.webContents.send('paperdesk:library-switch', false);
    window?.show();
    await showError('退出前保存未完成，窗口已保留', error);
    return;
  }
  // Notes are confirmed and the renderer stays locked during service teardown.
  quitting = true;
  try {
    await runtime?.close();
    app.quit();
  } catch (error) {
    await showError('笔记已保存，后台关闭时出现问题', error);
    app.exit(1);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.on('activate', () => { window?.show(); window?.focus(); });
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); void quit();
  });
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    const settings = await readDesktopSettings(userData);
    const dataDir = settings?.dataDir || path.join(userData, 'library');
    const preferredPort = process.env.PAPERDESK_DESKTOP_PORT === undefined ? (settings?.port || 4317) : Number(process.env.PAPERDESK_DESKTOP_PORT);
    runtime = await startDesktopRuntime({ dataDir, preferredPort });
    await writeDesktopSettings(userData, { dataDir, port: Number(new URL(runtime.baseUrl).port) });
    app.setAboutPanelOptions({ applicationName: '纸间 Paperdesk', applicationVersion: app.getVersion(), version: 'macOS 桌面预览版', copyright: 'PDF、笔记与批注保存在本机。' });
    updateMenu();
    await createWindow();
  }).catch(async error => {
    // Startup has no editor to flush. Close only the service this app owns.
    quitting = true;
    await runtime?.close().catch(() => {});
    await showError('纸间未能启动', error);
    app.exit(1);
  });
}
