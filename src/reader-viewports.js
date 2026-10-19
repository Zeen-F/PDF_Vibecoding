/** Display-only page anchors. Never persisted to the library or PDF. */
export function captureReaderViewport(bounds, rect, documentId, page) {
  if (![bounds.top, bounds.left, rect.top, rect.left, rect.width, rect.height].every(Number.isFinite)
    || rect.width <= 0 || rect.height <= 0 || !documentId || !Number.isSafeInteger(page) || page < 1) return null;
  return { documentId, page, top: (bounds.top - rect.top) / rect.height, left: (bounds.left - rect.left) / rect.width };
}

export function restoreReaderViewport(bounds, rect, scroll, saved) {
  if (!saved || ![saved.top, saved.left, bounds.top, bounds.left, rect.top, rect.left,
    rect.width, rect.height, scroll.top, scroll.left].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
  return { top: scroll.top + rect.top - bounds.top + saved.top * rect.height,
    left: scroll.left + rect.left - bounds.left + saved.left * rect.width };
}
