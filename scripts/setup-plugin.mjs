import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, rename, access, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: {
  'base-url': { type: 'string', default: 'http://127.0.0.1:4317' },
  config: { type: 'string' },
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
  if (previous && (previous.libraryId !== profile.libraryId || previous.workspaceRoot !== root)) {
    throw new Error('已有插件配置连接另一份工作区或文献库，未覆盖。请使用 --config 指定另一份配置。');
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
    if (values.install) {
      for (const args of [
        ['plugin', 'marketplace', 'add', root, '--json'],
        ['plugin', 'add', 'paperdesk@paperdesk-local', '--json'],
      ]) {
        const child = spawnSync('codex', args, { stdio: 'inherit' });
        if (child.error) throw child.error;
        if (child.status !== 0) throw new Error('Codex 插件安装未完成；文献库没有被改动。');
      }
    }
  }
} catch (error) {
  console.error(`插件设置未完成：${error.message}`);
  process.exitCode = 1;
}
