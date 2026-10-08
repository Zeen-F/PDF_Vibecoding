import assert from 'node:assert/strict';
import test from 'node:test';
import { canRetryAnnotationAttempt, createAnnotationDraftStore, recoverableSelection, selectionTarget } from '../src/annotation-drafts.mjs';

class MemoryStorage {
  constructor(source) { this.items = new Map(source?.items); this.failWrites = false; }
  get length() { return this.items.size; }
  key(index) { return [...this.items.keys()][index] ?? null; }
  getItem(key) { return this.items.get(String(key)) ?? null; }
  setItem(key, value) { if (this.failWrites) throw new Error('Synthetic quota failure'); this.items.set(String(key), String(value)); }
  removeItem(key) { if (this.failWrites) throw new Error('Synthetic storage failure'); this.items.delete(String(key)); }
}

const textSelection = (overrides = {}) => ({
  documentId: 'synthetic-document-a', kind: 'text', page: 2,
  quote: 'Original synthetic quotation', rects: [{ x: .1, y: .2, width: .3, height: .04 }],
  ...overrides,
});
const annotation = (overrides = {}) => ({
  id: 'synthetic-annotation-a', documentId: 'synthetic-document-a', comment: 'Saved comment',
  color: 'yellow', updatedAt: '2026-10-08T00:00:00.000Z', ...overrides,
});
function setup({ local = new MemoryStorage(), session = new MemoryStorage(), owner = 'window-a', library = 'synthetic-library-a' } = {}) {
  const store = createAnnotationDraftStore({ local, session, owner });
  if (library) store.setLibrary(library);
  return { local, session, store };
}

test('drafts require a confirmed library and cannot silently switch libraries', () => {
  const { store } = setup({ library: null });
  assert.equal(store.hasDrafts(), false);
  assert.throws(() => store.write({ ...store.newDraft(textSelection()), comment: 'Pending library identity' }), /文献库/);
  assert.throws(() => store.setLibrary(''), /文献库/);
  store.setLibrary('synthetic-library-a');
  assert.doesNotThrow(() => store.setLibrary('synthetic-library-a'));
  assert.throws(() => store.setLibrary('synthetic-library-b'), /切换/);
});

test('library namespace prevents the same document and annotation identifiers from recovering another library draft', () => {
  const first = setup();
  first.store.write(first.store.editDraft(annotation(), 'Only library A'));
  const other = setup({ local: first.local, session: first.session, owner: 'window-b', library: 'synthetic-library-b' });
  assert.equal(other.store.edit(annotation()), null);
  assert.deepEqual(other.store.list(annotation().documentId), []);
  assert.deepEqual(other.store.history(annotation().documentId), []);
  assert.equal(other.store.hasDrafts(), false);
});

test('new drafts recover the exact document, page, quote and geometry without storing preview images', () => {
  const { store, local } = setup();
  const selected = textSelection({ preview: 'data:image/png;base64,SYNTHETIC', image: { data: 'synthetic' } });
  const written = store.write({ ...store.newDraft(selected), comment: 'Text comment', color: 'green' });
  assert.deepEqual(written.selection, textSelection());
  assert.equal(store.newDraft(selected).requestId, written.requestId);
  assert.equal(store.newDraft(selected).comment, 'Text comment');
  for (const changed of [
    textSelection({ documentId: 'synthetic-document-b' }), textSelection({ page: 3 }),
    textSelection({ quote: 'Different quotation' }), textSelection({ rects: [{ x: .11, y: .2, width: .3, height: .04 }] }),
  ]) {
    const separate = store.newDraft(changed);
    assert.notEqual(separate.target, written.target);
    assert.notEqual(separate.requestId, written.requestId);
    assert.equal(separate.comment, '');
  }
  assert.doesNotMatch([...local.items.values()].join(''), /data:image|preview|SYNTHETIC/);
});

