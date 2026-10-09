import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values, positionals } = parseArgs({
  options: {
    platform: { type: 'string', default: process.platform === 'win32' ? 'win32' : 'darwin' },
    'windows-format': { type: 'string', default: 'exe' },
  },
  allowPositionals: true,
});
if (positionals.length > 1 || !['darwin', 'win32'].includes(values.platform) || !['exe', 'zip'].includes(values['windows-format'])) {
  throw new Error('Usage: npm run release:checksums -- [release-directory] [--platform darwin|win32] [--windows-format exe|zip]');
}
const releaseDir = positionals[0] ? path.resolve(positionals[0]) : path.join(root, 'release');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid release version.');
const windows = values.platform === 'win32';
const manifest = windows ? 'SHA256SUMS-win' : 'SHA256SUMS';
const filenames = windows ? [`Paperdesk-${version}-win-x64.${values['windows-format']}`]
  : ['dmg', 'zip'].map(extension => `Paperdesk-${version}-mac-arm64.${extension}`);

// A missing installer must fail before replacing a previous checksum manifest.
for (const filename of filenames) {
  const info = await lstat(path.join(releaseDir, filename));
  if (!info.isFile() || info.size === 0) throw new Error(`Installer is missing or empty: ${filename}`);
}
const lines = [];
for (const filename of filenames) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path.join(releaseDir, filename))) hash.update(chunk);
  lines.push(`${hash.digest('hex')}  ${filename}`);
}
const temporary = path.join(releaseDir, `.${manifest}-${randomUUID()}.tmp`);
try {
  await writeFile(temporary, lines.join('\n') + '\n', { mode: 0o644, flag: 'wx' });
  await rename(temporary, path.join(releaseDir, manifest));
} finally {
  await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
console.log(`Wrote ${manifest} for ${filenames.length} ${windows ? 'Windows' : 'macOS'} installer${filenames.length === 1 ? '' : 's'}.`);
