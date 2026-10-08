import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const SERVICE_API_VERSION = 1;
// A product version alone cannot distinguish an older build's reuse contract.
export const LAUNCHER_PROTOCOL = 1;
export const PRODUCT_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** Calculate the local binding without opening, creating or migrating a library. */
export function libraryIdentity(dataDir) {
  return createHash('sha256').update(path.resolve(dataDir)).digest('hex');
}