test('region drafts retain page and rectangle but remove preview and invented quotation', () => {
  const { store } = setup();
  const region = textSelection({ kind: 'region', quote: 'Must not be recovered as text', preview: 'synthetic preview' });
  const saved = store.write({ ...store.newDraft(region), comment: 'Region comment' });
  assert.deepEqual(saved.selection, { ...textSelection(), kind: 'region', quote: '' });
  assert.equal(store.newDraft(region).comment, 'Region comment');
  assert.notEqual(selectionTarget(region), selectionTarget(textSelection()));
});

test('refresh recovers both edit and new drafts through the session pointer under a new runtime owner', () => {
  const original = setup();
  const edit = original.store.write(original.store.editDraft(annotation(), 'Unsaved edit'));
  const created = original.store.write({ ...original.store.newDraft(textSelection()), comment: 'Unsaved new comment' });
  const refreshed = setup({ local: original.local, session: original.session, owner: 'refreshed-window' });
  assert.equal(refreshed.store.edit(annotation()).comment, edit.comment);
  assert.equal(refreshed.store.newDraft(textSelection()).requestId, created.requestId);
  assert.equal(refreshed.store.newDraft(textSelection()).comment, created.comment);
  assert.equal(refreshed.store.list(annotation().documentId).length, 2);
  assert.equal(refreshed.store.hasDrafts(), true);
});

test('duplicated windows copy recovery pointers but later typing and successful clearing remain isolated', () => {
  const original = setup();
  const inherited = original.store.write(original.store.editDraft(annotation(), 'Before duplication'));
  const duplicated = setup({ local: original.local, session: new MemoryStorage(original.session), owner: 'window-b' });
  assert.equal(duplicated.store.edit(annotation()).generation, inherited.generation);
  const ownA = original.store.write({ ...inherited, comment: 'Window A typing' });
  const ownB = duplicated.store.write({ ...duplicated.store.edit(annotation()), comment: 'Window B typing' });
  assert.equal(original.store.edit(annotation()).comment, 'Window A typing');
  assert.equal(duplicated.store.edit(annotation()).comment, 'Window B typing');
  assert.equal(duplicated.store.clear(ownB), true);
  assert.equal(duplicated.store.edit(annotation()), null);
  assert.equal(original.store.edit(annotation()).generation, ownA.generation);
  assert.equal(original.local.getItem(ownA.storedKey) !== null, true);
});

test('clearing an inherited draft after refresh never removes its live original window slot', () => {
  const original = setup();
  const inherited = original.store.write(original.store.editDraft(annotation(), 'Original window draft'));
  const duplicate = setup({ local: original.local, session: new MemoryStorage(original.session), owner: 'window-b' });
  const recovered = duplicate.store.edit(annotation());
  assert.equal(duplicate.store.clear(recovered), true);
  assert.equal(original.local.getItem(inherited.storedKey) !== null, true);
  assert.equal(original.store.edit(annotation()).comment, inherited.comment);
  const reloadedDuplicate = setup({ local: original.local, session: duplicate.session, owner: 'window-b-reload' });
  assert.equal(reloadedDuplicate.store.edit(annotation()), null);
  assert.equal(reloadedDuplicate.store.hasDrafts(), false);
  assert.equal(reloadedDuplicate.store.history(annotation().documentId)[0].comment, inherited.comment);
});

test('successful save clears only the submitted generation and preserves typing after the request began', () => {
  const { store, local } = setup();
  const submitted = store.write(store.editDraft(annotation(), 'Submitted comment'));
  const newer = store.write({ ...submitted, comment: 'Typing while saving' });
  assert.notEqual(submitted.generation, newer.generation);
  assert.equal(store.clear(submitted), false);
  assert.equal(store.edit(annotation()).comment, newer.comment);
  assert.equal(store.hasDrafts(), true);
  assert.equal(store.clear(newer), true);
  assert.equal(store.edit(annotation()), null);
  assert.equal(store.hasDrafts(), false);
  assert.equal(local.getItem(newer.storedKey), null);
});

