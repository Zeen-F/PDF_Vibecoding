import { statSync } from 'node:fs';
import path from 'node:path';

function isFile(file) {
  try { return statSync(file).isFile(); } catch { return false; }
}

// Windows npm shims are .cmd files and cannot be spawned without a shell.
// Invoke their actual Node entry point, keeping all user paths as arguments.
export function codexCommand({ platform = process.platform, environment = process.env, node = process.execPath } = {}) {
  if (platform !== 'win32') return { command: 'codex', args: [] };
  const searchPath = Object.entries(environment).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  for (const entry of searchPath.split(';')) {
    const directory = entry.replace(/^"(.*)"$/, '$1');
    if (!directory || !path.isAbsolute(directory)) continue;
    const executable = path.join(directory, 'codex.exe');
    if (isFile(executable)) return { command: executable, args: [] };
    const cli = path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (isFile(path.join(directory, 'codex.cmd')) && isFile(cli)) return { command: node, args: [cli] };
  }
  throw new Error('未找到可运行的 Codex CLI。请安装官方 Codex CLI，并重新打开终端后重试。');
}
