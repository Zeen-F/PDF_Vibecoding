import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { createCanvas, loadImage } from '@napi-rs/canvas';

if (process.platform !== 'darwin') throw new Error('The macOS icon build requires macOS.');
// Electron 44 downloads its pinned runtime lazily when this package is loaded.
createRequire(import.meta.url)('electron');

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = path.join(root, '.local/desktop-assets');
const iconset = path.join(assets, 'icon.iconset');
await mkdir(iconset, { recursive: true });

const canvas = createCanvas(1024, 1024);
const source = await readFile(path.join(root, 'desktop/icon.svg'));
canvas.getContext('2d').drawImage(await loadImage(source), 0, 0, 1024, 1024);
const png = path.join(assets, 'icon.png');
await writeFile(png, canvas.toBuffer('image/png'));

const run = promisify(execFile);
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const filename = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
    await run('/usr/bin/sips', [
      '--resampleHeightWidth', String(size * scale), String(size * scale),
      png, '--out', path.join(iconset, filename),
    ]);
  }
}
await run('/usr/bin/iconutil', ['--convert', 'icns', iconset, '--output', path.join(assets, 'icon.icns')]);
console.log('Prepared macOS desktop icons.');
