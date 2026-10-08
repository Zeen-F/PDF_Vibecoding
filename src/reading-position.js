const validPage = page => Number.isSafeInteger(page) && page > 0;
const validWriter = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const validToken = value => validWriter(value?.positionWriterId) && Number.isSafeInteger(value?.positionSequence) && value.positionSequence > 0;
const browserStorage = name => { try { return globalThis[name]; } catch { return undefined; } };

/**
 * Each document has one in-flight write and one latest pending position.
 * Persist the writer/sequence before sending: a reload can replay the same token
 * and the API can reject any older keepalive request that arrives afterwards.
 * Each mounted page owns a separate draft slot, including duplicated tabs.
 */
export function createReadingPositionQueue({ save, scope, onError = () => {}, onStorageError = () => {},
  storage = browserStorage('localStorage'), sessionStorage = browserStorage('sessionStorage'), uuid = () => crypto.randomUUID() } = {}) {
  if (typeof save !== 'function' || typeof scope !== 'string' || !scope) throw new Error('Reading positions require a save function and library identity.');
  const prefix = `paperdesk-reading-position-${encodeURIComponent(scope)}`;
  const writerKey = `${prefix}-writer`, slotId = uuid(), entries = new Map();
  let writer;
  try {
    const value = JSON.parse(sessionStorage?.getItem(writerKey) || 'null');
    if (validWriter(value?.id) && Number.isSafeInteger(value.sequence) && value.sequence >= 0) writer = value;
  } catch {}
  writer ||= { id: uuid(), sequence: 0 };
  let storageFailed = false;
  const storageError = error => { if (!storageFailed) onStorageError(error); storageFailed = true; };
  const nextToken = () => {
    if (writer.sequence === Number.MAX_SAFE_INTEGER) writer = { id: uuid(), sequence: 0 };
    writer.sequence++;
    try { sessionStorage?.setItem(writerKey, JSON.stringify(writer)); } catch (error) { storageError(error); }
    return { positionWriterId: writer.id, positionSequence: writer.sequence };
  };
  const pointerKey = id => `${prefix}-slot-${id}`;
  const slotKey = id => `${prefix}-${id}-${slotId}`;
  const retain = entry => {
    try {
      if (!storage || !sessionStorage) throw new Error('浏览器存储不可用');
      storage.setItem(slotKey(entry.id), JSON.stringify({ documentId: entry.id, page: entry.page, ...entry.token }));
      sessionStorage.setItem(pointerKey(entry.id), slotKey(entry.id));
    } catch (error) { storageError(error); }
  };
  const clear = (entry, snapshot) => {
    try {
      const own = JSON.parse(storage?.getItem(slotKey(entry.id)) || 'null');
      if (own?.page === snapshot.page && own.positionWriterId === snapshot.token.positionWriterId && own.positionSequence === snapshot.token.positionSequence) storage.removeItem(slotKey(entry.id));
      // Never delete another mounted page's slot, including a copied pointer.
      sessionStorage?.setItem(pointerKey(entry.id), 'saved');
    } catch (error) { storageError(error); }
  };
  const read = document => {
    try {
      const key = sessionStorage?.getItem(pointerKey(document.id));
      if (!key || key === 'saved' || !key.startsWith(`${prefix}-${document.id}-`)) return null;
      const value = JSON.parse(storage?.getItem(key) || 'null');
      if (value?.documentId === document.id && validPage(value.page) && value.page <= document.pageCount && validToken(value)) return value;
    } catch {}
    return null;
  };
  const separateCopiedWriter = (entry, snapshot) => {
    if (entry.token?.positionWriterId !== snapshot.token.positionWriterId) return;
    // A browser's duplicate-tab command can clone sessionStorage. Its first
    // conflicting acknowledgement separates this page's writer, while the
    // latest local page remains pending until a subsequent explicit retry.
    writer = { id: uuid(), sequence: 0 };
    entry.token = nextToken(); entry.revision++; retain(entry);
  };
  const kick = entry => {
    if (entry.flight) return entry.flight;
    if (!entry.pending) return Promise.resolve();
    entry.flight = Promise.resolve().then(async () => {
      while (entry.pending) {
        const snapshot = { page: entry.page, token: entry.token, revision: entry.revision };
        let result;
        try { result = await save(entry.id, snapshot.page, { ...snapshot.token, keepalive: true }); }
        catch (error) { if (error.status === 409) separateCopiedWriter(entry, snapshot); throw error; }
        if (result?.positionStale) {
          separateCopiedWriter(entry, snapshot);
          throw new Error('同一阅读窗口已有较新的位置保存，当前页码已保留，请重新翻页后重试。');
        }
        if (entry.revision === snapshot.revision) {
          entry.pending = false; entry.error = null; clear(entry, snapshot);
        }
      }
    }).catch(error => {
      entry.error = error;
      onError(error, entry.id);
      throw error;
    }).finally(() => { entry.flight = null; });
    // enqueue is intentionally fire-and-forget; flush still receives failures.
    entry.flight.catch(() => {});
    return entry.flight;
  };
  return {
    restore(document) {
      if (!document?.id || !validPage(document.pageCount)) throw new Error('Invalid reading document');
      const present = entries.get(document.id);
      if (present) {
        if (!present.pending) present.page = validPage(document.lastPage) && document.lastPage <= document.pageCount ? document.lastPage : 1;
        return present.page;
      }
      const draft = read(document);
      const page = draft?.page ?? (validPage(document.lastPage) && document.lastPage <= document.pageCount ? document.lastPage : 1);
      if (draft?.positionWriterId === writer.id) writer.sequence = Math.max(writer.sequence, draft.positionSequence);
      const entry = { id: document.id, page, token: draft ? { positionWriterId: draft.positionWriterId, positionSequence: draft.positionSequence } : null,
        pending: Boolean(draft), revision: 0, flight: null, error: null };
      entries.set(document.id, entry);
      if (draft) retain(entry);
      return page;
    },
    enqueue(id, page) {
      if (typeof id !== 'string' || !id || !validPage(page)) throw new Error('Invalid reading position');
      let entry = entries.get(id);
      if (!entry) { entry = { id, page: null, token: null, pending: false, revision: 0, flight: null, error: null }; entries.set(id, entry); }
      if (entry.page !== page) {
        entry.page = page; entry.token = nextToken(); entry.revision++; entry.pending = true; entry.error = null; retain(entry);
      }
      if (entry.pending) kick(entry);
    },
    async flush(id) {
      const selected = id === undefined ? [...entries.values()] : [entries.get(id)].filter(Boolean);
      const results = await Promise.allSettled(selected.map(kick));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    },
    isPending(id) { return id === undefined ? [...entries.values()].some(entry => entry.pending) : Boolean(entries.get(id)?.pending); },
    getPending() { return [...entries.values()].filter(entry => entry.pending).map(entry => ({ documentId: entry.id, page: entry.page })); },
  };
}

export function installReadingPositionLifecycle(queue, target = window) {
  const retry = () => { void queue.flush().catch(() => {}); };
  const warn = event => { if (queue.isPending()) { event.preventDefault(); event.returnValue = ''; } };
  target.addEventListener('beforeunload', warn);
  // Every write already uses keepalive. Never send a second write alongside an
  // in-flight one; a retained draft is recovered on this tab's next load.
  target.addEventListener('pagehide', retry);
  target.addEventListener('online', retry);
  target.addEventListener('pageshow', retry);
  return () => {
    target.removeEventListener('beforeunload', warn); target.removeEventListener('pagehide', retry);
    target.removeEventListener('online', retry); target.removeEventListener('pageshow', retry);
  };
}
