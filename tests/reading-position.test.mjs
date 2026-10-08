import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createReadingPositionQueue, installReadingPositionLifecycle } from '../src/reading-position.js';

const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), values };
};
const deferred = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const document = (id = 'a', lastPage = 1) => ({ id, lastPage, pageCount: 6 });
const make = (options = {}) => createReadingPositionQueue({ scope: 'library-a', storage: storage(), sessionStorage: storage(), uuid: randomUUID, save: async () => ({}), ...options });

test('opening an unchanged document is read-only; delayed old page serializes before the merged newest page', async () => {
  const old = deferred(), calls = [], queue = make({ save: async (...args) => { calls.push(args); if (args[1] === 2) await old.promise; return {}; } });
  assert.equal(queue.restore(document()), 1);
  queue.enqueue('a', 1); await queue.flush(); assert.deepEqual(calls, []);
  queue.enqueue('a', 2); await tick();
  queue.enqueue('a', 3); queue.enqueue('a', 4); await tick();
  assert.deepEqual(calls.map(call => call[1]), [2]);
  let flushed = false; const final = queue.flush().then(() => { flushed = true; }); await tick(); assert.equal(flushed, false);
  old.resolve(); await final;
  assert.deepEqual(calls.map(call => call[1]), [2, 4]); assert.equal(queue.isPending(), false);
  assert.ok(calls.every(call => call[2].keepalive === true));
  assert.equal(calls[0][2].positionWriterId, calls[1][2].positionWriterId);
  assert.ok(calls[0][2].positionSequence < calls[1][2].positionSequence);
});

test('returning to the previously saved page must still write it after an older in-flight page', async () => {
  const old = deferred(), calls = [], queue = make({ save: async (_id, page) => { calls.push(page); if (page === 2) await old.promise; } });
  queue.restore(document()); queue.enqueue('a', 2); await tick(); queue.enqueue('a', 1); old.resolve(); await queue.flush();
  assert.deepEqual(calls, [2, 1]);
});

test('documents have independent streams, and flush(id) waits only for that document', async () => {
  const a = deferred(), b = deferred(), calls = [], queue = make({ save: async (id, page) => { calls.push([id, page]); await (id === 'a' ? a : b).promise; } });
  queue.restore(document('a')); queue.restore(document('b', 5)); queue.enqueue('a', 2); queue.enqueue('b', 6); await tick();
  assert.deepEqual(calls, [['a', 2], ['b', 6]]); a.resolve(); await queue.flush('a');
  assert.equal(queue.isPending('a'), false); assert.equal(queue.isPending('b'), true); b.resolve(); await queue.flush();
});

test('a clean reopen reads the current server position; an unconfirmed local page remains recoverable', async () => {
  const hold = deferred(), queue = make({ save: async () => hold.promise });
  assert.equal(queue.restore(document()), 1); assert.equal(queue.restore(document('a', 5)), 5);
  queue.enqueue('a', 3); assert.equal(queue.restore(document('a', 6)), 3);
  hold.resolve(); await queue.flush(); assert.equal(queue.restore(document('a', 6)), 6);
});

test('failure retains the latest page and retries the same idempotent token', async () => {
  const local = storage(), session = storage(), first = deferred(), calls = [], errors = [];
  const queue = make({ storage: local, sessionStorage: session, onError: error => errors.push(error.message), save: async (...args) => { calls.push(args); if (calls.length === 1) await first.promise; } });
  queue.restore(document()); queue.enqueue('a', 2); await tick(); queue.enqueue('a', 4);
  const pending = queue.flush(); first.reject(new Error('isolated failure')); await assert.rejects(pending, /isolated failure/);
  assert.equal(queue.isPending(), true); assert.deepEqual(queue.getPending(), [{ documentId: 'a', page: 4 }]);
  const retained = [...local.values.values()].map(value => JSON.parse(value)).find(value => value.page === 4);
  await queue.flush();
  assert.equal(calls[1][1], 4); assert.equal(calls[1][2].positionSequence, retained.positionSequence);
  assert.deepEqual(errors, ['isolated failure']); assert.equal(queue.isPending(), false);
});

test('the acknowledgement of an old snapshot cannot clear a newer retained page', async () => {
  const local = storage(), first = deferred(), last = deferred(), queue = make({ storage: local, save: async (_id, page) => { await (page === 2 ? first : last).promise; } });
  queue.restore(document()); queue.enqueue('a', 2); await tick(); queue.enqueue('a', 4); first.resolve(); await tick();
  assert.equal(queue.isPending(), true); assert.ok([...local.values.values()].some(value => JSON.parse(value).page === 4));
  last.resolve(); await queue.flush(); assert.equal(local.values.size, 0);
});

