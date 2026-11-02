export type WordCard = { id: string; front: string; back: string };

export type CardReview = {
  dueAt: number;
  intervalDays: number;
  streak: number;
  reviewedAt: number;
};

export type StudyRecord = { at: number; correct: number; total: number };

export type Deck = {
  id: string;
  title: string;
  cards: WordCard[];
  createdAt: number;
  lastScore: number;
  sessions: number;
  mistakes?: Record<string, number>;
  review?: Record<string, CardReview>;
  history?: StudyRecord[];
};

export type SessionSnapshot = {
  deckId: string;
  mode: "learn" | "review";
  queue: string[];
  cardIndex: number;
  flipped: boolean;
  reverse: boolean;
  answers: boolean[];
  reviewMastered: string[];
  savedAt: number;
};

export const LIBRARY_LIMITS = {
  title: 120,
  side: 2000,
  cardsPerDeck: 2000,
  decks: 500,
  totalCards: 50000,
  history: 10000,
  backupBytes: 10 * 1024 * 1024,
} as const;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(message: string): never {
  throw new Error(message);
}

function requiredText(value: unknown, limit: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) {
    return fail(`${label}: требуется текст длиной от 1 до ${limit} символов`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  const id = requiredText(value, 500, label);
  if (id === "prototype" || Object.hasOwn(Object.prototype, id)) {
    return fail(`${label}: недопустимый идентификатор`);
  }
  return id;
}

function finiteNumber(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    return fail(`${label}: недопустимое число`);
  }
  return value;
}

function integer(value: unknown, min: number, max: number, label: string): number {
  const number = finiteNumber(value, min, max, label);
  if (!Number.isSafeInteger(number)) return fail(`${label}: требуется целое число`);
  return number;
}

function timestamp(value: unknown, label: string): number {
  return integer(value, 0, 8640000000000000, label);
}

function validateDeck(value: unknown, position: number): Deck {
  const label = `Набор ${position + 1}`;
  if (!isObject(value)) return fail(`${label}: неверный формат`);
  if (!Array.isArray(value.cards) || value.cards.length === 0 || value.cards.length > LIBRARY_LIMITS.cardsPerDeck) {
    return fail(`${label}: требуется от 1 до ${LIBRARY_LIMITS.cardsPerDeck} карточек`);
  }

  const cardIds = new Set<string>();
  const cards = value.cards.map((card, index): WordCard => {
    if (!isObject(card)) return fail(`${label}, карточка ${index + 1}: неверный формат`);
    const id = identifier(card.id, `${label}, ID карточки`);
    if (cardIds.has(id)) return fail(`${label}: повторяется ID карточки`);
    cardIds.add(id);
    return {
      id,
      front: requiredText(card.front, LIBRARY_LIMITS.side, `${label}, слово`),
      back: requiredText(card.back, LIBRARY_LIMITS.side, `${label}, перевод`),
    };
  });

  const deck: Deck = {
    id: identifier(value.id, `${label}, ID`),
    title: requiredText(value.title, LIBRARY_LIMITS.title, `${label}, название`),
    cards,
    createdAt: timestamp(value.createdAt, `${label}, дата создания`),
    lastScore: finiteNumber(value.lastScore, 0, 100, `${label}, результат`),
    sessions: integer(value.sessions, 0, Number.MAX_SAFE_INTEGER, `${label}, подходы`),
    history: [],
  };

  if (value.mistakes !== undefined) {
    if (!isObject(value.mistakes)) return fail(`${label}: неверный формат ошибок`);
    deck.mistakes = Object.fromEntries(Object.entries(value.mistakes).map(([id, count]) => {
      if (!cardIds.has(id)) return fail(`${label}: ошибки относятся к неизвестной карточке`);
      return [id, integer(count, 0, Number.MAX_SAFE_INTEGER, `${label}, число ошибок`)];
    }));
  }

  if (value.review !== undefined) {
    if (!isObject(value.review)) return fail(`${label}: неверный формат повторения`);
    deck.review = Object.fromEntries(Object.entries(value.review).map(([id, review]) => {
      if (!cardIds.has(id) || !isObject(review)) return fail(`${label}: неверные данные повторения карточки`);
      return [id, {
        dueAt: timestamp(review.dueAt, `${label}, следующее повторение`),
        intervalDays: finiteNumber(review.intervalDays, 0, 36500, `${label}, интервал повторения`),
        streak: integer(review.streak, 0, Number.MAX_SAFE_INTEGER, `${label}, серия ответов`),
        reviewedAt: timestamp(review.reviewedAt, `${label}, последнее повторение`),
      }];
    }));
  }

  if (value.history !== undefined) {
    if (!Array.isArray(value.history) || value.history.length > LIBRARY_LIMITS.history) {
      return fail(`${label}: неверный формат истории подходов`);
    }
    deck.history = value.history.map((record) => {
      if (!isObject(record)) return fail(`${label}: неверная запись в истории`);
      const total = integer(record.total, 1, Number.MAX_SAFE_INTEGER, `${label}, всего ответов`);
      return {
        at: timestamp(record.at, `${label}, дата подхода`),
        correct: integer(record.correct, 0, total, `${label}, правильные ответы`),
        total,
      };
    });
  }

  return deck;
}

