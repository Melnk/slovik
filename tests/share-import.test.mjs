import assert from "node:assert/strict";
import test from "node:test";
import { commitSharedImport } from "../app/lib/share-import.ts";
import { LIBRARY_KEY, readLibrary, saveLibrary } from "../app/lib/persistence.ts";

function deck(id = "existing") {
  return {
    id, title: id, createdAt: 123, sessions: 2, lastScore: 50,
    cards: [
      { id: `${id}-one`, front: "one", back: "один" },
      { id: `${id}-two`, front: "two", back: "два" },
    ],
    mistakes: { [`${id}-two`]: 1 },
    review: { [`${id}-one`]: { dueAt: 456, intervalDays: 1, streak: 1, reviewedAt: 123 } },
    history: [{ at: 123, correct: 1, total: 2 }],
  };
}

function store() {
  const data = new Map();
  const calls = { reads: 0, writes: 0 };
  return {
    data, calls,
    getItem(key) { calls.reads += 1; return data.get(key) ?? null; },
    setItem(key, value) { calls.writes += 1; data.set(key, value); },
    resetCalls() { calls.reads = 0; calls.writes = 0; },
  };
}

function initial(storage) {
  const saved = saveLibrary(storage, { decks: [deck()], session: null }, null);
  assert.equal(saved.ok, true);
  storage.resetCalls();
  return saved.baseline;
}

function delayedLock(callback) {
  let release;
  const pending = new Promise((resolve) => { release = resolve; }).then(callback);
  return { pending, release };
}

function context(baseline, controller, overrides = {}) {
  return {
    expectedBaseline: baseline,
    expectedRevision: 1,
    getRevision: () => 1,
    signal: controller.signal,
    isCurrent: () => true,
    ...overrides,
  };
}

test("a delayed lock cannot overwrite newer local changes that are not saved yet", async () => {
  const storage = store();
  const baseline = initial(storage);
  const controller = new AbortController();
  let revision = 1;
  const captured = context(baseline, controller, { getRevision: () => revision });
  const lock = delayedLock(() => commitSharedImport(storage, { decks: [deck("shared"), deck()], session: null }, captured));

  // Another action changes React state while the importer waits for the lock;
  // localStorage still has the exact baseline that the importer captured.
  revision += 1;
  lock.release();
  await assert.rejects(lock.pending, /Библиотека изменилась/);
  assert.deepEqual(storage.calls, { reads: 0, writes: 0 });
  assert.equal(storage.data.get(LIBRARY_KEY), baseline);
});

test("dismissing an import while its lock is pending prevents all storage access", async () => {
  const storage = store();
  const baseline = initial(storage);
  const controller = new AbortController();
  const captured = context(baseline, controller);
  const lock = delayedLock(() => commitSharedImport(storage, { decks: [deck("shared"), deck()], session: null }, captured));

  controller.abort();
  lock.release();
  await assert.rejects(lock.pending, /отменено/);
  assert.deepEqual(storage.calls, { reads: 0, writes: 0 });
  assert.equal(storage.data.get(LIBRARY_KEY), baseline);
});

test("changing the current link invalidates a delayed callback even without an abort", async () => {
  const storage = store();
  const baseline = initial(storage);
  const controller = new AbortController();
  let currentLink = "first";
  const captured = context(baseline, controller, { isCurrent: () => currentLink === "first" });
  const lock = delayedLock(() => commitSharedImport(storage, { decks: [deck("first"), deck()], session: null }, captured));

  currentLink = "second";
  lock.release();
  await assert.rejects(lock.pending, /отменено/);
  assert.equal(controller.signal.aborted, false);
  assert.deepEqual(storage.calls, { reads: 0, writes: 0 });
  assert.equal(storage.data.get(LIBRARY_KEY), baseline);
});

test("a valid import commits the new deck, existing progress and active session atomically", async () => {
  const storage = store();
  const baseline = initial(storage);
  const controller = new AbortController();
  const existing = deck();
  const imported = { ...deck("shared"), sessions: 0, lastScore: 0, mistakes: {}, review: {}, history: [] };
  const session = {
    deckId: "existing", mode: "learn", queue: existing.cards.map((card) => card.id),
    cardIndex: 1, flipped: false, reverse: false, answers: [true], reviewMastered: [], savedAt: 200,
  };
  const lock = delayedLock(() => commitSharedImport(storage, { decks: [imported, existing], session }, context(baseline, controller)));
  lock.release();
  const result = await lock.pending;

  assert.equal(result.ok, true);
  assert.deepEqual(storage.calls, { reads: 1, writes: 1 });
  assert.equal(storage.data.get(LIBRARY_KEY), result.baseline);
  const loaded = readLibrary(storage, []);
  assert.equal(loaded.error, "");
  assert.deepEqual(loaded.decks, [imported, existing]);
  assert.deepEqual(loaded.session, session);
});

test("another tab's committed library is retained when a pending import has a stale baseline", async () => {
  const storage = store();
  const baseline = initial(storage);
  const controller = new AbortController();
  const lock = delayedLock(() => commitSharedImport(storage, { decks: [deck("shared"), deck()], session: null }, context(baseline, controller)));
  const newer = saveLibrary(storage, { decks: [deck("other-tab")], session: null }, baseline);
  assert.equal(newer.ok, true);
  storage.resetCalls();
  lock.release();
  const result = await lock.pending;

  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.deepEqual(storage.calls, { reads: 1, writes: 0 });
  assert.equal(storage.data.get(LIBRARY_KEY), newer.baseline);
  assert.equal(readLibrary(storage, []).decks[0].id, "other-tab");
});
