const PREFIX = 'paperdesk-annotation-draft-';
const POINTER = 'paperdesk-annotation-slot-';
const COLORS = new Set(['yellow', 'green', 'pink']);
const uuid = () => crypto.randomUUID();
const RETRY_WINDOW = 30 * 24 * 60 * 60 * 1000 - 5 * 60 * 1000;

export function canRetryAnnotationAttempt(attempt, now = Date.now()) {
  const started = Date.parse(attempt?.firstAttemptAt);
  return Number.isFinite(started) && started <= now + 5 * 60 * 1000 && now - started < RETRY_WINDOW;
}

// Only page coordinates and text are recovery data. A rendered crop can be
// recreated from the PDF; keeping PNGs here would exhaust browser storage.
export function recoverableSelection(value) {
  if (!value || typeof value.documentId !== 'string' || !Number.isSafeInteger(value.page) || value.page < 1
    || !['text', 'region'].includes(value.kind) || !Array.isArray(value.rects) || !value.rects.length || value.rects.length > 200) return null;
  if (value.rects.some(rect => !rect || typeof rect !== 'object')) return null;
  const rects = value.rects.map(({ x, y, width, height }) => ({ x, y, width, height }));
  if (rects.some(rect => !Object.values(rect).every(Number.isFinite) || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0
    || rect.x + rect.width > 1.000001 || rect.y + rect.height > 1.000001)) return null;
  const quote = value.kind === 'region' ? '' : value.quote;
  if (typeof quote !== 'string' || quote.length > 50000 || (value.kind === 'text' && !quote.trim()) || (value.kind === 'region' && rects.length !== 1)) return null;
  return { documentId: value.documentId, kind: value.kind, page: value.page, quote, rects };
}

export function selectionTarget(value) {
  const selection = recoverableSelection(value);
  if (!selection) throw new Error('无法恢复这份选区，请重新选择原文。');
  // Exact identity is also checked in getSelectionDraft; the compact key never
  // embeds quotations or image data in browser storage keys.
  let hash = 14695981039346656037n;
  for (const char of JSON.stringify(selection)) hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0))) * 1099511628211n);
  return `selection-${hash.toString(16)}`;
}

const editTarget = annotationId => `edit-${annotationId}`;
const content = entry => JSON.stringify({ target: entry.target, comment: entry.comment, color: entry.color, selection: entry.selection, attempt: entry.attempt });

function validEntry(entry, documentId, target) {
  if (!entry || entry.documentId !== documentId || entry.target !== target || typeof entry.comment !== 'string'
    || entry.comment.length > 20000 || !COLORS.has(entry.color) || typeof entry.generation !== 'string') return null;
  if (entry.annotationId) {
    if (target !== editTarget(entry.annotationId) || typeof entry.baseUpdatedAt !== 'string') return null;
  } else {
    const selection = recoverableSelection(entry.selection);
    if (!selection || selection.documentId !== documentId || selectionTarget(selection) !== target || typeof entry.requestId !== 'string') return null;
    entry = { ...entry, selection };
    if (entry.attempt) {
      const attemptSelection = recoverableSelection({ ...entry.attempt.body, documentId });
      if (!attemptSelection || selectionTarget(attemptSelection) !== target || entry.attempt.body.requestId !== entry.requestId
        || typeof entry.attempt.body.comment !== 'string' || entry.attempt.body.comment.length > 20000 || !COLORS.has(entry.attempt.body.color)) return null;
      entry = { ...entry, attempt: { firstAttemptAt: entry.attempt.firstAttemptAt, body: { ...attemptSelection, documentId: undefined, comment: entry.attempt.body.comment, color: entry.attempt.body.color, requestId: entry.requestId } } };
    }
  }
  return entry;
}

