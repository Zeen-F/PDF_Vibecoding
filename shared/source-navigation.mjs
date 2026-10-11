const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const PARAMETERS = ['document', 'page', 'pdfSha256', 'capture', 'annotation'];

/** Source links carry identities only. Rectangle coordinates come from the local library. */
export function readSourceLink(search = '') {
  const query = new URLSearchParams(search);
  const documentId = query.get('document'), rawPage = query.get('page');
  const page = rawPage === null ? undefined : /^[1-9]\d*$/.test(rawPage) && Number.isSafeInteger(Number(rawPage)) ? Number(rawPage) : null;
  const pdfSha256 = query.get('pdfSha256'), captureId = query.get('capture'), annotationId = query.get('annotation');
  const invalid = PARAMETERS.some(key => query.getAll(key).length > 1)
    || (documentId !== null && !UUID.test(documentId))
    || (rawPage !== null && (!documentId || page === null))
    || (pdfSha256 !== null && (!documentId || !SHA256.test(pdfSha256)))
    || (captureId !== null && (!UUID.test(captureId) || !documentId || !pdfSha256 || !page))
    || (annotationId !== null && (!UUID.test(annotationId) || !documentId || !page))
    || Boolean(captureId && annotationId);
  return { documentId: documentId?.toLowerCase() || null, page, pdfSha256: pdfSha256?.toLowerCase() || null,
    captureId: captureId?.toLowerCase() || null, annotationId: annotationId?.toLowerCase() || null, invalid };
}

export function sourceLinkSearch(target, search = '') {
  const query = new URLSearchParams(search);
  for (const key of PARAMETERS) query.delete(key);
  if (target?.documentId) {
    query.set('document', target.documentId); query.set('page', String(target.page));
    if (target.pdfSha256) query.set('pdfSha256', target.pdfSha256);
    if (target.captureId) query.set('capture', target.captureId);
    if (target.annotationId) query.set('annotation', target.annotationId);
  }
  return query.toString();
}

export function validSourceRects(rects, maximum = 200) {
  return Array.isArray(rects) && rects.length > 0 && rects.length <= maximum && rects.every(rect => {
    if (!rect || typeof rect !== 'object') return false;
    const { x, y, width, height } = rect;
    return [x, y, width, height].every(Number.isFinite) && x >= 0 && y >= 0 && width > 0 && height > 0
      && x + width <= 1 && y + height <= 1;
  });
}

const key = target => JSON.stringify([target.documentId, target.page, target.pdfSha256 || null,
  target.captureId || null, target.annotationId || null, target.find || '']);

/** In-window reading history, independent from browser Back to the referring app. */
export function createReadingHistory(limit = 100) {
  let entries = [], index = -1;
  return {
    current: () => entries[index] || null,
    destination: offset => entries[index + offset] || null,
    snapshot: () => ({ back: index > 0, forward: index >= 0 && index < entries.length - 1, index, length: entries.length }),
    // Only call after the library acknowledges this deletion. Keep the known
    // physical page, and leave unrelated sources and the history cursor intact.
    forgetAnnotation(documentId, annotationId) {
      entries = entries.map(target => {
        if (target.documentId !== documentId || target.annotationId !== annotationId) return target;
        const { annotationId: removed, ...pageTarget } = target;
        return pageTarget;
      });
      return this.snapshot();
    },
    visit(target, { replace = false, historyIndex } = {}) {
      const saved = structuredClone(target);
      if (Number.isSafeInteger(historyIndex)) {
        if (!entries[historyIndex] || key(entries[historyIndex]) !== key(saved)) throw new Error('阅读历史已变化，请重新选择位置。');
        index = historyIndex; entries[index] = saved;
      } else if (index >= 0 && key(entries[index]) === key(saved)) entries[index] = saved;
      else if (index >= 0 && replace) {
        entries = entries.slice(0, index + 1);
        entries[index] = saved;
      }
      else {
        entries = [...entries.slice(0, index + 1), saved].slice(-limit);
        index = entries.length - 1;
      }
      return this.snapshot();
    },
  };
}
