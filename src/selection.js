// Keep PDF.js' positioned text untouched; only its DOM reading order is changed.
const preparedLayers = new WeakMap();
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 1;
}

function boundsOf(items) {
  const x = Math.min(...items.map(item => item.x));
  const y = Math.min(...items.map(item => item.y));
  const right = Math.max(...items.map(item => item.x + item.width));
  const bottom = Math.max(...items.map(item => item.y + item.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** Convert a client rectangle into the page's unrotated, top-left coordinates. */
export function unrotateRect(rect, paperBounds, rotation = 0) {
  const left = rect.left - paperBounds.left;
  const top = rect.top - paperBounds.top;
  const width = rect.width ?? rect.right - rect.left;
  const height = rect.height ?? rect.bottom - rect.top;
  switch (((rotation % 360) + 360) % 360) {
    case 90: return { x: top, y: paperBounds.width - left - width, width: height, height: width };
    case 180: return { x: paperBounds.width - left - width, y: paperBounds.height - top - height, width, height };
    case 270: return { x: paperBounds.height - top - height, y: left, width: height, height: width };
    default: return { x: left, y: top, width, height };
  }
}

function projectionGaps(items, axis) {
  const size = axis === 'x' ? 'width' : 'height';
  const intervals = items.map(item => [item[axis], item[axis] + item[size]]).sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let end = intervals[0][1];
  for (const [start, nextEnd] of intervals.slice(1)) {
    if (start > end) gaps.push({ size: start - end, at: (start + end) / 2 });
    end = Math.max(end, nextEnd);
  }
  return gaps.sort((a, b) => b.size - a.size);
}

function splitAt(items, axis, at) {
  return [items.filter(item => item[axis] < at), items.filter(item => item[axis] >= at)];
}

function lineGroups(items) {
  const lines = [];
  for (const item of [...items].sort((a, b) => a.y + a.height / 2 - b.y - b.height / 2 || a.x - b.x || a.sourceIndex - b.sourceIndex)) {
    let best;
    let bestDistance = Infinity;
    for (const line of lines) {
      const box = line.box;
      const overlap = Math.min(box.y + box.height, item.y + item.height) - Math.max(box.y, item.y);
      const bottomDistance = Math.abs(box.y + box.height - item.y - item.height);
      const sameLine = overlap >= Math.min(box.height, item.height) * 0.5
        || bottomDistance <= Math.max(box.height, item.height) * 0.25;
      const distance = Math.abs(box.y + box.height / 2 - item.y - item.height / 2);
      if (sameLine && distance < bestDistance) { best = line; bestDistance = distance; }
    }
    if (best) { best.items.push(item); best.box = boundsOf(best.items); }
    else lines.push({ items: [item], box: boundsOf([item]) });
  }
  lines.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  return lines.map(line => line.items.sort((a, b) => a.x - b.x || a.sourceIndex - b.sourceIndex));
}

function readingBlocks(items, depth = 0) {
  if (items.length < 2 || depth >= 32) return lineGroups(items);
  const box = boundsOf(items);
  const height = median(items.map(item => item.height).filter(value => value > 0));
  // A real gutter must be wider than normal word spacing, and separate blocks
  // that coexist vertically. This avoids mistaking widely spaced words for columns.
  const vertical = projectionGaps(items, 'x').find(gap => {
    if (gap.size < Math.max(height * 1.25, box.width * 0.025)) return false;
    const [left, right] = splitAt(items, 'x', gap.at);
    if (left.length < 2 || right.length < 2) return false;
    const a = boundsOf(left), b = boundsOf(right);
    const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return a.height > height * 1.5 && b.height > height * 1.5
      && overlap > Math.min(a.height, b.height) * 0.5;
  });
  if (vertical) {
    const [left, right] = splitAt(items, 'x', vertical.at);
    return [...readingBlocks(left, depth + 1), ...readingBlocks(right, depth + 1)];
  }
  // Spanning headings/footers hide column gutters in a whole-page projection.
  // First isolate sections at an actual horizontal whitespace gap, then retry.
  const horizontal = projectionGaps(items, 'y').find(gap => gap.size >= height * 0.55);
  if (horizontal) {
    const [top, bottom] = splitAt(items, 'y', horizontal.at);
    return [...readingBlocks(top, depth + 1), ...readingBlocks(bottom, depth + 1)];
  }
  return lineGroups(items);
}

function orderingBoxes(items) {
  return items.map(item => {
    let baseline;
    let bestDistance = Infinity;
    for (const candidate of items) {
      // Only short, visibly smaller runs immediately beside normal-sized text
      // qualify. A nearby paragraph or a whole small-print line must not attach.
      if (candidate === item || item.height <= 0 || candidate.height <= 0
        || item.height > candidate.height * 0.8 || item.height < candidate.height * 0.3
        || item.width > candidate.height * 3) continue;
      const leftGap = item.x - candidate.x - candidate.width;
      const rightGap = candidate.x - item.x - item.width;
      const nearLeft = leftGap >= -candidate.height * 0.15 && leftGap <= candidate.height * 0.6;
      const nearRight = rightGap >= -candidate.height * 0.15 && rightGap <= candidate.height * 0.6;
      if (!nearLeft && !nearRight) continue;
      const top = item.y - candidate.y;
      const bottom = item.y + item.height - candidate.y - candidate.height;
      const raised = top < -candidate.height * 0.1 && top >= -candidate.height * 0.85
        && bottom < -candidate.height * 0.15;
      const lowered = bottom > candidate.height * 0.1 && bottom <= candidate.height * 0.65
        && top > candidate.height * 0.15;
      if (!raised && !lowered) continue;
      const gap = Math.min(nearLeft ? Math.abs(leftGap) : Infinity, nearRight ? Math.abs(rightGap) : Infinity);
      const distance = gap + Math.abs(item.y + item.height / 2 - candidate.y - candidate.height / 2) * 0.1;
      if (distance < bestDistance) { baseline = candidate; bestDistance = distance; }
    }
    // These boxes are solely for ordering and XY-cut. Keep the original geometry
    // for callers, the DOM, selection rectangles, and spacing between text runs.
    return {
      original: item, sourceIndex: item.sourceIndex, x: item.x, width: item.width,
      y: baseline?.y ?? item.y, height: baseline?.height ?? item.height,
    };
  });
}

/** Pure geometric reading-order helper. Items use unrotated x/y/width/height. */
export function orderTextItems(items) {
  if (!items.length) return [];
  const indexed = items.map((item, sourceIndex) => ({ ...item, sourceIndex: item.sourceIndex ?? sourceIndex }));
  return readingBlocks(orderingBoxes(indexed)).flatMap((lineItems, line) => lineItems.map(item => ({ ...item.original, line })));
}

function textSpans(layer) {
  // PDF.js' default textContentSource has direct, positioned span children.
  // Do not move marked-content wrappers or any non-text helper elements.
  return [...layer.children].filter(element => element.tagName === 'SPAN' && !element.querySelector('span') && element.textContent.length > 0);
}

/** Reorder native-selectable text without changing PDF text, styles, or positions. */
export function prepareTextLayer(layer, { rotation = 0, paperBounds } = {}) {
  if (!layer) return [];
  paperBounds ||= layer.parentElement?.getBoundingClientRect() || layer.getBoundingClientRect();
  const items = textSpans(layer).map((span, sourceIndex) => ({
    span, sourceIndex, ...unrotateRect(span.getBoundingClientRect(), paperBounds, rotation),
  }));
  const valid = items.filter(item => [item.x, item.y, item.width, item.height].every(Number.isFinite));
  const ordered = orderTextItems(valid);
  for (const child of [...layer.children]) if (child.tagName === 'BR') child.remove();
  const fragment = layer.ownerDocument.createDocumentFragment();
  let previousLine;
  ordered.forEach((item, index) => {
    if (previousLine !== undefined && previousLine !== item.line) {
      const br = layer.ownerDocument.createElement('br');
      br.setAttribute('role', 'presentation');
      fragment.append(br);
    }
    item.span.dataset.pdfOrder = String(index);
    item.span.dataset.pdfLine = String(item.line);
    fragment.append(item.span);
    previousLine = item.line;
  });
  layer.append(fragment);
  preparedLayers.set(layer, { ordered, rotation });
  return ordered;
}

function normalizeRect(rect, bounds) {
  const rightEdge = rect.right ?? rect.left + rect.width;
  const bottomEdge = rect.bottom ?? rect.top + rect.height;
  const left = Math.max(bounds.left, rect.left), top = Math.max(bounds.top, rect.top);
  const right = Math.min(bounds.left + bounds.width, rightEdge);
  const bottom = Math.min(bounds.top + bounds.height, bottomEdge);
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
  const x = Math.max(0, Math.min(1, (left - bounds.left) / bounds.width));
  const y = Math.max(0, Math.min(1, (top - bounds.top) / bounds.height));
  const width = Math.min(1 - x, (right - left) / bounds.width);
  const height = Math.min(1 - y, (bottom - top) / bounds.height);
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

function selectedIntervals(node, ranges) {
  const intervals = [];
  for (const range of ranges) {
    // comparePoint handles endpoints on wrappers or outside the entire PDF layer.
    // Using offsets only on this exact text node avoids container-sized highlights.
    try {
      if (range.comparePoint(node, 0) > 0 || range.comparePoint(node, node.length) < 0) continue;
    } catch { continue; }
    const start = range.startContainer === node ? range.startOffset : 0;
    const end = range.endContainer === node ? range.endOffset : node.length;
    if (end > start) intervals.push([start, end]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  return merged;
}

function separator(previous, current) {
  if (!previous) return '';
  if (previous.line !== current.line) return /\n$/.test(previous.text) || /^\n/.test(current.text) ? '' : '\n';
  if (previous.span === current.span || /\s$/.test(previous.text) || /^\s/.test(current.text)) return '';
  const last = [...previous.text].at(-1), first = [...current.text][0];
  if (!last || !first || CJK.test(last) || CJK.test(first)) return '';
  if (/[([{“‘]/u.test(last) || /[.,;:!?\])}”’]/u.test(first)) return '';
  const gap = current.box.x - previous.box.x - previous.box.width;
  const threshold = Math.max(0.5, Math.min(previous.box.height, current.box.height) * 0.08);
  return gap > threshold && (LETTER_OR_NUMBER.test(last) || LETTER_OR_NUMBER.test(first)) ? ' ' : '';
}

/** Read exactly the selected PDF text, clipped to text-node Range endpoints. */
export function readPdfSelection(layer, paper, selection = globalThis.window?.getSelection()) {
  if (!layer || !paper || !selection?.rangeCount || selection.isCollapsed) return null;
  const bounds = paper.getBoundingClientRect();
  if (![bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return null;
  const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
  const prepared = preparedLayers.get(layer);
  const rotation = prepared?.rotation || 0;
  const ordered = prepared?.ordered || textSpans(layer).map((span, line) => ({ span, line }));
  const rectangles = new Map();
  const pieces = [];
  for (const item of ordered) {
    if (!layer.contains(item.span)) continue;
    const walker = layer.ownerDocument.createTreeWalker(item.span, 4 /* SHOW_TEXT */);
    let node;
    while ((node = walker.nextNode())) {
      for (const [start, end] of selectedIntervals(node, ranges)) {
        const selected = layer.ownerDocument.createRange();
        selected.setStart(node, start); selected.setEnd(node, end);
        const clientRects = [...selected.getClientRects()];
        const clipped = clientRects.map(rect => normalizeRect(rect, bounds)).filter(Boolean);
        if (!clipped.length) continue;
        for (const rect of clipped) {
          rectangles.set([rect.x, rect.y, rect.width, rect.height].map(value => value.toFixed(6)).join(','), rect);
        }
        const box = unrotateRect(selected.getBoundingClientRect(), bounds, rotation);
        pieces.push({ span: item.span, line: item.line, text: node.data.slice(start, end), box });
      }
    }
  }
  let quote = '';
  let previous;
  for (const piece of pieces) { quote += separator(previous, piece) + piece.text; previous = piece; }
  if (!quote.trim() || !rectangles.size) return null;
  return { quote, rects: [...rectangles.values()] };
}
