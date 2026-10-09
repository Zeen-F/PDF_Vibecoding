import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';

/** Resolve a vault without creating it. A cache must never sit in the vault. */
export function getVaultConfig({ vaultDir, vaultSubdir = 'Paperdesk', dataDir } = {}) {
  if (typeof vaultDir !== 'string' || !path.isAbsolute(vaultDir) || vaultDir.includes('\0')) throw new Error('请选择已存在的 Obsidian 知识库根目录。');
  // Native resolution expands Windows 8.3 names and junction targets, matching
  // fs.promises.realpath used by the desktop and preserving one vault identity.
  const root = realpathSync.native(vaultDir);
  if (!lstatSync(root).isDirectory() || !lstatSync(path.join(root, '.obsidian')).isDirectory()) throw new Error('请选择包含 .obsidian 的知识库根目录。');
  if (typeof vaultSubdir !== 'string' || !vaultSubdir.trim() || vaultSubdir !== path.basename(vaultSubdir)
    || /[\\/\x00-\x1f]/.test(vaultSubdir) || vaultSubdir.startsWith('.')) throw new Error('Paperdesk 文件夹名称必须是单层普通目录名。');
  const libraryDir = path.join(root, vaultSubdir);
  const key = createHash('sha256').update(libraryDir).digest('hex');
  const localRoot = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'Paperdesk')
    : process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Paperdesk')
      : path.join(os.homedir(), '.local', 'share', 'Paperdesk');
  const cache = path.resolve(dataDir || path.join(localRoot, 'vault-cache', key));
  // Resolve existing parents as well: a cache symlink cannot point back into iCloud.
  let parent = cache;
  const suffix = [];
  for (;;) {
    try { parent = realpathSync.native(parent); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; suffix.unshift(path.basename(parent)); parent = path.dirname(parent); }
  }
  const resolvedCache = path.join(parent, ...suffix);
  if (resolvedCache === root || resolvedCache.startsWith(root + path.sep)) throw new Error('索引和翻译设置必须保存在 Obsidian 知识库之外。');
  return { vaultDir: root, vaultSubdir, libraryDir, dataDir: resolvedCache };
}