test('an uncertain creation attempt keeps its immutable request body and request identifier across refresh', () => {
  const original = setup();
  const draft = original.store.newDraft(textSelection());
  const body = { ...draft.selection, documentId: undefined, comment: 'Submitted once', color: 'pink', requestId: draft.requestId };
  const firstAttemptAt = '2026-10-08T00:00:00.000Z';
  const submitted = original.store.write({ ...draft, comment: body.comment, color: body.color, attempt: { body, firstAttemptAt } });
  const refreshed = setup({ local: original.local, session: original.session, owner: 'after-request-failure' });
  const retry = refreshed.store.newDraft(textSelection());
  assert.equal(retry.requestId, submitted.requestId);
  assert.deepEqual(retry.attempt.body, body);
  assert.equal(retry.attempt.firstAttemptAt, firstAttemptAt);
  assert.equal(refreshed.store.clear(retry), true);
  assert.equal(refreshed.store.newDraft(textSelection()).comment, '');
});

test('unconfirmed creation attempts older than the idempotency horizon require manual verification', () => {
  const now = Date.parse('2026-10-08T00:00:00.000Z');
  assert.equal(canRetryAnnotationAttempt({ firstAttemptAt: new Date(now - 29 * 86400000).toISOString() }, now), true);
  for (const firstAttemptAt of [undefined, 'invalid', new Date(now - 30 * 86400000).toISOString(), new Date(now + 86400000).toISOString()]) {
    assert.equal(canRetryAnnotationAttempt({ firstAttemptAt }, now), false);
  }
});

test('unavailable browser storage accessors keep memory drafts and quit protection operational', () => {
  const descriptors = ['localStorage', 'sessionStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  try {
    for (const [name] of descriptors) Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error('Synthetic browser storage denial'); } });
    const store = createAnnotationDraftStore({ owner: 'denied-storage' });
    store.setLibrary('synthetic-library-a');
    const draft = store.write(store.editDraft(annotation(), 'Still in memory'));
    assert.equal(store.storageError, true);
    assert.equal(store.edit(annotation()).comment, draft.comment);
    assert.equal(store.hasDrafts(), true);
    assert.doesNotThrow(() => store.history(annotation().documentId));
  } finally {
    for (const [name, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  }
});

test('local-storage failures preserve the in-memory draft and report that refresh recovery is unavailable', () => {
  const { store, local } = setup();
  local.failWrites = true;
  const draft = store.write(store.editDraft(annotation(), 'Memory-only comment'));
  assert.equal(store.storageError, true);
  assert.equal(store.edit(annotation()).comment, 'Memory-only comment');
  assert.equal(store.list(annotation().documentId).length, 1);
  assert.equal(store.hasDrafts(), true);
  local.failWrites = false;
  const persisted = store.write(draft);
  assert.equal(store.storageError, false);
  assert.equal(local.getItem(persisted.storedKey) !== null, true);
});

test('session-storage failures also preserve the current window draft until recovery storage becomes available', () => {
  const { store, session } = setup();
  session.failWrites = true;
  const draft = store.write(store.editDraft(annotation(), 'Pointer write failed'));
  assert.equal(store.storageError, true);
  assert.equal(store.edit(annotation()).comment, 'Pointer write failed');
  assert.equal(store.hasDrafts(), true);
  session.failWrites = false;
  store.write(draft);
  assert.equal(store.storageError, false);
});

test('conflict recovery refuses to replace a memory-only editor unless its complete draft can be archived', () => {
  const { store, local } = setup();
  store.write(store.editDraft(annotation(), 'Older persisted draft'));
  local.failWrites = true;
  const latest = store.write({ ...store.edit(annotation()), comment: 'Latest memory-only comment' });
  assert.throws(() => store.clear(latest, { archive: true }), /仍在编辑区/);
  assert.equal(store.edit(annotation()).comment, latest.comment);
  assert.equal(store.hasDrafts(), true);
  local.failWrites = false;
  assert.equal(store.clear(latest, { archive: true }), true);
  assert.equal(store.edit(annotation()), null);
  assert.ok(store.history(annotation().documentId).some(value => value.comment === latest.comment));
});