test('a reload restores only its tab/library pending page, retaining writer and sequence', async () => {
  const local = storage(), session = storage(), before = [], after = [];
  const original = make({ storage: local, sessionStorage: session, save: async (...args) => { before.push(args); throw new Error('offline'); } });
  original.restore(document()); original.enqueue('a', 3); await assert.rejects(original.flush());
  const restored = make({ storage: local, sessionStorage: session, save: async (...args) => { after.push(args); return {}; } });
  assert.equal(restored.restore(document()), 3); restored.enqueue('a', 3); await restored.flush();
  assert.equal(after[0][2].positionWriterId, before[0][2].positionWriterId);
  assert.equal(after[0][2].positionSequence, before[0][2].positionSequence);
  restored.enqueue('a', 5); await restored.flush(); assert.ok(after[1][2].positionSequence > after[0][2].positionSequence);
  assert.equal(make({ storage: local, sessionStorage: storage() }).restore(document()), 1);
  assert.equal(make({ scope: 'library-b', storage: local, sessionStorage: session }).restore(document()), 1);
});

test('a duplicated draft pointer cannot cause either mounted page to clear the other page slot', async () => {
  const local = storage(), originalSession = storage(), copySession = storage();
  const original = make({ storage: local, sessionStorage: originalSession, save: async () => { throw new Error('offline'); } });
  original.restore(document()); original.enqueue('a', 2); await assert.rejects(original.flush());
  for (const [key, value] of originalSession.values) copySession.setItem(key, value);
  const copied = make({ storage: local, sessionStorage: copySession });
  assert.equal(copied.restore(document()), 2); copied.enqueue('a', 2); await copied.flush();
  assert.equal(make({ storage: local, sessionStorage: originalSession }).restore(document()), 2);
  assert.equal(make({ storage: local, sessionStorage: copySession }).restore(document()), 1);
});

test('damaged, cross-document and out-of-range recovery records never become writes', async () => {
  for (const value of ['bad json', JSON.stringify({ documentId: 'b', page: 3 }), JSON.stringify({ documentId: 'a', page: 7 })]) {
    const local = storage(), session = storage(); session.setItem('paperdesk-reading-position-library-a-slot-a', 'paperdesk-reading-position-library-a-a-old');
    local.setItem('paperdesk-reading-position-library-a-a-old', value);
    const queue = make({ storage: local, sessionStorage: session }); assert.equal(queue.restore(document()), 1); assert.equal(queue.isPending(), false);
  }
});

test('storage errors are reported while memory queue and flush still save safely', async () => {
  const errors = [], calls = [], broken = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
  const queue = make({ storage: broken, onStorageError: error => errors.push(error.message), save: async (_id, page) => calls.push(page) });
  queue.restore(document()); queue.enqueue('a', 2); queue.enqueue('a', 3); await queue.flush();
  assert.deepEqual(calls, [3]); assert.deepEqual(errors, ['quota']); assert.equal(queue.isPending(), false);
});

test('stale API acknowledgements do not pretend the pending page was saved', async () => {
  const queue = make({ save: async () => ({ positionStale: true }) }); queue.restore(document()); queue.enqueue('a', 2);
  await assert.rejects(queue.flush(), /较新的位置保存/); assert.equal(queue.isPending(), true);
});

test('a cloned writer conflict preserves the latest page and separates writer identity for a deliberate retry', async () => {
  for (const outcome of ['stale', 'conflict']) {
    const calls = [], queue = make({ save: async (...args) => {
      calls.push(args);
      if (calls.length > 1) return {};
      if (outcome === 'stale') return { positionStale: true };
      const error = new Error('copied writer conflict'); error.status = 409; throw error;
    } });
    queue.restore(document()); queue.enqueue('a', 3); await assert.rejects(queue.flush());
    assert.equal(queue.isPending(), true); await queue.flush();
    assert.equal(calls[1][1], 3); assert.notEqual(calls[0][2].positionWriterId, calls[1][2].positionWriterId);
    assert.equal(queue.isPending(), false);
  }
});

test('pagehide does not send a latest page in parallel; beforeunload warns and cleanup removes listeners', async () => {
  const listeners = new Map(), target = { addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: name => listeners.delete(name) };
  const old = deferred(), calls = [], queue = make({ save: async (_id, page) => { calls.push(page); if (page === 2) await old.promise; } });
  const uninstall = installReadingPositionLifecycle(queue, target);
  queue.restore(document()); queue.enqueue('a', 2); await tick(); queue.enqueue('a', 4);
  let warned = false; const event = { preventDefault: () => { warned = true; } }; listeners.get('beforeunload')(event);
  assert.equal(warned, true); assert.equal(event.returnValue, ''); listeners.get('pagehide')(); await tick(); assert.deepEqual(calls, [2]);
  old.resolve(); await queue.flush(); assert.deepEqual(calls, [2, 4]); uninstall(); assert.equal(listeners.size, 0);
});

test('online retries retained failures and malformed positions are rejected before transmission', async () => {
  const listeners = new Map(), target = { addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: name => listeners.delete(name) };
  let offline = true; const queue = make({ save: async () => { if (offline) throw new Error('offline'); } });
  installReadingPositionLifecycle(queue, target); queue.restore(document()); queue.enqueue('a', 3); await assert.rejects(queue.flush());
  offline = false; listeners.get('online')(); await queue.flush(); assert.equal(queue.isPending(), false);
  for (const page of [0, -1, 1.5, '2', NaN]) assert.throws(() => queue.enqueue('a', page), /Invalid/);
});
