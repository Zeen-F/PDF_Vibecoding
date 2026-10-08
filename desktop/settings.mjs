import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getVaultConfig } from '../server/vault-config.mjs';

function validSettings(value) {
  return value.version === 1 && typeof value.dataDir === 'string' && path.isAbsolute(value.dataDir)
    && !value.dataDir.includes('\0') && Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535
    && (value.vaultDir === undefined || (typeof value.vaultDir === 'string' && path.isAbsolute(value.vaultDir) && !value.vaultDir.includes('\0')))
    && (value.vaultSubdir === undefined || (value.vaultDir !== undefined && typeof value.vaultSubdir === 'string'));
}

export async function readDesktopSettings(userData) {
  try {
    const value = JSON.parse(await readFile(path.join(userData, 'desktop-settings.json'), 'utf8'));
    if (!validSettings(value)) throw new Error('invalid settings');
    if (value.vaultDir !== undefined) {
      // A vault is the source of truth. Its local index can be absent and rebuilt.
      const config = await getVaultConfig(value);
      return { version: 1, dataDir: config.dataDir, port: value.port, vaultDir: config.vaultDir, vaultSubdir: config.vaultSubdir };
    }
    const database = await stat(path.join(value.dataDir, 'paperdesk.sqlite'));
    if (!database.isFile() || database.size < 100) throw new Error('missing library');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT' && error.path === path.join(userData, 'desktop-settings.json')) return null;
    throw new Error('已保存的文献库、Obsidian 仓库或设置无法读取。请恢复所选目录后重试；未创建替代文献库。', { cause: error });
  }
}

export async function writeDesktopSettings(userData, { dataDir, port, vaultDir, vaultSubdir }) {
  let value = { version: 1, dataDir, port, ...(vaultDir === undefined ? {} : { vaultDir, vaultSubdir: vaultSubdir ?? 'Paperdesk' }) };
  if (!validSettings(value)) throw new Error('Invalid desktop settings');
  if (vaultDir !== undefined) {
    const config = await getVaultConfig(value);
    value = { version: 1, dataDir: config.dataDir, port, vaultDir: config.vaultDir, vaultSubdir: config.vaultSubdir };
  }
  await mkdir(userData, { recursive: true, mode: 0o700 });
  const target = path.join(userData, 'desktop-settings.json');
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
