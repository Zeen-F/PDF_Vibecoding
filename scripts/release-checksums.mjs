import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length > 3) throw new Error('Usage: npm run release:checksums -- [release-directory]');
const releaseDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'release');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid release version.');
const filenames = ['dmg', 'zip'].map(extension => `Paperdesk-${version}-mac-arm64.${extension}`);

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
const temporary = path.join(releaseDir, `.SHA256SUMS-${randomUUID()}.tmp`);
await writeFile(temporary, lines.join('\n') + '\n', { mode: 0o644 });
await rename(temporary, path.join(releaseDir, 'SHA256SUMS'));
console.log(`Wrote SHA256SUMS for ${filenames.length} macOS installers.`);
