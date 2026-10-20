import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, rename, access, unlink, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { codexCommand } from './codex-command.mjs';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const { values } = parseArgs({ options: {
  'base-url': { type: 'string', default: 'http://127.0.0.1:4317' },
  config: { type: 'string' },
  'search-document': { type: 'string', multiple: true },
  'search-source': { type: 'string', multiple: true },
  'search-minutes': { type: 'string' },
  'revoke-search': { type: 'boolean', default: false },
  install: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
} });

try {
  if (values.install && (values.config || process.env.PAPERDESK_PLUGIN_CONFIG)) {
    throw new Error('自定义配置仅用于测试；实际安装请使用默认配置位置。');
  }
  const url = new URL(values['base-url']);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('插件只能连接本机纸间服务，请提供 http://127.0.0.1:端口。');
  }
  await access(resolve(root, 'server/mcp.mjs'));
  const response = await fetch(`${url.origin}/api/plugin/status`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  const status = await response.json();
  if (!response.ok || status.service !== 'paperdesk' || status.apiVersion !== 1
      || !/^[a-f0-9]{64}$/.test(status.libraryId)) {
    throw new Error('这个端口没有兼容的纸间插件接口，请先构建并启动当前版本。');
  }
  const profilePath = resolve(values.config || process.env.PAPERDESK_PLUGIN_CONFIG
    || resolve(homedir(), '.config/paperdesk/plugin.json'));
  const defaultLibrary = (await import('node:crypto')).createHash('sha256').update(resolve(root, 'data')).digest('hex');
  const autoStart = url.port === '4317' && status.libraryId === defaultLibrary;
  const profile = { workspaceRoot: root, baseUrl: url.origin, libraryId: status.libraryId, autoStart };
  let previous;
  try { previous = JSON.parse(await readFile(profilePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('已有插件配置无法读取，未覆盖。', { cause: error }); }
  const previousRoot = previous && typeof previous.workspaceRoot === 'string'
    ? await realpath(previous.workspaceRoot).catch(() => null) : null;
  if (previous && (previous.libraryId !== profile.libraryId || previousRoot !== root)) {
    throw new Error('已有插件配置连接另一份工作区或文献库，未覆盖。请使用 --config 指定另一份配置。');
  }
  const grantRequested = values['search-document'] || values['search-source'] || values['search-minutes'];
  if (values['revoke-search'] && grantRequested) throw new Error('撤回与新增搜索授权不能同时使用。');
  if (previous?.searchGrant && !values['revoke-search']) profile.searchGrant = previous.searchGrant;
  if (grantRequested) {
    const documentIds = [...new Set(values['search-document'] || [])];
    const sources = [...new Set(values['search-source'] || [])];
    const minutes = Number(values['search-minutes']);
    if (!documentIds.length || documentIds.length > 20 || !documentIds.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
        || !sources.length || !sources.every(source => ['text', 'notes', 'annotation'].includes(source))
        || !Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
      throw new Error('搜索授权须指定 1–20 个 --search-document UUID、明确的 --search-source text/notes/annotation，以及 1–60 的 --search-minutes。');
    }
    const documentsResponse = await fetch(`${url.origin}/api/documents`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!documentsResponse.ok) throw new Error('无法核对授权文献。');
    const { documents } = await documentsResponse.json();
    if (!documentIds.every(id => documents.some(doc => doc.id === id))) throw new Error('授权文献不属于当前资料库。');
    profile.searchGrant = { documentIds, sources, expiresAt: new Date(Date.now() + minutes * 60_000).toISOString() };
  }
  if (values['dry-run']) {
    console.log(JSON.stringify({ ready: true, baseUrl: profile.baseUrl, existingProfile: Boolean(previous) }));
  } else {
    await mkdir(dirname(profilePath), { recursive: true, mode: 0o700 });
    const temporary = `${profilePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, profilePath);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    console.log('纸间插件已绑定当前本机文献库。');
    if (grantRequested) console.log(`已授权模型搜索指定文献的 ${profile.searchGrant.sources.join(', ')} 内容（包括其中可能的私人资料），到期时间 ${profile.searchGrant.expiresAt}。可用 --revoke-search 立即撤回后续搜索。`);
    if (values['revoke-search']) console.log('已撤回后续内容搜索；已经返回到对话的内容无法收回。');
    if (values.install) {
      const cli = codexCommand();
      for (const args of [
        ['plugin', 'marketplace', 'add', root, '--json'],
        ['plugin', 'add', 'paperdesk@paperdesk-local', '--json'],
      ]) {
        const child = spawnSync(cli.command, [...cli.args, ...args], { stdio: 'inherit', shell: false, windowsHide: true });
        if (child.error) throw child.error;
        if (child.status !== 0) throw new Error('Codex 插件安装未完成；文献库没有被改动。');
      }
    }
  }
} catch (error) {
  console.error(`插件设置未完成：${error.message}`);
  process.exitCode = 1;
}
