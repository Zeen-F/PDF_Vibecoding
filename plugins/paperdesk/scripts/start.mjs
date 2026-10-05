#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Paperdesk 插件需要 Node.js 24 或更新版本。');
  const configPath = process.env.PAPERDESK_PLUGIN_CONFIG || join(homedir(), '.config', 'paperdesk', 'plugin.json');
  const profile = JSON.parse(await readFile(configPath, 'utf8'));
  if (typeof profile.workspaceRoot !== 'string' || !isAbsolute(profile.workspaceRoot)) throw new Error('profile.workspaceRoot 必须是 Paperdesk 工作区的绝对路径。');
  const workspaceRoot = await realpath(profile.workspaceRoot);
  const { startStdio } = await import(pathToFileURL(join(workspaceRoot, 'server', 'mcp.mjs')).href);
  const { ensureReaderRuntime } = await import(pathToFileURL(join(workspaceRoot, 'server', 'plugin-runtime.mjs')).href);
  await ensureReaderRuntime({ ...profile, workspaceRoot });
  await startStdio(profile);
} catch (error) {
  console.error(`Paperdesk 插件启动失败：${error.code === 'ENOENT' ? '找不到本机配置或工作区。请先启动阅读器并运行插件设置。' : error.message}`);
  process.exitCode = 1;
}
