import { readFileSync } from 'node:fs';
import path from 'node:path';

// A local appearance preference never changes the selected library or profile.
export function readAppearance(profileDir) {
  try {
    const value = JSON.parse(readFileSync(path.join(profileDir, 'appearance.json'), 'utf8'));
    return value?.visual === 'shanlan';
  } catch {
    return false;
  }
}
