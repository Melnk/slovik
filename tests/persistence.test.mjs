import test from "node:test";
import assert from "node:assert/strict";
import { readLibrary, saveLibrary, LIBRARY_KEY } from "../app/lib/persistence.ts";

const deck = { id: "d", title: "Words", cards: [{ id: "c", front: "one", back: "один" }], createdAt: 1, lastScore: 0, sessions: 0 };
const store = () => {
  const data = new Map();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
};

test("migrates old decks without modifying their original storage", () => {
  const storage = store();
  const original = JSON.stringify([deck]);
  storage.setItem("slovik-decks-v1", original);
  const loaded = readLibrary(storage, []);
  assert.equal(loaded.error, "");
  assert.equal(loaded.decks[0].id, "d");
  assert.equal(saveLibrary(storage, loaded, loaded.baseline).ok, true);
  assert.equal(storage.getItem("slovik-decks-v1"), original);
});

test("invalid JSON and unavailable storage never overwrite the original", () => {
  const storage = store();
  storage.setItem(LIBRARY_KEY, "{broken");
  const loaded = readLibrary(storage, [deck]);
  assert.ok(loaded.error);
  assert.equal(loaded.original, "{broken");
  assert.equal(storage.getItem(LIBRARY_KEY), "{broken");
  assert.ok(readLibrary({ getItem() { throw new Error("SecurityError"); } }, []).error);
  assert.equal(saveLibrary({ getItem: () => null, setItem() { throw new Error("QuotaExceededError"); } }, { decks: [deck], session: null }, null).ok, false);
});

test("a damaged active session keeps healthy decks and the complete recovery record", () => {
  const storage = store();
  const original = JSON.stringify({ format: "slovik-library", version: 2, decks: [deck], session: { deckId: "d", cardIndex: -1 } });
  storage.setItem(LIBRARY_KEY, original);
  const loaded = readLibrary(storage, []);
  assert.equal(loaded.decks[0].id, "d");
  assert.equal(loaded.session, null);
  assert.ok(loaded.error);
  assert.equal(loaded.original, original);
  assert.equal(storage.getItem(LIBRARY_KEY), original);
});

test("a stale tab cannot replace newer library data", () => {
  const storage = store();
  const first = saveLibrary(storage, { decks: [deck], session: null }, null);
  assert.equal(first.ok, true);
  const second = saveLibrary(storage, { decks: [], session: null }, first.baseline);
  assert.equal(second.ok, true);
  const stale = saveLibrary(storage, { decks: [deck], session: null }, first.baseline);
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true);
  assert.equal(storage.getItem(LIBRARY_KEY), second.baseline);
});

test("an answer, review metadata and next card are committed as one snapshot", () => {
  const storage = store();
  const state = { decks: [{ ...deck, mistakes: { c: 1 } }], session: null };
  const saved = saveLibrary(storage, state, null);
  assert.equal(saved.ok, true);
  const loaded = readLibrary(storage, []);
  assert.equal(loaded.decks[0].mistakes.c, 1);
  assert.equal(loaded.session, null);
});

test("invalid updates leave the previous valid library and session intact", () => {
  const storage = store();
  const session = {
    deckId: "d", mode: "learn", queue: ["c"], cardIndex: 0,
    flipped: true, reverse: false, answers: [], reviewMastered: [], savedAt: 123,
  };
  const first = saveLibrary(storage, { decks: [deck], session }, null);
  assert.equal(first.ok, true);

  const invalidStates = [
    // Completing one more session must not poison an otherwise readable library.
    { decks: [{ ...deck, history: Array.from({ length: 10001 }, () => ({ at: 1, correct: 1, total: 1 })) }], session },
    { decks: [{ ...deck, sessions: -1 }], session },
    { decks: [{ ...deck, mistakes: { removed: 1 } }], session },
    // This is the old animation-gap snapshot: answered card but unchanged index.
    { decks: [deck], session: { ...session, answers: [true] } },
  ];
  for (const state of invalidStates) {
    const result = saveLibrary(storage, state, first.baseline);
    assert.equal(result.ok, false);
    assert.equal(result.conflict, false);
    assert.equal(storage.getItem(LIBRARY_KEY), first.baseline);
    const loaded = readLibrary(storage, []);
    assert.equal(loaded.error, "");
    assert.equal(loaded.decks[0].id, "d");
    assert.deepEqual(loaded.session, session);
  }
});
