import { chromium } from 'playwright';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function prepareChatgptBrowser() {
  try { await access(chromium.executablePath()); return; } catch {}
  console.log('正在准备纸间内置 ChatGPT 连接环境…');
  const cli = fileURLToPath(new URL('cli.js', import.meta.resolve('playwright/package.json')));
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('连接浏览器准备失败，请检查网络后重新安装纸间插件。')));
  });
  await access(chromium.executablePath());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await prepareChatgptBrowser();
