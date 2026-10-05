import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, open, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { validatePluginProfile } from './mcp.mjs';

function refused(error) {
  const cause = error?.cause || error;
  return cause?.code === 'ECONNREFUSED'
    || (Array.isArray(cause?.errors) && cause.errors.length > 0 && cause.errors.every(refused));
}

// Starting a daemon is opt-in in the local profile. Reuse a matching service;
// never terminate an occupant, create a new library, or start another data path.
export async function ensureReaderRuntime(rawProfile) {
  const profile = validatePluginProfile(rawProfile);
  async function probe() {
    let response;
    try {
      response = await fetch(`${profile.baseUrl}/api/plugin/status`, { redirect: 'error', signal: AbortSignal.timeout(1500) });
    } catch (error) {
      if (refused(error)) return false;
      throw new Error('无法核对阅读服务；请检查本机地址和服务状态。');
    }
    let status;
    try { status = await response.json(); } catch { throw new Error('这个端口上的服务不是兼容的纸间；没有启动或终止任何服务。'); }
    if (!response.ok || status.service !== 'paperdesk' || status.apiVersion !== 1) {
      throw new Error('这个端口上的服务不是兼容的纸间；没有启动或终止任何服务。');
    }
    if (status.libraryId !== profile.libraryId) throw new Error('资料库身份与插件设置不一致；请核对配置。');
    return true;
  }
  if (await probe()) return { started: false };
  if (rawProfile.autoStart !== true) throw new Error('阅读服务尚未启动，请先启动纸间。');
  const url = new URL(profile.baseUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '4317') {
    throw new Error('自动启动仅适用于本机 4317 端口；请手动启动自定义服务。');
  }
  const workspaceRoot = await realpath(rawProfile.workspaceRoot);
  const dataDir = resolve(workspaceRoot, 'data');
  if (createHash('sha256').update(dataDir).digest('hex') !== profile.libraryId) {
    throw new Error('自动启动只连接已绑定的工作区 data 文献库，请手动启动自定义库。');
  }
  const database = await stat(join(dataDir, 'paperdesk.sqlite'));
  if (!database.isFile() || database.size < 100) throw new Error('既有文献库不可用；插件不会创建替代文献库。');
  await access(join(workspaceRoot, 'dist', 'index.html'));
  await access(join(workspaceRoot, 'server', 'index.mjs'));
  const logDir = join(workspaceRoot, '.local');
  await mkdir(logDir, { recursive: true });
  const log = await open(join(logDir, 'paperdesk-plugin-runtime.log'), 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [join(workspaceRoot, 'server', 'index.mjs')], {
      cwd: workspaceRoot, detached: true, stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env, PORT: '4317', PAPERDESK_DATA_DIR: dataDir },
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { await log.close(); }
  let exited = false;
  child.once('exit', () => { exited = true; });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await probe()) return { started: true };
    if (exited) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('纸间未能就绪。请查看本机 .local/paperdesk-plugin-runtime.log 后手动启动；插件不会终止其他服务。');
}