/** Validates and copies legacy v1 decks as well as decks with review metadata. */
export function validateDecks(value: unknown): Deck[] {
  if (!Array.isArray(value) || value.length > LIBRARY_LIMITS.decks) {
    return fail(`Библиотека должна содержать не больше ${LIBRARY_LIMITS.decks} наборов`);
  }
  const ids = new Set<string>();
  let totalCards = 0;
  return value.map((item, index) => {
    const deck = validateDeck(item, index);
    if (ids.has(deck.id)) return fail("В библиотеке повторяется ID набора");
    ids.add(deck.id);
    totalCards += deck.cards.length;
    if (totalCards > LIBRARY_LIMITS.totalCards) return fail("В библиотеке слишком много карточек");
    return deck;
  });
}

/** Invalid or obsolete sessions are rejected instead of restoring partial state. */
export function validateSession(value: unknown, decks: Deck[]): SessionSnapshot | null {
  try {
    if (!isObject(value)) return null;
    if (value.mode !== "learn" && value.mode !== "review") return null;
    if (typeof value.flipped !== "boolean" || typeof value.reverse !== "boolean") return null;
    const deckId = identifier(value.deckId, "ID набора подхода");
    const deck = decks.find((item) => item.id === deckId);
    if (!deck || !Array.isArray(value.queue) || !value.queue.length || value.queue.length > 100000) return null;
    const cardIds = new Set(deck.cards.map((card) => card.id));
    const queue = value.queue.map((id) => identifier(id, "ID карточки подхода"));
    if (queue.some((id) => !cardIds.has(id))) return null;
    if (value.mode === "learn" && new Set(queue).size !== queue.length) return null;
    const cardIndex = integer(value.cardIndex, 0, queue.length - 1, "Текущая карточка");
    if (!Array.isArray(value.answers) || value.answers.length !== cardIndex
      || !value.answers.every((answer) => typeof answer === "boolean")) return null;
    const answers = value.answers as boolean[];
    if (!Array.isArray(value.reviewMastered)) return null;
    const reviewMastered = value.reviewMastered.map((id) => identifier(id, "ID выученной карточки"));
    if (new Set(reviewMastered).size !== reviewMastered.length || reviewMastered.some((id) => !queue.includes(id))) return null;
    if (value.mode === "learn" && reviewMastered.length !== 0) return null;
    if (value.mode === "review") {
      const knownIds = new Set(queue.slice(0, cardIndex).filter((_, index) => answers[index] === true));
      if (knownIds.size !== reviewMastered.length || reviewMastered.some((id) => !knownIds.has(id))) return null;
      if (reviewMastered.length >= new Set(queue).size || reviewMastered.includes(queue[cardIndex])) return null;
    }
    return {
      deckId,
      mode: value.mode,
      queue,
      cardIndex,
      flipped: value.flipped,
      reverse: value.reverse,
      answers: [...answers],
      reviewMastered,
      savedAt: timestamp(value.savedAt, "Дата сохранения подхода"),
    };
  } catch {
    return null;
  }
}

export function parseBackup(text: string): Deck[] {
  if (new TextEncoder().encode(text).byteLength > LIBRARY_LIMITS.backupBytes) {
    return fail("Файл резервной копии превышает 10 МБ");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail("Не удалось прочитать JSON резервной копии");
  }
  if (!isObject(value) || value.format !== "slovik-backup" || value.version !== 1) {
    return fail("Неизвестный формат или версия резервной копии Словика");
  }
  return validateDecks(value.decks);
}

