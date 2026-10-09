import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Junctions retain directory-link escape semantics on Windows without requiring
// Developer Mode or an elevated account. File links must remain real symlinks.
export const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';

let probed = false, skipReason = false;
export function fileSymlinkSkipReason() {
  if (probed) return skipReason;
  const directory = mkdtempSync(path.join(tmpdir(), 'paperdesk-file-link-probe-'));
  try {
    const target = path.join(directory, 'target.txt');
    writeFileSync(target, 'isolated symlink capability probe');
    symlinkSync(target, path.join(directory, 'link.txt'), 'file');
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
    skipReason = `Windows file symlinks are unavailable (${error.code}); only this file-link case is skipped.`;
  } finally {
    const parent = path.resolve(tmpdir()) + path.sep;
    if (!path.resolve(directory).startsWith(parent)) throw new Error('Unsafe symlink probe cleanup path.');
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  probed = true;
  return skipReason;
}