test('history is read-only and never automatically loads drafts from unrelated windows', () => {
  const original = setup();
  const old = original.store.write(original.store.editDraft(annotation(), 'Historical window comment'));
  const fresh = setup({ local: original.local, session: new MemoryStorage(), owner: 'independent-window' });
  const beforeLocal = new Map(original.local.items), beforeSession = new Map(fresh.session.items);
  assert.equal(fresh.store.edit(annotation()), null);
  const history = fresh.store.history(annotation().documentId);
  assert.equal(history.length, 1);
  assert.equal(history[0].generation, old.generation);
  assert.equal(fresh.store.edit(annotation()), null);
  assert.equal(fresh.store.hasDrafts(), false);
  assert.deepEqual(original.local.items, beforeLocal);
  assert.deepEqual(fresh.session.items, beforeSession);
});

test('malformed or mismatched stored drafts are rejected without reaching an active editor', () => {
  const original = setup();
  const saved = original.store.write({ ...original.store.newDraft(textSelection()), comment: 'Valid synthetic draft' });
  const serialized = JSON.parse(original.local.getItem(saved.storedKey));
  for (const invalid of [
    '{invalid json', JSON.stringify({ ...serialized, documentId: 'another-document' }),
    JSON.stringify({ ...serialized, color: 'invalid' }), JSON.stringify({ ...serialized, comment: 42 }),
    JSON.stringify({ ...serialized, generation: null }),
    JSON.stringify({ ...serialized, selection: { ...serialized.selection, rects: [null] } }),
    JSON.stringify({ ...serialized, attempt: { body: { ...serialized.selection, requestId: 'different-request', color: 'yellow', comment: '' } } }),
  ]) {
    const local = new MemoryStorage(original.local);
    local.setItem(saved.storedKey, invalid);
    const refreshed = setup({ local, session: new MemoryStorage(original.session), owner: 'invalid-recovery' });
    assert.doesNotThrow(() => refreshed.store.get(saved.documentId, saved.target));
    assert.equal(refreshed.store.get(saved.documentId, saved.target), null);
    assert.equal(refreshed.store.newDraft(textSelection()).comment, '');
    assert.deepEqual(refreshed.store.list(saved.documentId), []);
  }
});

test('invalid rectangle values are rejected safely by recoverableSelection', () => {
  for (const invalid of [null, undefined, false, 1, 'invalid', [], { x: NaN, y: .2, width: .3, height: .04 },
    { x: -.1, y: .2, width: .3, height: .04 }, { x: .9, y: .2, width: .3, height: .04 }]) {
    assert.equal(recoverableSelection(textSelection({ rects: [invalid] })), null);
  }
});

test('a corrupt historical slot does not hide later valid history', () => {
  const original = setup();
  original.store.write(original.store.editDraft(annotation(), 'Damaged history'));
  const corruptKey = original.local.key(0);
  original.local.setItem(corruptKey, '{invalid json');
  const other = setup({ local: original.local, session: new MemoryStorage(), owner: 'valid-history-window' });
  other.store.write(other.store.editDraft(annotation(), 'Valid history after corrupt slot'));
  const fresh = setup({ local: original.local, session: new MemoryStorage(), owner: 'history-reader' });
  assert.deepEqual(fresh.store.history(annotation().documentId).map(entry => entry.comment), ['Valid history after corrupt slot']);
  assert.equal(fresh.store.hasDrafts(), false);
});

test('a corrupt recovery pointer does not hide another valid pending draft during quit checks', () => {
  const original = setup();
  original.store.write(original.store.editDraft(annotation(), 'Damaged pending draft'));
  original.local.setItem(original.local.key(0), '{invalid json');
  original.store.write(original.store.editDraft(annotation({ id: 'synthetic-annotation-b' }), 'Still unsaved'));
  const refreshed = setup({ local: original.local, session: original.session, owner: 'quit-check-window' });
  assert.equal(refreshed.store.hasDrafts(), true);
  assert.deepEqual(refreshed.store.list(annotation().documentId).map(entry => entry.comment), ['Still unsaved']);
});
