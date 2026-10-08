import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { validateVaultDirectory } from './vault-store.mjs';

// Directory inventory only: PDF bytes and extracted text are never opened here.
export function listVaultPdfs({ vaultDir, documents = [], limit = 10_000 }) {
  const root = validateVaultDirectory(vaultDir);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new TypeError('PDF 列表上限必须是 1 至 10,000。');
  const linked = new Map(documents.map(doc => [doc.path, doc.id]));
  const files = [], directories = [root];
  try {
    while (directories.length) {
      const directory = directories.pop();
      const info = lstatSync(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) continue;
      const real = realpathSync(directory), relative = path.relative(root, real);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      const children = readdirSync(directory).filter(name => !name.startsWith('.')).sort();
      const nested = [];
      for (const name of children) {
        const file = path.join(directory, name), stat = lstatSync(file);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) { nested.push(file); continue; }
        if (!stat.isFile() || !/\.pdf$/i.test(name)) continue;
        const realFile = realpathSync(file), relativeFile = path.relative(root, realFile);
        if (relativeFile === '..' || relativeFile.startsWith(`..${path.sep}`) || path.isAbsolute(relativeFile)) continue;
        if (files.length === limit) return { files, truncated: true };
        const sourcePath = path.relative(root, file).split(path.sep).join('/');
        files.push({ path: sourcePath, name, byteSize: stat.size, documentId: linked.get(sourcePath) || null });
      }
      directories.push(...nested.reverse());
    }
    return { files, truncated: false };
  } catch (cause) {
    const error = new Error('暂时无法列出 Obsidian 中的 PDF，请检查知识库文件夹权限和文件状态。');
    error.name = 'VaultError'; error.status = 409; error.cause = cause; throw error;
  }
}