export function createAnnotationDraftStore({ local, session, owner = uuid(), onChange = () => {} } = {}) {
  let libraryId = null, storageError = false;
  try { if (local === undefined) local = globalThis.localStorage; } catch { local = null; storageError = true; }
  try { if (session === undefined) session = globalThis.sessionStorage; } catch { session = null; storageError = true; }
  const cache = new Map(), saved = new Set();
  const scope = () => {
    if (!libraryId) throw new Error('正在核对文献库，请稍候再编辑批注。');
    return encodeURIComponent(libraryId);
  };
  const stem = (documentId, target) => `${scope()}-${documentId}-${target}`;
  const key = (documentId, target) => `${PREFIX}${stem(documentId, target)}-${owner}`;
  const pointer = (documentId, target) => `${POINTER}${stem(documentId, target)}`;
  const identity = (documentId, target) => `${documentId}/${target}`;
  const parse = (storedKey, documentId, target) => {
    try { return validEntry(JSON.parse(local.getItem(storedKey) || 'null'), documentId, target); } catch { return null; }
  };
  const changed = failed => { if (failed) storageError = true; onChange(); };
  const get = (documentId, target) => {
    if (!libraryId || saved.has(identity(documentId, target))) return null;
    if (cache.has(identity(documentId, target))) return cache.get(identity(documentId, target));
    try {
      const pointed = session.getItem(pointer(documentId, target));
      const candidates = [key(documentId, target)];
      if (pointed && pointed !== 'saved' && pointed.startsWith(`${PREFIX}${stem(documentId, target)}-`)) candidates.push(pointed);
      for (const storedKey of candidates) {
        const value = parse(storedKey, documentId, target);
        if (value) { const result = { ...value, storedKey }; cache.set(identity(documentId, target), result); return result; }
      }
    } catch { storageError = true; }
    return null;
  };
  const write = entry => {
    const value = { ...entry, generation: uuid(), updatedAt: new Date().toISOString(), storedKey: key(entry.documentId, entry.target) };
    if (value.selection) value.selection = recoverableSelection(value.selection);
    const id = identity(value.documentId, value.target);
    cache.set(id, value); saved.delete(id);
    try {
      const { storedKey, ...persisted } = value;
      local.setItem(storedKey, JSON.stringify(persisted));
      session.setItem(pointer(value.documentId, value.target), storedKey);
      storageError = false; changed();
    } catch { changed(true); }
    return value;
  };
  const clear = (entry, { archive = false } = {}) => {
    const current = get(entry.documentId, entry.target);
    if (!current || current.generation !== entry.generation) return false;
    const id = identity(entry.documentId, entry.target);
    if (archive) {
      // "Keep draft and load saved" must archive the actual editor, including
      // text that failed to reach storage. An old disk slot is not sufficient.
      try {
        const { storedKey, ...persisted } = current;
        local.setItem(`${key(entry.documentId, entry.target)}-archive-${uuid()}`, JSON.stringify(persisted));
        session.setItem(pointer(entry.documentId, entry.target), 'saved');
      } catch {
        changed(true);
        throw new Error('浏览器无法保留完整草稿，评论仍在编辑区。请先复制评论或恢复草稿存储后重试。');
      }
    }
    cache.delete(id); saved.add(id);
    try {
      // Never remove a slot inherited after a reload/duplicated tab: another
      // live window may still own it. This runtime only clears its own slot.
      const owned = parse(key(entry.documentId, entry.target), entry.documentId, entry.target);
      if (!archive && owned?.generation === entry.generation) local.removeItem(key(entry.documentId, entry.target));
      session.setItem(pointer(entry.documentId, entry.target), 'saved');
      changed();
    } catch { changed(true); }
    return true;
  };
  const list = documentId => {
    if (!libraryId) return [];
    try {
      const prefix = `${POINTER}${scope()}-${documentId}-`;
      for (let index = 0; index < session.length; index++) {
        const name = session.key(index);
        if (name?.startsWith(prefix)) get(documentId, name.slice(prefix.length));
      }
    } catch { storageError = true; }
    return [...cache.values()].filter(entry => entry.documentId === documentId && !saved.has(identity(entry.documentId, entry.target)));
  };
  const history = documentId => {
    const own = list(documentId), entries = [], seen = new Set(own.map(content));
    try {
      const prefix = `${PREFIX}${scope()}-${documentId}-`;
      for (let index = 0; index < local.length; index++) {
        const storedKey = local.key(index);
        if (!storedKey?.startsWith(prefix)) continue;
        try {
          const raw = JSON.parse(local.getItem(storedKey) || 'null');
          const value = validEntry(raw, documentId, raw?.target);
          if (!value || own.some(entry => entry.storedKey === storedKey)) continue;
          const signature = content(value);
          if (!seen.has(signature)) { seen.add(signature); entries.push({ ...value, storedKey }); }
        } catch { /* Skip this damaged slot; keep later valid archives visible. */ }
      }
    } catch { /* A damaged historical slot must not affect active editors. */ }
    return entries.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  };
  return {
    setLibrary(id) { if (typeof id !== 'string' || !id) throw new Error('无法核对文献库身份。'); if (libraryId && libraryId !== id) throw new Error('文献库已切换，请刷新后再编辑。'); libraryId = id; changed(); },
    get, write, clear, list, history,
    edit(annotation) { return get(annotation.documentId, editTarget(annotation.id)); },
    newDraft(selection) {
      const target = selectionTarget(selection), existing = get(selection.documentId, target);
      if (existing && JSON.stringify(existing.selection) !== JSON.stringify(recoverableSelection(selection))) throw new Error('选区草稿身份冲突，请先核对保留的草稿。');
      return existing || { documentId: selection.documentId, target, selection: recoverableSelection(selection), requestId: uuid(), comment: '', color: 'yellow' };
    },
    editDraft(annotation, comment) { return { documentId: annotation.documentId, annotationId: annotation.id, target: editTarget(annotation.id), comment, color: annotation.color, baseUpdatedAt: annotation.updatedAt, baseComment: annotation.comment, baseColor: annotation.color }; },
    hasDrafts() {
      if (cache.size) return true;
      if (!libraryId) return false;
      try {
        const prefix = `${POINTER}${scope()}-`;
        for (let index = 0; index < session.length; index++) {
          const name = session.key(index), pointed = name?.startsWith(prefix) ? session.getItem(name) : null;
          if (pointed && pointed !== 'saved') {
            try {
              const raw = JSON.parse(local.getItem(pointed) || 'null');
              if (validEntry(raw, raw?.documentId, raw?.target)) return true;
            } catch { /* Another draft may still require an unload warning. */ }
          }
        }
      } catch { storageError = true; }
      return false;
    },
    get storageError() { return storageError; },
  };
}
