export const PAGE_LAYOUTS = [1, 2, 4, 6, 9];
export const ZOOMS = ['fit', 'page', '0.8', '1', '1.25', '1.5', '2'];
export const PAGE_GAP = 16;
const PREFERENCES_KEY = 'paperdesk-reader-display';

export function groupStart(page, count) {
  return Math.floor((page - 1) / count) * count + 1;
}

export function layoutShape(count) {
  const columns = count === 1 ? 1 : count === 2 || count === 4 ? 2 : 3;
  return { columns, rows: Math.ceil(count / columns) };
}

export function readDisplayPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || '{}');
    return {
      mode: saved.mode === 'continuous' ? 'continuous' : 'paged',
      count: PAGE_LAYOUTS.includes(saved.count) ? saved.count : 1,
      zoom: ZOOMS.includes(saved.zoom) ? saved.zoom : 'fit',
    };
  } catch { return { mode: 'paged', count: 1, zoom: 'fit' }; }
}

export function saveDisplayPreferences(value) {
  try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(value)); } catch { /* Reading still works when storage is unavailable. */ }
}

/** Keep CSS page size independent from the bounded raster backing store. */
export function rasterRatio(width, height, deviceRatio = 1, pageCount = 1) {
  const maxPixels = 12_000_000 / Math.max(1, pageCount);
  const maxEdge = 4096;
  return Math.min(Math.max(1, deviceRatio), 2, Math.sqrt(maxPixels / Math.max(1, width * height)), maxEdge / Math.max(width, height));
}

export function groupGeometry({ start, pageCount, count, zoom, width, height, dimensions, fallback }) {
  const { columns, rows } = layoutShape(count);
  const caption = count > 1 ? 20 : 0;
  const cellWidth = Math.max(24, (width - PAGE_GAP * (columns - 1)) / columns);
  const cellHeight = Math.max(24, (height - PAGE_GAP * (rows - 1)) / rows - caption);
  const pages = Array.from({ length: Math.min(count, pageCount - start + 1) }, (_, i) => {
    const page = start + i;
    const base = dimensions.get(page) || fallback;
    const scale = zoom === 'fit' ? cellWidth / base.width
      : zoom === 'page' ? Math.min(cellWidth / base.width, cellHeight / base.height) : Number(zoom);
    return { page, scale, width: base.width * scale, height: base.height * scale };
  });
  const columnWidths = Array.from({ length: columns }, (_, column) => zoom === 'fit'
    ? cellWidth : Math.max(0, ...pages.filter((_, i) => i % columns === column).map(p => p.width)));
  const rowHeights = Array.from({ length: Math.ceil(pages.length / columns) }, (_, row) => Math.max(...pages.slice(row * columns, (row + 1) * columns).map(p => p.height + caption)));
  return {
    start, pages, columns, columnWidths,
    width: columnWidths.reduce((sum, value) => sum + value, 0) + PAGE_GAP * (columns - 1),
    height: rowHeights.reduce((sum, value) => sum + value, 0) + PAGE_GAP * Math.max(0, rowHeights.length - 1),
  };
}
