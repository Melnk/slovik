import assert from "node:assert/strict";
import test from "node:test";
import {
  getDailyStats,
  getDeckLearningStats,
  getDueCards,
  getNewCards,
  scheduleAnswer,
} from "../app/lib/repetition.ts";

const DAY_MS = 86_400_000;
const RETRY_MS = 600_000;
const NOW = new Date(2026, 10, 2, 12).getTime();

function makeDeck(overrides = {}) {
  return {
    id: "test-deck",
    title: "Words",
    createdAt: 0,
    lastScore: 0,
    sessions: 0,
    cards: [
      { id: "new", front: "new", back: "новый" },
      { id: "due", front: "due", back: "пора" },
      { id: "later", front: "later", back: "позже" },
    ],
    ...overrides,
  };
}

function history(at, total = 5, correct = 3) {
  return { at, total, correct };
}

test("scheduled correct answers advance through transparent intervals capped at sixty days", () => {
  let previous;
  let now = NOW;

  for (const [index, days] of [1, 3, 7, 14, 30, 60, 60, 60].entries()) {
    const next = scheduleAnswer(previous, true, now);
    assert.deepEqual(next, {
      dueAt: now + days * DAY_MS,
      intervalDays: days,
      streak: index + 1,
      reviewedAt: now,
    });
    previous = next;
    now = next.dueAt;
  }
});

test("a lapse returns a mature card in ten minutes and restarts the success sequence", () => {
  const mature = { dueAt: NOW, intervalDays: 60, streak: 9, reviewedAt: NOW - 60 * DAY_MS };
  const lapse = scheduleAnswer(mature, false, NOW);

  assert.deepEqual(lapse, {
    dueAt: NOW + RETRY_MS,
    intervalDays: RETRY_MS / DAY_MS,
    streak: 0,
    reviewedAt: NOW,
  });
  const retry = scheduleAnswer(lapse, true, lapse.dueAt);
  assert.equal(retry.streak, 1);
  assert.equal(retry.intervalDays, 1);
  assert.equal(retry.dueAt, lapse.dueAt + DAY_MS);
  assert.equal(mature.streak, 9);
});

test("the success counter stays a safe integer at its accepted maximum", () => {
  const previous = {
    dueAt: NOW,
    intervalDays: 60,
    streak: Number.MAX_SAFE_INTEGER,
    reviewedAt: NOW - 60 * DAY_MS,
  };
  const next = scheduleAnswer(previous, true, NOW);

  assert.equal(next.streak, Number.MAX_SAFE_INTEGER);
  assert.ok(Number.isSafeInteger(next.streak));
  assert.equal(next.intervalDays, 60);
  assert.equal(next.dueAt, NOW + 60 * DAY_MS);
});

test("an immediate successful retry cannot skip the ten-minute relearning interval", () => {
  const lapse = scheduleAnswer(undefined, false, NOW);
  const retry = scheduleAnswer(lapse, true, NOW + 1_000);

  assert.equal(retry.dueAt, lapse.dueAt);
  assert.equal(retry.streak, 0);
  assert.equal(retry.intervalDays, lapse.intervalDays);
  assert.equal(retry.reviewedAt, NOW + 1_000);
});

test("extra correct practice preserves the due date and mastery without mutating the old review", () => {
  const previous = Object.freeze({
    dueAt: NOW + DAY_MS,
    intervalDays: 7,
    streak: 3,
    reviewedAt: NOW - 6 * DAY_MS,
  });
  const next = scheduleAnswer(previous, true, NOW);

  assert.deepEqual(next, { ...previous, reviewedAt: NOW });
  assert.notEqual(next, previous);
  assert.equal(previous.reviewedAt, NOW - 6 * DAY_MS);
});

test("a forgotten answer during extra practice still schedules relearning", () => {
  const previous = { dueAt: NOW + 30 * DAY_MS, intervalDays: 30, streak: 5, reviewedAt: NOW };
  const next = scheduleAnswer(previous, false, NOW);
  assert.equal(next.dueAt, NOW + RETRY_MS);
  assert.equal(next.streak, 0);
});

test("due cards exclude new, future, and deleted cards, and include the exact due boundary", () => {
  const deck = makeDeck({
    review: {
      due: { dueAt: NOW, intervalDays: 1, streak: 1, reviewedAt: NOW - DAY_MS },
      later: { dueAt: NOW + 1, intervalDays: 1, streak: 1, reviewedAt: NOW - DAY_MS },
      deleted: { dueAt: NOW - 1, intervalDays: 1, streak: 1, reviewedAt: NOW - DAY_MS },
    },
  });

  assert.deepEqual(getDueCards(deck, NOW).map((card) => card.id), ["due"]);
  assert.deepEqual(getNewCards(deck).map((card) => card.id), ["new"]);
  assert.deepEqual(getDeckLearningStats(deck, NOW), {
    newCount: 1,
    dueCount: 1,
    learnedCount: 2,
    nextDueAt: NOW + 1,
  });
});

