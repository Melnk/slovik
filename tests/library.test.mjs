import assert from "node:assert/strict";
import test from "node:test";
import {
  LIBRARY_LIMITS,
  parseBackup,
  readStoredDecks,
  readStoredSession,
  removeStoredValue,
  serializeBackup,
  updateDeckContent,
  validateDecks,
  validateSession,
  writeStoredValue,
} from "../app/lib/library.ts";

function sampleDeck(overrides = {}) {
  return {
    id: "travel", title: "Travel", createdAt: 123, lastScore: 50, sessions: 2,
    cards: [
      { id: "a", front: "journey", back: "путешествие" },
      { id: "b", front: "luggage", back: "багаж" },
    ],
    ...overrides,
  };
}

function sampleSession(overrides = {}) {
  return {
    deckId: "travel", mode: "learn", queue: ["a", "b"], cardIndex: 0,
    flipped: false, reverse: false, answers: [], reviewMastered: [], savedAt: 123,
    ...overrides,
  };
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("legacy libraries migrate without losing IDs, cards or scores", () => {
  const original = sampleDeck();
  const validated = validateDecks([original]);
  assert.deepEqual(validated, [{ ...original, history: [] }]);
  validated[0].cards[0].front = "changed";
  assert.equal(original.cards[0].front, "journey");
  assert.deepEqual(validateDecks([]), []);
});

test("deck validation rejects broken shapes, duplicate IDs and invalid boundaries", () => {
  const original = sampleDeck();
  const invalid = [
    null, {}, [null], [{ ...original, cards: [] }],
    [original, original],
    [{ ...original, title: " " }],
    [{ ...original, title: "a".repeat(LIBRARY_LIMITS.title + 1) }],
    [{ ...original, cards: [{ id: "a", front: "", back: "word" }] }],
    [{ ...original, cards: [{ id: "a", front: "a", back: "b" }, { id: "a", front: "c", back: "d" }] }],
    [{ ...original, cards: [{ id: "a", front: "a", back: "x".repeat(LIBRARY_LIMITS.side + 1) }] }],
    [{ ...original, createdAt: -1 }], [{ ...original, createdAt: 1.5 }],
    [{ ...original, lastScore: Number.NaN }], [{ ...original, lastScore: 101 }],
    [{ ...original, sessions: -1 }], [{ ...original, sessions: 1.1 }],
    [{ ...original, id: "__proto__" }],
  ];
  for (const value of invalid) assert.throws(() => validateDecks(value));
});

test("review and history survive validation and are independently copied", () => {
  const original = sampleDeck({
    mistakes: { a: 3 },
    review: { a: { dueAt: 456, intervalDays: 2.5, streak: 1, reviewedAt: 123 } },
    history: [{ at: 123, correct: 1, total: 2 }],
  });
  const [validated] = validateDecks([original]);
  assert.deepEqual(validated, original);
  validated.review.a.streak = 10;
  validated.history[0].correct = 0;
  assert.equal(original.review.a.streak, 1);
  assert.equal(original.history[0].correct, 1);
});

test("metadata for removed cards and invalid history are rejected", () => {
  const invalid = [
    { mistakes: { removed: 2 } }, { mistakes: { a: -1 } }, { mistakes: [] },
    { review: { removed: { dueAt: 1, intervalDays: 1, streak: 1, reviewedAt: 1 } } },
    { review: { a: { dueAt: 1, intervalDays: -1, streak: 1, reviewedAt: 1 } } },
    { review: { a: { dueAt: 1, intervalDays: 1, streak: 0.5, reviewedAt: 1 } } },
    { history: [{ at: 1, correct: 3, total: 2 }] },
    { history: [{ at: 1, correct: 0, total: 0 }] }, { history: {} },
  ];
  for (const metadata of invalid) assert.throws(() => validateDecks([sampleDeck(metadata)]));
});

test("sessions restore only when the deck, queue and atomic answer position agree", () => {
  const decks = [sampleDeck()];
  const initial = sampleSession();
  assert.deepEqual(validateSession(initial, decks), initial);
  const answered = sampleSession({ cardIndex: 1, answers: [true], flipped: true });
  assert.deepEqual(validateSession(answered, decks), answered);
  assert.notEqual(validateSession(initial, decks).queue, initial.queue);
});

test("invalid sessions cannot restore out of range or inconsistent progress", () => {
  const decks = [sampleDeck()];
  const invalid = [
    null, {}, sampleSession({ deckId: "missing" }), sampleSession({ mode: "quiz" }),
    sampleSession({ queue: [] }), sampleSession({ queue: ["missing"] }),
    sampleSession({ queue: ["a", "a"] }), sampleSession({ cardIndex: -1 }),
    sampleSession({ cardIndex: 0.5 }), sampleSession({ cardIndex: 2 }),
    sampleSession({ flipped: 1 }), sampleSession({ reverse: "false" }),
    sampleSession({ cardIndex: 1, answers: ["true"] }),
    sampleSession({ answers: [true] }), sampleSession({ cardIndex: 1, answers: [] }),
    sampleSession({ reviewMastered: undefined }), sampleSession({ reviewMastered: ["a"] }),
    sampleSession({ savedAt: Number.POSITIVE_INFINITY }),
  ];
  for (const snapshot of invalid) assert.equal(validateSession(snapshot, decks), null);
});

test("review sessions allow repeated failed cards and preserve mastered cards", () => {
  const decks = [sampleDeck()];
  const retry = sampleSession({ mode: "review", queue: ["a", "b", "a"], cardIndex: 1, answers: [false] });
  assert.deepEqual(validateSession(retry, decks), retry);
  const mastered = sampleSession({ mode: "review", cardIndex: 1, answers: [true], reviewMastered: ["a"] });
  assert.deepEqual(validateSession(mastered, decks), mastered);
  assert.equal(validateSession({ ...mastered, reviewMastered: ["b"] }, decks), null);
  assert.equal(validateSession({ ...mastered, reviewMastered: ["a", "a"] }, decks), null);
  assert.equal(validateSession({ ...mastered, reviewMastered: [] }, decks), null);
  assert.equal(validateSession({ ...mastered, queue: ["a", "a", "b"] }, decks), null);
});

test("backup round trip preserves all learning data and handles empty libraries", () => {
  const decks = validateDecks([sampleDeck({
    mistakes: { b: 2 },
    review: { b: { dueAt: 456, intervalDays: 4, streak: 2, reviewedAt: 123 } },
    history: [{ at: 123, correct: 1, total: 2 }],
  })]);
  assert.deepEqual(parseBackup(serializeBackup(decks)), decks);
  assert.deepEqual(parseBackup(serializeBackup([])), []);
  assert.equal(JSON.parse(serializeBackup(decks)).format, "slovik-backup");
});

test("backup rejects malformed, future and oversized files before import", () => {
  for (const value of ["{", "null", "[]", JSON.stringify({ format: "other", version: 1, decks: [] }),
    JSON.stringify({ format: "slovik-backup", version: 2, decks: [] }),
    JSON.stringify({ format: "slovik-backup", version: 1, decks: [{}] })]) {
    assert.throws(() => parseBackup(value));
  }
  // Cyrillic proves the limit is measured in bytes, not UTF-16 string length.
  assert.throws(() => parseBackup("я".repeat(LIBRARY_LIMITS.backupBytes / 2 + 1)), /10 МБ/);
});

test("editing translations retains IDs and progress, removes deleted metadata", () => {
  const original = sampleDeck({
    mistakes: { a: 2, b: 4 },
    review: {
      a: { dueAt: 456, intervalDays: 4, streak: 2, reviewedAt: 123 },
      b: { dueAt: 789, intervalDays: 1, streak: 0, reviewedAt: 123 },
    },
    history: [{ at: 123, correct: 1, total: 2 }],
  });
  const updated = updateDeckContent(original, " Updated travel ", [
    { front: "journey", back: "поездка" },
    { front: "departure", back: "отправление" },
  ]);
  assert.equal(updated.title, "Updated travel");
  assert.equal(updated.id, original.id);
  assert.equal(updated.cards[0].id, "a");
  assert.equal(updated.cards[0].back, "поездка");
  assert.match(updated.cards[1].id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(updated.mistakes, { a: 2 });
  assert.deepEqual(updated.review, { a: original.review.a });
  assert.deepEqual(updated.history, original.history);
  assert.equal(updated.sessions, original.sessions);
  assert.equal(updated.lastScore, original.lastScore);
  assert.deepEqual(original.mistakes, { a: 2, b: 4 });
  assert.equal(original.cards[0].back, "путешествие");
});

test("exact pairs retain the right progress when the same word has several translations", () => {
  const original = sampleDeck({ cards: [
    { id: "run-verb", front: "run", back: "бежать" },
    { id: "run-noun", front: "run", back: "пробежка" },
  ] });
  const updated = updateDeckContent(original, "Running", [
    { front: "run", back: "бегать" },
    { front: "run", back: "бежать" },
  ]);
  assert.deepEqual(updated.cards.map((card) => card.id), ["run-noun", "run-verb"]);
});

test("reordering and capitalization edits retain IDs and reject duplicate pairs", () => {
  const original = sampleDeck();
  const updated = updateDeckContent(original, "Travel", [
    { front: "LUGGAGE", back: " багаж " },
    { front: "journey", back: "путешествие" },
  ]);
  assert.deepEqual(updated.cards.map((card) => card.id), ["b", "a"]);
  assert.throws(() => updateDeckContent(original, "Travel", []));
  assert.throws(() => updateDeckContent(original, " ", original.cards));
  assert.throws(() => updateDeckContent(original, "Travel", [
    { front: "run", back: "бег" }, { front: " RUN ", back: "бег" },
  ]));
});

test("missing browser data is distinct from an intentionally empty saved library", () => {
  const storage = memoryStorage({ empty: "[]" });
  assert.deepEqual(readStoredDecks(storage, "missing"), { ok: true, decks: null });
  assert.deepEqual(readStoredDecks(storage, "empty"), { ok: true, decks: [] });
  assert.deepEqual(readStoredSession(storage, "missing", [sampleDeck()]), { ok: true, session: null });
});

test("invalid stored originals remain available unchanged for recovery", () => {
  for (const original of ["{broken", "[null]", ""]) {
    const storage = memoryStorage({ library: original });
    const result = readStoredDecks(storage, "library");
    assert.equal(result.ok, false);
    assert.equal(result.original, original);
    assert.equal(storage.getItem("library"), original);
  }
  const originalSession = JSON.stringify(sampleSession({ cardIndex: -1 }));
  const storage = memoryStorage({ session: originalSession });
  assert.equal(readStoredSession(storage, "session", [sampleDeck()]).ok, false);
  assert.equal(storage.getItem("session"), originalSession);
});

test("stored sessions validate and restore independently of the caller's objects", () => {
  const session = sampleSession({ cardIndex: 1, answers: [false] });
  const storage = memoryStorage({ session: JSON.stringify(session) });
  assert.deepEqual(readStoredSession(storage, "session", [sampleDeck()]), { ok: true, session });
});

test("unavailable, full or denied storage returns failures without throwing", () => {
  const blocked = {
    getItem() { throw new Error("SecurityError"); },
    setItem() { throw new Error("QuotaExceededError"); },
    removeItem() { throw new Error("SecurityError"); },
  };
  assert.deepEqual(readStoredDecks(blocked, "library"), { ok: false, error: "SecurityError", original: null });
  assert.equal(readStoredSession(blocked, "session", [sampleDeck()]).ok, false);
  assert.deepEqual(writeStoredValue(blocked, "library", []), { ok: false, error: "QuotaExceededError" });
  assert.deepEqual(removeStoredValue(blocked, "session"), { ok: false, error: "SecurityError" });
});

test("safe storage writes and removes JSON while serialization failures retain existing data", () => {
  const storage = memoryStorage({ library: "original" });
  const circular = {};
  circular.self = circular;
  assert.equal(writeStoredValue(storage, "library", circular).ok, false);
  assert.equal(writeStoredValue(storage, "library", undefined).ok, false);
  assert.equal(storage.getItem("library"), "original");
  assert.deepEqual(writeStoredValue(storage, "library", []), { ok: true });
  assert.equal(storage.getItem("library"), "[]");
  assert.deepEqual(removeStoredValue(storage, "library"), { ok: true });
  assert.equal(storage.getItem("library"), null);
});
