import test from 'node:test';
import assert from 'node:assert/strict';
import { captureReaderViewport, restoreReaderViewport } from '../src/reader-viewports.js';

test('page-relative anchors restore both scroll axes at the original scale', () => {
  const bounds = { top: 100, left: 200 }, rect = { top: -100, left: 120, width: 800, height: 1000 };
  const saved = captureReaderViewport(bounds, rect, 'synthetic-document', 3);
  assert.deepEqual(saved, { documentId: 'synthetic-document', page: 3, top: .2, left: .1 });
  assert.deepEqual(restoreReaderViewport(bounds, { ...rect, top: 124, left: 224 }, { top: 0, left: 0 }, saved), { top: 224, left: 104 });
});

test('zoom and container changes keep a physical-page anchor rather than old pixels', () => {
  const saved = captureReaderViewport({ top: 0, left: 0 }, { top: -250, left: -100, width: 1000, height: 1000 }, 'synthetic-document', 4);
  const position = restoreReaderViewport({ top: 120, left: 80 }, { top: 144, left: 104, width: 2000, height: 2000 }, { top: 200, left: 0 }, saved);
  assert.deepEqual(position, { top: 724, left: 224 });
});

test('a whole-page view preserves negative margins and browser scrolling handles clamping', () => {
  const bounds = { top: 100, left: 100 }, rect = { top: 124, left: 200, width: 600, height: 800 };
  const saved = captureReaderViewport(bounds, rect, 'synthetic-document', 1);
  assert.ok(saved.top < 0 && saved.left < 0);
  assert.deepEqual(restoreReaderViewport(bounds, rect, { top: 0, left: 0 }, saved), { top: 0, left: 0 });
});

test('unrendered or invalid geometry never creates a viewport or nonfinite scroll', () => {
  const bounds = { top: 0, left: 0 }, rect = { top: 0, left: 0, width: 600, height: 800 };
  for (const patch of [{ width: 0 }, { height: -1 }, { top: NaN }, { left: Infinity }]) {
    assert.equal(captureReaderViewport(bounds, { ...rect, ...patch }, 'synthetic-document', 1), null);
    assert.equal(restoreReaderViewport(bounds, { ...rect, ...patch }, { top: 0, left: 0 }, { top: 0, left: 0 }), null);
  }
  assert.equal(captureReaderViewport(bounds, rect, 'synthetic-document', 1.5), null);
  assert.equal(restoreReaderViewport(bounds, rect, { top: 0, left: 0 }, { top: NaN, left: 0 }), null);
});
