import test from 'node:test';
import assert from 'node:assert/strict';
import { readingPanels } from '../src/reader-ui-state.mjs';

test('focus reading hides all side panels without changing existing preferences', () => {
  const preferences = Object.freeze({ library: true, notes: true, navigation: true });
  assert.deepEqual(readingPanels(preferences, true), { library: false, notes: false, navigation: false });
  assert.deepEqual(readingPanels(preferences), preferences);
});
test('leaving focus restores individually closed panels without opening them', () => {
  for (const library of [false, true]) for (const notes of [false, true]) for (const navigation of [false, true]) {
    const preferences = { library, notes, navigation };
    readingPanels(preferences, true);
    assert.deepEqual(readingPanels(preferences, false), preferences);
  }
});
