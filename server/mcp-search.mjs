// Search grants are local user configuration, never tool-call arguments.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateSearchGrant(grant) {
  if (grant === undefined) return undefined;
  if (!grant || Object.keys(grant).some(key => !['documentIds', 'sources', 'expiresAt'].includes(key))
      || !Array.isArray(grant.documentIds) || !grant.documentIds.length || grant.documentIds.length > 20
      || !grant.documentIds.every(id => typeof id === 'string' && UUID.test(id))
      || !Array.isArray(grant.sources) || !grant.sources.length || grant.sources.length > 3
      || !grant.sources.every(source => ['text', 'notes', 'annotation'].includes(source))
      || typeof grant.expiresAt !== 'string' || !Number.isFinite(Date.parse(grant.expiresAt))) {
    throw new Error('搜索授权格式无效；请重新运行插件设置。');
  }
  return { documentIds: [...new Set(grant.documentIds)], sources: [...new Set(grant.sources)], expiresAt: grant.expiresAt };
}
export function searchAllowed(grant, documentIds, sources, now = Date.now()) {
  if (sources.every(source => source === 'title')) return true;
  return Boolean(grant && Date.parse(grant.expiresAt) > now && documentIds.length
    && documentIds.every(id => grant.documentIds.includes(id))
    && sources.every(source => source === 'title' || grant.sources.includes(source)));
}
function boundedString(value, length) {
  const text = String(value ?? '');
  let end = Math.min(length, text.length);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end);
}
export function searchPage(rows, { offset, limit, maxBytes, libraryId, hasMore }) {
  const result = { libraryId, results: [], offset, nextOffset: null, truncated: false };
  for (const row of rows.slice(0, limit)) {
    if (!row || !UUID.test(row.documentId) || !/^[a-f0-9]{64}$/.test(row.pdfSha256)
        || !['title', 'text', 'notes', 'annotation'].includes(row.source)
        || (['text', 'annotation'].includes(row.source) && (!Number.isInteger(row.page) || row.page < 1 || row.page > 2000))
        || (row.source === 'annotation' && (!UUID.test(row.annotationId) || !Array.isArray(row.rects)))) {
      throw new Error('Invalid search source identity');
    }
    const item = {
      documentId: row.documentId, title: boundedString(row.title, 200), pdfSha256: row.pdfSha256,
      page: row.source === 'title' || row.source === 'notes' ? null : row.page,
      source: row.source, sourceId: row.source === 'annotation' ? row.annotationId : row.source === 'text' ? String(row.page) : row.source,
      snippet: boundedString(row.snippet, 242),
    };
    if (row.source === 'annotation') {
      item.annotationId = row.annotationId;
      item.rects = row.rects.slice(0, 8).map(rect => {
        if (!rect || !['x', 'y', 'width', 'height'].every(key => typeof rect[key] === 'number' && Number.isFinite(rect[key]) && rect[key] >= 0 && rect[key] <= 1)
            || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > 1.000001 || rect.y + rect.height > 1.000001) {
          throw new Error('Invalid search source geometry');
        }
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      item.rectsTruncated = (row.rects || []).length > 8;
    }
    // Reserve the complete pagination envelope in the byte budget.
    const candidate = { ...result, results: [...result.results, item], nextOffset: offset + result.results.length + 1, truncated: true };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > maxBytes) {
      // Never return a continuation that cannot advance, even for malformed
      // backend responses or direct helper callers below the tool minimum.
      if (!result.results.length) throw new Error('Search result exceeds the response budget');
      break;
    }
    result.results.push(item);
  }
  result.truncated = result.results.length < rows.length || hasMore;
  result.nextOffset = result.truncated ? offset + result.results.length : null;
  return result;
}
