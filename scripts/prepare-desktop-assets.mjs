import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { createCanvas, loadImage } from '@napi-rs/canvas';

if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Desktop packaging currently supports macOS and Windows.');
// Electron 44 downloads its pinned runtime lazily when this package is loaded.
createRequire(import.meta.url)('electron');

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = path.join(root, '.local/desktop-assets');
await mkdir(assets, { recursive: true });

const canvas = createCanvas(1024, 1024);
const source = await readFile(path.join(root, 'desktop/icon.svg'));
canvas.getContext('2d').drawImage(await loadImage(source), 0, 0, 1024, 1024);
const png = path.join(assets, 'icon.png');
await writeFile(png, canvas.toBuffer('image/png'));

if (process.platform === 'win32') {
  // ICO permits PNG payloads on the supported modern Windows versions. Keep
  // each size in the single icon file so Explorer and the taskbar can choose it.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map(size => {
    const image = createCanvas(size, size);
    image.getContext('2d').drawImage(canvas, 0, 0, size, size);
    return image.toBuffer('image/png');
  });
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((image, index) => {
    const entry = 6 + index * 16;
    header[entry] = sizes[index] === 256 ? 0 : sizes[index];
    header[entry + 1] = header[entry];
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });
  await writeFile(path.join(assets, 'icon.ico'), Buffer.concat([header, ...images]));
  console.log('Prepared Windows desktop icons.');
} else {
  const iconset = path.join(assets, 'icon.iconset');
  await mkdir(iconset, { recursive: true });
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
}