test("the next future review ignores overdue dates and chooses the nearest remaining card", () => {
  const deck = makeDeck({
    review: {
      new: { dueAt: NOW + 10, intervalDays: 1, streak: 1, reviewedAt: NOW },
      due: { dueAt: NOW - 1, intervalDays: 1, streak: 1, reviewedAt: NOW - DAY_MS },
      later: { dueAt: NOW + 20, intervalDays: 1, streak: 1, reviewedAt: NOW },
    },
  });
  assert.equal(getDeckLearningStats(deck, NOW).nextDueAt, NOW + 10);
  assert.equal(getDeckLearningStats(deck, NOW + 20).nextDueAt, null);
});

test("legacy decks and empty libraries have honest zero progress", () => {
  const deck = makeDeck({ sessions: 80, lastScore: 100 });
  assert.deepEqual(getDueCards(deck, NOW), []);
  assert.equal(getNewCards(deck).length, 3);
  assert.deepEqual(getDeckLearningStats(deck, NOW), {
    newCount: 3,
    dueCount: 0,
    learnedCount: 0,
    nextDueAt: null,
  });
  assert.deepEqual(getDeckLearningStats(makeDeck({ cards: [] }), NOW), {
    newCount: 0, dueCount: 0, learnedCount: 0, nextDueAt: null,
  });
  assert.deepEqual(getDailyStats([deck], NOW), {
    sessions: 0, reviewed: 0, correct: 0, streakDays: 0,
  });
});

test("today's totals sum actual sessions across decks without inventing history from legacy counters", () => {
  const today = new Date(2026, 10, 2, 9).getTime();
  const yesterday = new Date(2026, 10, 1, 18).getTime();
  const decks = [
    makeDeck({ sessions: 200, history: [history(today, 8, 6), history(yesterday, 12, 7)] }),
    makeDeck({ id: "second", history: [history(today + 1, 4, 4)] }),
    makeDeck({ id: "legacy", sessions: 9 }),
  ];

  assert.deepEqual(getDailyStats(decks, NOW), {
    sessions: 2, reviewed: 12, correct: 10, streakDays: 2,
  });
});

test("importing a backup as a new deck preserves daily totals while later sessions count separately", () => {
  const today = new Date(2026, 10, 2, 9).getTime();
  const original = makeDeck({ history: [
    history(today, 8, 6),
    history(today + 100, 4, 2),
    history(new Date(2026, 10, 1, 18).getTime()),
  ] });
  const importedCopy = makeDeck({
    id: "backup-copy",
    history: original.history.map((session) => ({ ...session })),
  });
  const originalStats = getDailyStats([original], NOW);

  assert.deepEqual(originalStats, {
    sessions: 2, reviewed: 12, correct: 8, streakDays: 2,
  });
  assert.deepEqual(getDailyStats([original, importedCopy], NOW), originalStats);

  const practicedCopy = {
    ...importedCopy,
    history: [...importedCopy.history, history(today + 200, 8, 6)],
  };
  assert.deepEqual(getDailyStats([original, practicedCopy], NOW), {
    sessions: 3, reviewed: 20, correct: 14, streakDays: 2,
  });
});

test("a streak survives until the end of today but stops at a missing calendar day", () => {
  const deck = makeDeck({ history: [
    history(new Date(2026, 10, 1, 20).getTime()),
    history(new Date(2026, 9, 31, 20).getTime()),
    history(new Date(2026, 9, 29, 20).getTime()),
  ] });
  assert.equal(getDailyStats([deck], NOW).streakDays, 2);
  assert.equal(getDailyStats([deck], new Date(2026, 10, 3, 12).getTime()).streakDays, 0);
});

test("duplicate days count once for a streak, while future or empty sessions count as no activity", () => {
  const today = new Date(2026, 10, 2, 9).getTime();
  const deck = makeDeck({ history: [
    history(today),
    history(today + 1),
    history(new Date(2026, 10, 1, 9).getTime()),
    history(new Date(2026, 9, 31, 9).getTime(), 0, 0),
    history(NOW + 1),
    history(Number.NaN),
  ] });
  assert.deepEqual(getDailyStats([deck], NOW), {
    sessions: 2, reviewed: 10, correct: 6, streakDays: 2,
  });
});

test("daily totals and streaks follow local calendar days through both daylight-saving transitions", () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    for (const [month, day] of [[2, 9], [10, 2]]) {
      const now = new Date(2026, month, day, 12).getTime();
      const deck = makeDeck({ history: [
        history(new Date(2026, month, day, 0, 30).getTime()),
        history(new Date(2026, month, day - 1, 0, 30).getTime()),
        history(new Date(2026, month, day - 2, 0, 30).getTime()),
      ] });
      assert.deepEqual(getDailyStats([deck], now), {
        sessions: 1, reviewed: 5, correct: 3, streakDays: 3,
      });
    }

    // 01:00 UTC is still yesterday in New York.
    const now = Date.parse("2026-11-02T17:00:00Z");
    const deck = makeDeck({ history: [history(Date.parse("2026-11-02T01:00:00Z"))] });
    assert.deepEqual(getDailyStats([deck], now), {
      sessions: 0, reviewed: 0, correct: 0, streakDays: 1,
    });
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});
