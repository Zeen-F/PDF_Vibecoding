import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAppearance } from '../desktop/appearance.mjs';
test('appearance preference uses only the selected profile and tolerates invalid values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperdesk-appearance-'));
  try {
    assert.equal(readAppearance(dir), false);
    for (const value of ['{', 'null', '{"visual":"other"}', '{"visual":true}']) {
      fs.writeFileSync(path.join(dir, 'appearance.json'), value);
      assert.equal(readAppearance(dir), false);
    }
    fs.writeFileSync(path.join(dir, 'appearance.json'), '{"visual":"shanlan"}');
    assert.equal(readAppearance(dir), true);
    assert.equal(readAppearance(path.join(dir, 'other')), false);
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});
