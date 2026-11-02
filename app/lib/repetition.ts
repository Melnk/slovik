import type { CardReview, Deck, WordCard } from "./library.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const INTERVAL_DAYS = [1, 3, 7, 14, 30, 60];

/** A correct scheduled recall advances one step; a forgotten card restarts. */
export function scheduleAnswer(
  previous: CardReview | undefined,
  known: boolean,
  now: number,
): CardReview {
  if (!known) {
    return {
      dueAt: now + RETRY_MS,
      intervalDays: RETRY_MS / DAY_MS,
      streak: 0,
      reviewedAt: now,
    };
  }

  // Extra practice must not inflate mastery or postpone an existing review.
  if (previous && now < previous.dueAt) {
    return { ...previous, reviewedAt: now };
  }

  const streak = Math.min(Number.MAX_SAFE_INTEGER, (previous?.streak ?? 0) + 1);
  const intervalDays = INTERVAL_DAYS[Math.min(streak - 1, INTERVAL_DAYS.length - 1)];

  return {
    dueAt: now + intervalDays * DAY_MS,
    intervalDays,
    streak,
    reviewedAt: now,
  };
}

export function getDueCards(deck: Deck, now: number): WordCard[] {
  return deck.cards.filter((card) => {
    const review = deck.review?.[card.id];
    return review !== undefined && review.dueAt <= now;
  });
}

export function getNewCards(deck: Deck): WordCard[] {
  return deck.cards.filter((card) => deck.review?.[card.id] === undefined);
}

export function getDeckLearningStats(deck: Deck, now: number): {
  newCount: number;
  dueCount: number;
  learnedCount: number;
  nextDueAt: number | null;
} {
  let newCount = 0;
  let dueCount = 0;
  let nextDueAt: number | null = null;

  for (const card of deck.cards) {
    const review = deck.review?.[card.id];
    if (!review) {
      newCount += 1;
    } else if (review.dueAt <= now) {
      dueCount += 1;
    } else if (nextDueAt === null || review.dueAt < nextDueAt) {
      nextDueAt = review.dueAt;
    }
  }

  return {
    newCount,
    dueCount,
    learnedCount: deck.cards.length - newCount,
    nextDueAt,
  };
}

// Encode calendar dates, not elapsed 24-hour blocks: local days can be 23 or 25
// hours long when the browser's timezone switches to or from daylight saving.
function localDayNumber(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}

export function getDailyStats(decks: Deck[], now: number): {
  sessions: number;
  reviewed: number;
  correct: number;
  streakDays: number;
} {
  const today = localDayNumber(now);
  const activeDays = new Set<number>();
  const seenSessions = new Set<string>();
  let sessions = 0;
  let reviewed = 0;
  let correct = 0;

  for (const deck of decks) {
    for (const session of deck.history ?? []) {
      if (session.at > now || !Number.isFinite(session.at) || session.total <= 0) continue;

      // Importing a backup as another deck preserves the original completions.
      const sessionKey = `${session.at}:${session.correct}:${session.total}`;
      if (seenSessions.has(sessionKey)) continue;
      seenSessions.add(sessionKey);

      const day = localDayNumber(session.at);
      activeDays.add(day);

      if (day === today) {
        sessions += 1;
        reviewed += session.total;
        correct += session.correct;
      }
    }
  }

  // Yesterday's streak remains active until the user has had today's chance.
  let day = activeDays.has(today) ? today : today - 1;
  let streakDays = 0;
  while (activeDays.has(day)) {
    streakDays += 1;
    day -= 1;
  }

  return { sessions, reviewed, correct, streakDays };
}
