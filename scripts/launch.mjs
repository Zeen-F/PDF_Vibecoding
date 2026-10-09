import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { libraryIdentity, LAUNCHER_PROTOCOL, PRODUCT_VERSION, SERVICE_API_VERSION } from '../shared/service-identity.mjs';
import { getVaultConfig } from '../server/vault-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const HOST = '127.0.0.1';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function browserLaunchConfig({ rootDir = root, env = process.env } = {}) {
  rootDir = path.resolve(rootDir);
  const port = Number(env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1 至 65535 的整数。');
  if (env.PAPERDESK_DATA_DIR?.includes('\0')) throw new Error('PAPERDESK_DATA_DIR 必须是有效的文献库目录。');
  const requestedDataDir = env.PAPERDESK_DATA_DIR ? path.resolve(rootDir, env.PAPERDESK_DATA_DIR) : undefined;
  const vault = env.PAPERDESK_VAULT_DIR ? getVaultConfig({
    vaultDir: env.PAPERDESK_VAULT_DIR,
    vaultSubdir: env.PAPERDESK_VAULT_SUBDIR || 'Paperdesk',
    dataDir: requestedDataDir,
  }) : null;
  const dataDir = vault?.dataDir || requestedDataDir || path.join(rootDir, 'data');
  return { rootDir, port, baseUrl: `http://${HOST}:${port}`, dataDir,
    ...(vault ? { vaultDir: vault.vaultDir, vaultSubdir: vault.vaultSubdir, libraryDir: vault.libraryDir } : {}),
    libraryId: libraryIdentity(vault?.libraryDir || dataDir), productVersion: PRODUCT_VERSION };
}

/** Refusal means free; a timeout or other network failure is never permission to start. */
export function portListening(port, timeoutMs = 900) {
  return new Promise(resolve => {
    const socket = connect({ host: HOST, port });
    let done = false;
    const finish = state => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(state);
    };
    socket.once('connect', () => finish('occupied'));
    socket.once('error', error => finish(error.code === 'ECONNREFUSED' ? 'free' : 'unknown'));
    socket.setTimeout(timeoutMs, () => finish('unknown'));
  });
}

function blocked(reason, message) { return { state: 'blocked', reason, message }; }

async function smallJson(response) {
  if (!response.ok) { await response.body?.cancel().catch(() => {}); return null; }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16 * 1024) throw new Error('Identity response too large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function probeBrowserService(config, {
  fetchImpl = globalThis.fetch, connectionProbe = portListening, timeoutMs = 900,
} = {}) {
  const connection = await connectionProbe(config.port, timeoutMs);
  if (connection === 'free') return { state: 'free' };
  if (connection !== 'occupied') return blocked('unverified', `无法确认端口 ${config.port} 的占用状态；未启动服务或打开浏览器。请检查后重试。`);
  let status, health;
  try {
    [status, health] = await Promise.all(['/api/plugin/status', '/api/health'].map(async endpoint => {
      const response = await fetchImpl(config.baseUrl + endpoint, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      return smallJson(response);
    }));
  } catch {
    return blocked('unverified', `端口 ${config.port} 已被占用，但服务响应超时或身份无法读取；未打开浏览器。请核对并正常停止旧服务后重试。`);
  }
  if (!status || typeof status !== 'object') return blocked('unverified', `端口 ${config.port} 已被占用，无法核对纸间服务身份；未打开浏览器。请核对并正常停止旧服务后重试。`);
  if (status.service !== 'paperdesk') return blocked('other-service', `端口 ${config.port} 被其他服务占用；未打开浏览器。请选择空闲 PORT，或正常停止对应服务后重试。`);
  if (typeof status.libraryId !== 'string' || !/^[a-f0-9]{64}$/.test(status.libraryId)) return blocked('unverified', `端口 ${config.port} 上的纸间未提供有效文献库身份；未打开浏览器。请正常停止旧服务，再从当前程序目录重新启动。`);
  if (status.libraryId !== config.libraryId) return blocked('library', `端口 ${config.port} 上的纸间使用另一文献库；未打开浏览器，也未改动文献库。请正常停止该服务，或为当前文献库选择不同 PORT。`);
  if (status.apiVersion !== SERVICE_API_VERSION || status.launcherProtocol !== LAUNCHER_PROTOCOL || status.productVersion !== config.productVersion) {
    return blocked('version', `端口 ${config.port} 上的纸间版本或启动协议与当前程序不兼容（当前 ${config.productVersion}）；未打开浏览器。请正常停止旧服务，再从当前程序目录重新启动。`);
  }
  if (health?.ok !== true) return blocked('unhealthy', `端口 ${config.port} 上的纸间尚未就绪或健康检查失败；未打开浏览器。请检查启动窗口后重试。`);
  return { state: 'compatible' };
}

export function browserOpenCommand(baseUrl, platform = process.platform) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || url.hostname !== HOST || url.username || url.password) {
    throw new Error('启动器只能打开本机纸间地址。');
  }
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url.href]];
  if (platform === 'darwin') return ['/usr/bin/open', [url.href]];
  return ['xdg-open', [url.href]];
}

