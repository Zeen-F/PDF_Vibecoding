import { lstat, open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { crc32, deflateRaw } from 'node:zlib';

const compress = promisify(deflateRaw);
const ZIP32_LIMIT = 0xffffffff;

/** Create the allowlisted staging tree as a UTF-8 ZIP without external tools.
 * Only ordinary files are accepted; links and special files are never followed.
 * Timestamps and owner metadata are omitted for repeatable, portable archives.
 */
export async function createBrowserArchive(packageRoot, archivePath, topFolder) {
  if (!topFolder || /[\\/\x00-\x1f]/.test(topFolder) || ['.', '..'].includes(topFolder)) {
    throw new Error('Invalid browser archive root.');
  }
  const entries = [];
  async function visit(directory, relative = '') {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Archive source must be a real directory.');
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (/[\\/\x00-\x1f]/.test(item.name) || ['.', '..'].includes(item.name)) throw new Error('Unsafe archive filename.');
      const file = path.join(directory, item.name);
      const name = relative ? `${relative}/${item.name}` : item.name;
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) throw new Error('Archive source cannot contain links.');
      if (stat.isDirectory()) await visit(file, name);
      else if (stat.isFile()) entries.push({ file, name, mode: stat.mode });
      else throw new Error('Archive source cannot contain special files.');
    }
  }
  await visit(packageRoot);
  if (!entries.length || entries.length >= 0xffff) throw new Error('Archive file count exceeds ZIP32 limits.');

  const archive = await open(archivePath, 'wx', 0o644);
  let offset = 0;
  const directoryRecords = [];
  async function write(bytes) {
    if (offset + bytes.length >= ZIP32_LIMIT) throw new Error('Browser archive exceeds ZIP32 limits.');
    await archive.writeFile(bytes);
    offset += bytes.length;
  }
  try {
    for (const entry of entries) {
      const name = Buffer.from(`${topFolder}/${entry.name}`, 'utf8');
      if (name.length > 0xffff) throw new Error('Archive filename exceeds ZIP32 limits.');
      const bytes = await readFile(entry.file);
      const compressed = await compress(bytes);
      if (bytes.length >= ZIP32_LIMIT || compressed.length >= ZIP32_LIMIT) throw new Error('Archive entry exceeds ZIP32 limits.');
      const checksum = crc32(bytes);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x800, 6); // UTF-8 filenames, including the Chinese launcher.
      local.writeUInt16LE(8, 8); // Raw DEFLATE.
      local.writeUInt16LE(0x21, 12); // 1980-01-01; no machine-specific timestamps.
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(bytes.length, 22);
      local.writeUInt16LE(name.length, 26);

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(0x314, 4); // UNIX regular-file attributes.
      local.copy(central, 6, 4, 26);
      central.writeUInt16LE(name.length, 28);
      const executable = (process.platform !== 'win32' && (entry.mode & 0o111)) || /\.(?:command|sh)$/.test(entry.name);
      central.writeUInt32LE(((0o100000 | (executable ? 0o755 : 0o644)) << 16) >>> 0, 38);
      central.writeUInt32LE(offset, 42);
      directoryRecords.push(central, name);
      await write(local);
      await write(name);
      await write(compressed);
    }
    const directoryOffset = offset;
    for (const record of directoryRecords) await write(record);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - directoryOffset, 12);
    end.writeUInt32LE(directoryOffset, 16);
    await write(end);
    await archive.sync();
  } finally {
    await archive.close();
  }
}