export function serializeBackup(decks: Deck[]): string {
  const backup = JSON.stringify({ format: "slovik-backup", version: 1, decks: validateDecks(decks) }, null, 2);
  if (new TextEncoder().encode(backup).byteLength > LIBRARY_LIMITS.backupBytes) {
    return fail("Резервная копия превышает 10 МБ; экспортируйте меньше наборов");
  }
  return backup;
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

/** Preserves card IDs and their learning progress when a translation is edited. */
export function updateDeckContent(deck: Deck, title: string, pairs: { front: string; back: string }[]): Deck {
  const nextTitle = requiredText(title.trim(), LIBRARY_LIMITS.title, "Название набора");
  if (!pairs.length || pairs.length > LIBRARY_LIMITS.cardsPerDeck) {
    return fail(`В наборе должно быть от 1 до ${LIBRARY_LIMITS.cardsPerDeck} карточек`);
  }
  const cleanedPairs = pairs.map((pair) => ({
    front: requiredText(pair.front.trim(), LIBRARY_LIMITS.side, "Слово"),
    back: requiredText(pair.back.trim(), LIBRARY_LIMITS.side, "Перевод"),
  }));
  const pairKey = (pair: { front: string; back: string }) => JSON.stringify([normalized(pair.front), normalized(pair.back)]);
  const keys = cleanedPairs.map(pairKey);
  if (new Set(keys).size !== keys.length) return fail("В наборе повторяются одинаковые пары слов");
  const usedIds = new Set<string>();
  type Bucket = { cards: WordCard[]; next: number };
  const exactMatches = new Map<string, Bucket>();
  const wordMatches = new Map<string, Bucket>();
  const add = (map: Map<string, Bucket>, key: string, card: WordCard) => {
    const bucket = map.get(key);
    if (bucket) bucket.cards.push(card);
    else map.set(key, { cards: [card], next: 0 });
  };
  for (const card of deck.cards) {
    add(exactMatches, pairKey(card), card);
    add(wordMatches, normalized(card.front), card);
  }
  const take = (map: Map<string, Bucket>, key: string) => {
    const bucket = map.get(key);
    if (!bucket) return undefined;
    while (bucket.next < bucket.cards.length) {
      const card = bucket.cards[bucket.next++];
      if (!usedIds.has(card.id)) {
        usedIds.add(card.id);
        return card;
      }
    }
    return undefined;
  };
  const matches = keys.map((key) => take(exactMatches, key));
  const cards = cleanedPairs.map((pair, index): WordCard => {
    const match = matches[index] ?? take(wordMatches, normalized(pair.front));
    return { id: match?.id ?? globalThis.crypto.randomUUID(), ...pair };
  });
  const remainingIds = new Set(cards.map((card) => card.id));
  const nextDeck: Deck = { ...deck, title: nextTitle, cards };
  if (deck.mistakes) nextDeck.mistakes = Object.fromEntries(Object.entries(deck.mistakes).filter(([id]) => remainingIds.has(id)));
  if (deck.review) nextDeck.review = Object.fromEntries(Object.entries(deck.review).filter(([id]) => remainingIds.has(id)));
  return validateDecks([nextDeck])[0];
}

export type StorageFailure = { ok: false; error: string; original?: string | null };
export type StorageResult<T> = ({ ok: true } & T) | StorageFailure;
type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;
type StorageRemover = Pick<Storage, "removeItem">;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Хранилище браузера недоступно";
}

/** Reads never overwrite or delete an invalid original; callers can offer recovery. */
export function readStoredDecks(storage: StorageReader, key: string): StorageResult<{ decks: Deck[] | null }> {
  let original: string | null = null;
  try {
    original = storage.getItem(key);
    return { ok: true, decks: original === null ? null : validateDecks(JSON.parse(original)) };
  } catch (error) {
    return { ok: false, error: errorMessage(error), original };
  }
}

export function readStoredSession(storage: StorageReader, key: string, decks: Deck[]): StorageResult<{ session: SessionSnapshot | null }> {
  let original: string | null = null;
  try {
    original = storage.getItem(key);
    if (original === null) return { ok: true, session: null };
    const session = validateSession(JSON.parse(original), decks);
    if (!session) return { ok: false, error: "Сохранённый подход повреждён или больше не соответствует набору", original };
    return { ok: true, session };
  } catch (error) {
    return { ok: false, error: errorMessage(error), original };
  }
}

export function writeStoredValue(storage: StorageWriter, key: string, value: unknown): StorageResult<Record<never, never>> {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return { ok: false, error: "Не удалось подготовить данные к сохранению" };
    storage.setItem(key, serialized);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export function removeStoredValue(storage: StorageRemover, key: string): StorageResult<Record<never, never>> {
  try {
    storage.removeItem(key);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
