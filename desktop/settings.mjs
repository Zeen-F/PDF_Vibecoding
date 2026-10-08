import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export async function readDesktopSettings(userData) {
  try {
    const value = JSON.parse(await readFile(path.join(userData, 'desktop-settings.json'), 'utf8'));
    if (value.version !== 1 || typeof value.dataDir !== 'string' || !path.isAbsolute(value.dataDir)
      || value.dataDir.includes('\0') || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
      throw new Error('invalid settings');
    }
    const database = await stat(path.join(value.dataDir, 'paperdesk.sqlite'));
    if (!database.isFile() || database.size < 100) throw new Error('missing library');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT' && error.path === path.join(userData, 'desktop-settings.json')) return null;
    throw new Error('已保存的文献库或设置无法读取。请恢复完整文献库后重试；未创建替代文献库。', { cause: error });
  }
}

export async function writeDesktopSettings(userData, { dataDir, port }) {
  if (!path.isAbsolute(dataDir) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid desktop settings');
  await mkdir(userData, { recursive: true, mode: 0o700 });
  const target = path.join(userData, 'desktop-settings.json');
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, dataDir, port }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