function openBrowser(baseUrl) {
  const [command, args] = browserOpenCommand(baseUrl);
  const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, shell: false });
  child.on('error', error => console.error(`无法自动打开浏览器：${error.message}。请手动访问 ${baseUrl}`));
  child.unref();
}

async function stopOwnedChild(child, exited, timeoutMs = 10000) {
  if (exited()) return;
  if (child.connected) child.send({ type: 'paperdesk-shutdown' }, () => {});
  else child.kill('SIGTERM');
  await new Promise(resolve => {
    let timer;
    const finish = () => { clearTimeout(timer); child.off('exit', finish); resolve(); };
    child.once('exit', finish);
    timer = setTimeout(() => { if (!exited()) child.kill('SIGKILL'); finish(); }, timeoutMs);
    if (exited()) finish();
  });
}

/** Exposed for tests: callers can replace process spawning and browser opening. */
export async function runBrowserLauncher({
  rootDir = root, env = process.env, probe = probeBrowserService, spawnImpl = spawn,
  open = openBrowser, log = console.log, error = console.error, onChild = () => {},
  startupTimeoutMs = 15_000, pollIntervalMs = 250, shutdownTimeoutMs = 10000, signal,
} = {}) {
  const config = browserLaunchConfig({ rootDir, env });
  let inspection = await probe(config);
  if (signal?.aborted) return { state: 'cancelled', code: 130 };
  if (inspection.state === 'compatible') {
    log(`纸间已经启动（当前文献库，${config.productVersion}）：${config.baseUrl}`);
    open(config.baseUrl);
    return { state: 'reused', code: 0 };
  }
  if (inspection.state !== 'free') { error(inspection.message); return { state: 'blocked', code: 1 }; }

  let child;
  try {
    const childEnv = { ...env, PORT: String(config.port), PAPERDESK_DATA_DIR: config.dataDir };
    if (config.vaultDir) {
      childEnv.PAPERDESK_VAULT_DIR = config.vaultDir;
      childEnv.PAPERDESK_VAULT_SUBDIR = config.vaultSubdir;
    } else {
      delete childEnv.PAPERDESK_VAULT_DIR;
      delete childEnv.PAPERDESK_VAULT_SUBDIR;
    }
    child = spawnImpl(process.execPath, ['server/index.mjs'], { cwd: config.rootDir, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env: childEnv });
  } catch (cause) { error(`无法启动纸间：${cause.message}`); return { state: 'failed', code: 1 }; }
  let exited = false, exitCode, spawnError, ready = false;
  child.on('message', message => { if (message?.type === 'paperdesk-ready') ready = true; });
  child.once('exit', code => { exited = true; exitCode = code; });
  child.once('error', cause => { exited = true; spawnError = cause; });
  onChild(child);
  const deadline = Date.now() + startupTimeoutMs;
  do {
    inspection = await probe(config);
    if (signal?.aborted) {
      await stopOwnedChild(child, () => exited, shutdownTimeoutMs);
      return { state: 'cancelled', code: 130 };
    }
    if (inspection.state === 'compatible' && (ready || exited)) {
      // A concurrent launcher may have won the bind race. Identity still has
      // to match, and we never take ownership of that other process.
      open(config.baseUrl);
      log('浏览器已打开。保持此窗口运行；结束时按 Control+C。');
      return { state: exited ? 'reused' : 'started', code: 0, child: exited ? undefined : child };
    }
    if (inspection.state === 'blocked' && !['unverified', 'unhealthy'].includes(inspection.reason)) {
      await stopOwnedChild(child, () => exited, shutdownTimeoutMs);
      error(inspection.message);
      return { state: 'blocked', code: 1 };
    }
    if (exited && (inspection.state === 'free' || spawnError)) {
      error(spawnError ? `无法启动纸间：${spawnError.message}` : `纸间启动失败（退出码 ${exitCode ?? '未知'}）；未打开浏览器。请检查上方启动错误。`);
      return { state: 'failed', code: 1 };
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  await stopOwnedChild(child, () => exited, shutdownTimeoutMs);
  inspection = await probe(config);
  if (inspection.state === 'compatible') {
    // A matching service won the race while our child stalled before binding.
    open(config.baseUrl);
    log(`纸间已经启动（当前文献库，${config.productVersion}）：${config.baseUrl}`);
    return { state: 'reused', code: 0 };
  }
  error(inspection.state === 'blocked' ? inspection.message : '纸间启动超时，未打开浏览器；本次启动的服务已停止。请检查启动输出后重试。');
  return { state: 'failed', code: 1 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let child;
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (child.connected) child.send({ type: 'paperdesk-shutdown' }, () => {});
    else child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 10000);
    timer.unref();
    child.once('exit', () => clearTimeout(timer));
  };
  const interrupt = stop;
  const terminate = stop;
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const result = await runBrowserLauncher({ signal: controller.signal, onChild: spawned => {
      child = spawned;
      child.on('exit', code => { if (code) process.exitCode = code; });
    } });
    process.exitCode = result.code;
    if (!result.child) {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    }
  } catch (cause) {
    console.error(cause.message);
    process.exitCode = 1;
  }
}
