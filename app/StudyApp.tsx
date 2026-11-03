"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import LibraryTools from "./LibraryTools";
import { LIBRARY_LIMITS, serializeBackup, validateDecks, validateSession, type WordCard, type Deck, type SessionSnapshot } from "./lib/library";
import { getDailyStats, getDeckLearningStats, getDueCards, getNewCards, scheduleAnswer } from "./lib/repetition";
import { readLibrary, saveLibrary, LIBRARY_KEY } from "./lib/persistence";
import DeckShareDialog, { SharedDeckImport } from "./DeckSharing";
import { createSharedDeck, decodeSharedDeck, sharedDeckId, type SharedDeck } from "./lib/sharing";
import { commitSharedImport } from "./lib/share-import";

type View = "home" | "study";
type StudyMode = "learn" | "review";

const QUICK_STUDY_CARDS = 10;
const REVIEW_CARDS = 5;
const DIFFICULT_REVIEW_CARDS = 3;
const SAMPLE_TEXT = [
  "journey - путешествие",
  "cozy - уютный",
  "wander - бродить",
  "destination - место назначения",
].join("\n");

const DEMO_DECKS: Deck[] = [
  {
    id: "travel-demo",
    title: "Английский: путешествия",
    createdAt: 1767225600000,
    lastScore: 0,
    sessions: 0,
    cards: [
      ["journey", "путешествие"],
      ["cozy", "уютный"],
      ["wander", "бродить"],
      ["destination", "место назначения"],
      ["luggage", "багаж"],
      ["departure", "отправление"],
    ].map(([front, back], index) => ({ id: `travel-${index}`, front, back })),
  },
];

function parsePairs(value: string) {
  const cards: WordCard[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  value.split(/\r?\n/).forEach((source, index) => {
    const line = source.trim();
    if (!line) return;

    const divider = line.match(/\t+|\s+(?:-|–|—)\s+|[–—]/);
    if (!divider || divider.index === undefined) {
      skipped.push(line);
      return;
    }

    const front = line.slice(0, divider.index).trim();
    const back = line.slice(divider.index + divider[0].length).trim();
    const key = `${front.toLocaleLowerCase()}::${back.toLocaleLowerCase()}`;

    if (!front || !back || seen.has(key)) {
      skipped.push(line);
      return;
    }

    seen.add(key);
    cards.push({ id: `card-${index}-${front}-${back}`, front, back });
  });

  return { cards, skipped };
}

function shuffle<T>(items: T[]) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const nextIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[nextIndex]] = [result[nextIndex], result[index]];
  }
  return result;
}

function selectReviewCards(deck: Deck) {
  const forgottenCards = shuffle(
    deck.cards.filter((card) => (deck.mistakes?.[card.id] ?? 0) > 0),
  ).sort((first, second) => (
    (deck.mistakes?.[second.id] ?? 0) - (deck.mistakes?.[first.id] ?? 0)
  ));
  const difficultCards = forgottenCards.slice(0, DIFFICULT_REVIEW_CARDS);
  const selectedIds = new Set(difficultCards.map((card) => card.id));
  const familiarCards = shuffle(deck.cards.filter((card) => (
    !selectedIds.has(card.id) && (deck.mistakes?.[card.id] ?? 0) === 0
  ))).slice(0, REVIEW_CARDS - difficultCards.length);
  const selectedCards = [...difficultCards, ...familiarCards];

  if (selectedCards.length < REVIEW_CARDS) {
    const remainingCards = shuffle(deck.cards.filter((card) => (
      !selectedCards.some((selected) => selected.id === card.id)
    ))).slice(0, REVIEW_CARDS - selectedCards.length);
    selectedCards.push(...remainingCards);
  }

  return shuffle(selectedCards);
}

function countUniqueCards(cards: WordCard[]) {
  return new Set(cards.map((card) => card.id)).size;
}

function getDifficultCards(deck: Deck) {
  return deck.cards.filter((card) => (deck.mistakes?.[card.id] ?? 0) > 0);
}

function countDifficultCards(deck: Deck) {
  return getDifficultCards(deck).length;
}

function formatSessionCount(count: number) {
  const lastTwoDigits = count % 100;
  const lastDigit = count % 10;
  const noun = lastTwoDigits >= 11 && lastTwoDigits <= 14
    ? "подходов"
    : lastDigit === 1
      ? "подход"
      : lastDigit >= 2 && lastDigit <= 4
        ? "подхода"
        : "подходов";

  return `${count} ${noun}`;
}

function wordCount(count: number) {
  const lastTwo = count % 100;
  const last = count % 10;
  return `${count} ${lastTwo >= 11 && lastTwo <= 14 ? "слов" : last === 1 ? "слово" : last >= 2 && last <= 4 ? "слова" : "слов"}`;
}

function countCurrentStreak(answers: boolean[]) {
  let streak = 0;

  for (let index = answers.length - 1; index >= 0 && answers[index]; index -= 1) {
    streak += 1;
  }

  return streak;
}

function countLongestStreak(answers: boolean[]) {
  let longest = 0;
  let current = 0;

  answers.forEach((answer) => {
    current = answer ? current + 1 : 0;
    longest = Math.max(longest, current);
  });

  return longest;
}

function buildProgressiveHint(answer: string, revealedLetters: number) {
  let letterIndex = 0;

  return Array.from(answer.trim()).map((character) => {
    if (!/[\p{L}\p{N}]/u.test(character)) return character;
    letterIndex += 1;
    return letterIndex <= revealedLetters ? character : "·";
  }).join("");
}

function getSessionStats(snapshot: SessionSnapshot) {
  const total = new Set(snapshot.queue).size;
  const completed = snapshot.mode === "review"
    ? Math.min(snapshot.reviewMastered.length, total)
    : Math.min(snapshot.cardIndex, total);
  const correct = snapshot.answers.filter(Boolean).length;

  return {
    completed,
    total,
    progress: Math.round((completed / Math.max(total, 1)) * 100),
    accuracy: snapshot.answers.length
      ? Math.round((correct / snapshot.answers.length) * 100)
      : 0,
  };
}

export default function StudyApp() {
  const [decks, setDecks] = useState<Deck[]>(DEMO_DECKS);
  const [loaded, setLoaded] = useState(false);
  const [title, setTitle] = useState("Английский для путешествий");
  const [rawText, setRawText] = useState(SAMPLE_TEXT);
  const [deckSearch, setDeckSearch] = useState("");
  const [view, setView] = useState<View>("home");
  const [studyMode, setStudyMode] = useState<StudyMode>("learn");
  const [activeDeckId, setActiveDeckId] = useState<string | null>(null);
  const [studyCards, setStudyCards] = useState<WordCard[]>([]);
  const [cardIndex, setCardIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [reverse, setReverse] = useState(false);
  const [answers, setAnswers] = useState<boolean[]>([]);
  const [reviewMastered, setReviewMastered] = useState<string[]>([]);
  const [switching, setSwitching] = useState(false);
  const [finished, setFinished] = useState(false);
  const [revealedHintLetters, setRevealedHintLetters] = useState(0);
  const [autoPronounce, setAutoPronounce] = useState(false);
  const [deckPreviewOrders, setDeckPreviewOrders] = useState<Record<string, string[]>>({});
  const [hiddenDeckWordIds, setHiddenDeckWordIds] = useState<string[]>([]);
  const [revealedDeckWordKeys, setRevealedDeckWordKeys] = useState<string[]>([]);
  const [hiddenDeckTranslationIds, setHiddenDeckTranslationIds] = useState<string[]>([]);
  const [revealedDeckTranslationKeys, setRevealedDeckTranslationKeys] = useState<string[]>([]);
  const [missedTranslationsHidden, setMissedTranslationsHidden] = useState(false);
  const [revealedMissedTranslationIds, setRevealedMissedTranslationIds] = useState<string[]>([]);
  const [savedSession, setSavedSession] = useState<SessionSnapshot | null>(null);
  const [notice, setNotice] = useState("");
  const [editingDeck, setEditingDeck] = useState<Deck | null>(null);
  const [sharingDeck, setSharingDeck] = useState<Deck | null>(null);
  const [shareBaseUrl, setShareBaseUrl] = useState("");
  const [incomingDeck, setIncomingDeck] = useState<SharedDeck | null>(null);
  const [incomingDeckId, setIncomingDeckId] = useState("");
  const [incomingError, setIncomingError] = useState("");
  const [incomingLoading, setIncomingLoading] = useState(false);
  const [importingShared, setImportingShared] = useState(false);
  const [showImporter, setShowImporter] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [storageConflict, setStorageConflict] = useState(false);
  const [recoveryOriginal, setRecoveryOriginal] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const storageBaselineRef = useRef<string | null>(null);
  const storageBlockedRef = useRef(false);
  const answerLockRef = useRef(false);
  const sharedImportLockRef = useRef(false);
  const sharedImportAbortRef = useRef<AbortController | null>(null);
  const sharedLinkVersionRef = useRef(0);
  const libraryRevisionRef = useRef(0);
  const titleRef = useRef<HTMLInputElement>(null);
  const switchFramesRef = useRef<number[]>([]);

  const parsed = useMemo(() => parsePairs(rawText), [rawText]);
  const visibleDecks = useMemo(() => {
    const query = deckSearch.trim().toLocaleLowerCase();
    return decks.map((deck, deckIndex) => ({ deck, deckIndex })).filter(({ deck }) => (
      !query || deck.title.toLocaleLowerCase().includes(query)
      || deck.cards.some((card) => (
        card.front.toLocaleLowerCase().includes(query)
        || card.back.toLocaleLowerCase().includes(query)
      ))
    ));
  }, [decks, deckSearch]);
  const activeDeck = decks.find((deck) => deck.id === activeDeckId) ?? null;
  const currentCard = studyCards[cardIndex];
  const knownCount = answers.filter(Boolean).length;
  const forgottenCount = answers.length - knownCount;
  const liveAccuracy = Math.round((knownCount / Math.max(answers.length, 1)) * 100);
  const currentStreak = countCurrentStreak(answers);
  const longestStreak = countLongestStreak(answers);
  const savedDeck = savedSession
    ? decks.find((deck) => deck.id === savedSession.deckId) ?? null
    : null;
  const savedStats = savedSession && savedDeck
    ? getSessionStats(savedSession)
    : null;
  const dailyStats = getDailyStats(decks, now);
  const learningStats = decks.map((deck) => ({ deck, ...getDeckLearningStats(deck, now) }));
  const dueCount = learningStats.reduce((sum, deck) => sum + deck.dueCount, 0);
  const newCount = learningStats.reduce((sum, deck) => sum + deck.newCount, 0);
  const recommendedDeck = learningStats.find((deck) => deck.dueCount > 0)?.deck
    ?? learningStats.find((deck) => deck.newCount > 0)?.deck;
  const alreadyAddedDeck = incomingDeckId ? decks.find((deck) => deck.id === incomingDeckId) : undefined;

  useLayoutEffect(() => {
    libraryRevisionRef.current += 1;
  }, [decks, savedSession, activeDeckId, currentCard, finished, answers, cardIndex, flipped, reverse, reviewMastered, studyCards, studyMode, view]);

  useEffect(() => {
    let active = true;
    const readSharedLink = async () => {
      const version = ++sharedLinkVersionRef.current;
      sharedImportAbortRef.current?.abort();
      sharedImportAbortRef.current = null;
      sharedImportLockRef.current = false;
      setImportingShared(false);
      const hash = window.location.hash;
      setShareBaseUrl(window.location.origin);
      setIncomingDeck(null);
      setIncomingDeckId("");
      setIncomingError("");
      if (!hash.startsWith("#deck=")) { setIncomingLoading(false); return; }
      setIncomingLoading(true);
      setView("home");
      try {
        const shared = await decodeSharedDeck(hash.slice(6));
        const id = await sharedDeckId(shared);
        if (!active || version !== sharedLinkVersionRef.current || window.location.hash !== hash) return;
        setIncomingDeck(shared);
        setIncomingDeckId(id);
      } catch (error) {
        if (active && version === sharedLinkVersionRef.current && window.location.hash === hash) setIncomingError(error instanceof Error ? error.message : "Не удалось прочитать ссылку на набор");
      } finally {
        if (active && version === sharedLinkVersionRef.current && window.location.hash === hash) setIncomingLoading(false);
      }
    };
    const timeout = window.setTimeout(() => { void readSharedLink(); }, 0);
    window.addEventListener("hashchange", readSharedLink);
    return () => {
      active = false;
      sharedLinkVersionRef.current += 1;
      sharedImportAbortRef.current?.abort();
      window.clearTimeout(timeout);
      window.removeEventListener("hashchange", readSharedLink);
    };
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        const state = readLibrary(window.localStorage, DEMO_DECKS);
        setDecks(state.decks);
        setSavedSession(state.session);
        storageBaselineRef.current = state.baseline;
        storageBlockedRef.current = Boolean(state.error);
        setStorageError(state.error);
        setRecoveryOriginal(state.original);
      } catch {
        storageBlockedRef.current = true;
        setStorageError("Хранилище браузера недоступно. Скачайте резервную копию перед закрытием вкладки.");
      } finally {
        setNow(Date.now());
        setLoaded(true);
      }
    }, 0);

    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    const refresh = () => setNow(Date.now());
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if ((event.key === LIBRARY_KEY || event.key === null) && event.newValue !== storageBaselineRef.current) {
        storageBlockedRef.current = true;
        setStorageConflict(true);
        setStorageError("Библиотека изменена в другой вкладке. Скачайте копию текущих изменений, затем загрузите обновления.");
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  useEffect(() => {
    if (!loaded || switching || storageBlockedRef.current) return;
    let cancelled = false;
    const session: SessionSnapshot | null = activeDeckId && currentCard
      ? finished ? null : {
        deckId: activeDeckId, mode: studyMode, queue: studyCards.map((card) => card.id),
        cardIndex, flipped, reverse, answers, reviewMastered, savedAt: Date.now(),
      }
      : savedSession;
    const persist = () => {
      if (cancelled || storageBlockedRef.current) return;
      try {
        const result = saveLibrary(window.localStorage, { decks, session }, storageBaselineRef.current);
        if (result.ok) {
          storageBaselineRef.current = result.baseline;
          setStorageError("");
        } else {
          setStorageError(result.error);
          if (result.conflict) {
            storageBlockedRef.current = true;
            setStorageConflict(true);
          }
        }
      } catch {
        setStorageError("Хранилище браузера недоступно. Скачайте резервную копию перед закрытием вкладки.");
      }
    };
    // Serialise writers across tabs where Web Locks is supported. The baseline
    // check also protects stale tabs in browsers without that API.
    if (navigator.locks) void navigator.locks.request("slovik-library", persist).catch(() => {
      if (!cancelled) persist();
    });
    else persist();
    return () => { cancelled = true; };
  }, [activeDeckId, answers, cardIndex, currentCard, decks, finished, flipped, loaded, reverse, reviewMastered, savedSession, studyCards, studyMode, switching, view]);

  useEffect(() => {
    if (!loaded || switching || !activeDeckId || !currentCard || finished) return;

    const snapshot: SessionSnapshot = {
      deckId: activeDeckId,
      mode: studyMode,
      queue: studyCards.map((card) => card.id),
      cardIndex,
      flipped,
      reverse,
      answers,
      reviewMastered,
      savedAt: Date.now(),
    };

    const timeout = window.setTimeout(() => setSavedSession(snapshot), 0);
    return () => window.clearTimeout(timeout);
  }, [activeDeckId, answers, cardIndex, currentCard, finished, flipped, loaded, reverse, reviewMastered, studyCards, studyMode, switching, view]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 3200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const speak = useCallback((text: string, rate = 0.9) => {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      setNotice("Озвучивание не поддерживается в этом браузере");
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = /[\u0400-\u04ff]/.test(text) ? "ru-RU" : "en-US";
    utterance.rate = rate;
    window.speechSynthesis.speak(utterance);
  }, []);

  const speakPair = useCallback((first: string, second: string, rate = 0.9) => {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      setNotice("Озвучивание не поддерживается в этом браузере");
      return;
    }

    window.speechSynthesis.cancel();
    [first, second].forEach((text) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = /[\u0400-\u04ff]/.test(text) ? "ru-RU" : "en-US";
      utterance.rate = rate;
      window.speechSynthesis.speak(utterance);
    });
  }, []);

  const speakCards = useCallback((cards: WordCard[]) => {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      setNotice("Озвучивание не поддерживается в этом браузере");
      return;
    }

    window.speechSynthesis.cancel();
    cards.flatMap((card) => [card.front, card.back]).forEach((text) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = /[\u0400-\u04ff]/.test(text) ? "ru-RU" : "en-US";
      utterance.rate = 0.9;
      window.speechSynthesis.speak(utterance);
    });
  }, []);

  const stopSpeaking = useCallback(() => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    setNotice("Озвучивание остановлено");
  }, []);

  const toggleAutoPronounce = useCallback(() => {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      setNotice("Озвучивание не поддерживается в этом браузере");
      return;
    }

    setAutoPronounce((enabled) => {
      if (enabled) window.speechSynthesis.cancel();
      return !enabled;
    });
  }, []);

  useEffect(() => {
    return () => {
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, [cardIndex, view]);

  useEffect(() => {
    if (!autoPronounce || view !== "study" || finished || switching || !currentCard) return;

    const visibleText = flipped
      ? (reverse ? currentCard.front : currentCard.back)
      : (reverse ? currentCard.back : currentCard.front);
    const timeout = window.setTimeout(() => speak(visibleText), 120);
    return () => window.clearTimeout(timeout);
  }, [autoPronounce, currentCard, finished, flipped, reverse, speak, switching, view]);

  useEffect(() => {
    return () => {
      switchFramesRef.current.forEach((frame) => window.cancelAnimationFrame(frame));
    };
  }, []);

  const clearSavedSession = useCallback(() => {
    setSavedSession(null);
  }, []);

  const finishSession = useCallback((finalAnswers: boolean[]) => {
    if (!activeDeckId) return;
    const completedAt = Date.now();
    setNow(completedAt);
    const score = Math.round((finalAnswers.filter(Boolean).length / Math.max(finalAnswers.length, 1)) * 100);
    setDecks((current) => current.map((deck) => (
      deck.id === activeDeckId
        ? { ...deck, lastScore: score, sessions: Math.min(Number.MAX_SAFE_INTEGER, deck.sessions + 1),
          history: [...(deck.history ?? []), { at: completedAt, correct: finalAnswers.filter(Boolean).length, total: finalAnswers.length }].slice(-LIBRARY_LIMITS.history) }
        : deck
    )));
    clearSavedSession();
    setFinished(true);
  }, [activeDeckId, clearSavedSession]);

  const advanceCard = useCallback(() => {
    setSwitching(true);
    setFlipped(false);
    setRevealedHintLetters(0);

    const contentFrame = window.requestAnimationFrame(() => {
      setCardIndex((index) => index + 1);
      const unlockFrame = window.requestAnimationFrame(() => {
        setSwitching(false);
        answerLockRef.current = false;
        switchFramesRef.current = [];
      });
      switchFramesRef.current = [unlockFrame];
    });
    switchFramesRef.current = [contentFrame];
  }, []);

  const postponeCard = useCallback(() => {
    if (finished || switching || flipped || cardIndex >= studyCards.length - 1) return;
    setSwitching(true);
    setFlipped(false);
    setRevealedHintLetters(0);

    const contentFrame = window.requestAnimationFrame(() => {
      setStudyCards((current) => {
        const next = [...current];
        const [postponed] = next.splice(cardIndex, 1);
        if (postponed) next.push(postponed);
        return next;
      });
      const unlockFrame = window.requestAnimationFrame(() => {
        setSwitching(false);
        switchFramesRef.current = [];
      });
      switchFramesRef.current = [unlockFrame];
    });
    switchFramesRef.current = [contentFrame];
  }, [cardIndex, finished, flipped, studyCards.length, switching]);

  const shuffleRemainingCards = useCallback(() => {
    if (finished || switching || cardIndex >= studyCards.length - 1) return;
    setSwitching(true);
    setFlipped(false);
    setRevealedHintLetters(0);

    const contentFrame = window.requestAnimationFrame(() => {
      setStudyCards((current) => [
        ...current.slice(0, cardIndex),
        ...shuffle(current.slice(cardIndex)),
      ]);
      const unlockFrame = window.requestAnimationFrame(() => {
        setSwitching(false);
        switchFramesRef.current = [];
      });
      switchFramesRef.current = [unlockFrame];
    });
    switchFramesRef.current = [contentFrame];
  }, [cardIndex, finished, studyCards.length, switching]);

  const markAnswer = useCallback((known: boolean) => {
    if (finished || switching || answerLockRef.current || !currentCard || !flipped) return;
    answerLockRef.current = true;
    const nextAnswers = [...answers, known];
    setAnswers(nextAnswers);

    setDecks((current) => current.map((deck) => {
      if (deck.id !== activeDeckId) return deck;
      const currentMistakes = deck.mistakes?.[currentCard.id] ?? 0;
      const nextMistakes = { ...deck.mistakes };
      const nextScore = known ? currentMistakes - 1 : Math.min(Number.MAX_SAFE_INTEGER, currentMistakes + 1);
      if (nextScore > 0) nextMistakes[currentCard.id] = nextScore;
      else delete nextMistakes[currentCard.id];
      return { ...deck, mistakes: nextMistakes,
        review: { ...deck.review, [currentCard.id]: scheduleAnswer(deck.review?.[currentCard.id], known, Date.now()) } };
    }));

    if (studyMode === "review" && activeDeck) {
      const nextQueue = [...studyCards];

      if (known) {
        const nextMastered = reviewMastered.includes(currentCard.id)
          ? reviewMastered
          : [...reviewMastered, currentCard.id];
        const queueWithoutOldRepeats = nextQueue.filter((card, index) => (
          index <= cardIndex || card.id !== currentCard.id
        ));

        setReviewMastered(nextMastered);
        setStudyCards(queueWithoutOldRepeats);

        if (nextMastered.length >= countUniqueCards(studyCards)) {
          finishSession(nextAnswers);
          return;
        }
      } else {
        const earliestRepeat = Math.min(cardIndex + 2, nextQueue.length);
        const latestRepeat = Math.min(cardIndex + 4, nextQueue.length);
        const repeatAt = earliestRepeat + Math.floor(Math.random() * (latestRepeat - earliestRepeat + 1));
        nextQueue.splice(repeatAt, 0, currentCard);
        setStudyCards(nextQueue);
      }

      advanceCard();
      return;
    }

    if (cardIndex >= studyCards.length - 1) {
      finishSession(nextAnswers);
      return;
    }
    advanceCard();
  }, [activeDeck, activeDeckId, advanceCard, answers, cardIndex, currentCard, finishSession, finished, flipped, reviewMastered, studyCards, studyMode, switching]);

  const revealAnswerHint = useCallback(() => {
    if (finished || switching || flipped || !currentCard) return;
    const hiddenAnswer = reverse ? currentCard.front : currentCard.back;
    const hintLetterCount = Array.from(hiddenAnswer).filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
    const maximumHintLetters = Math.max(0, hintLetterCount - 1);
    setRevealedHintLetters((count) => Math.min(count + 1, maximumHintLetters));
  }, [currentCard, finished, flipped, reverse, switching]);

  const toggleStudyDirection = useCallback(() => {
    if (finished || switching) return;
    setReverse((value) => !value);
    setFlipped(false);
    setRevealedHintLetters(0);
  }, [finished, switching]);

  const copyCards = useCallback(async (cards: WordCard[], successMessage: string) => {
    const wordList = cards
      .map((card) => `${card.front} — ${card.back}`)
      .join("\n");

    try {
      await window.navigator.clipboard.writeText(wordList);
      setNotice(successMessage);
    } catch {
      window.prompt("Скопируй список слов", wordList);
    }
  }, []);

  function toggleMissedTranslations() {
    setMissedTranslationsHidden((hidden) => !hidden);
    setRevealedMissedTranslationIds([]);
  }

  function getDeckPreviewCards(deck: Deck) {
    const previewOrder = deckPreviewOrders[deck.id];
    if (!previewOrder) return deck.cards;

    const cardsById = new Map(deck.cards.map((card) => [card.id, card]));
    return previewOrder
      .map((cardId) => cardsById.get(cardId))
      .filter((card): card is WordCard => Boolean(card));
  }

  function shuffleDeckPreview(deck: Deck) {
    setDeckPreviewOrders((current) => {
      const currentOrder = current[deck.id] ?? deck.cards.map((card) => card.id);
      let nextOrder = shuffle(deck.cards.map((card) => card.id));

      if (
        nextOrder.length > 1
        && nextOrder.every((cardId, index) => cardId === currentOrder[index])
      ) {
        nextOrder = [...nextOrder.slice(1), nextOrder[0]];
      }

      return { ...current, [deck.id]: nextOrder };
    });
    setNotice("Порядок слов перемешан");
  }

  function toggleDeckTranslations(deckId: string) {
    const translationsWillBeHidden = !hiddenDeckTranslationIds.includes(deckId);
    setHiddenDeckTranslationIds((ids) => (
      ids.includes(deckId)
        ? ids.filter((id) => id !== deckId)
        : [...ids, deckId]
    ));
    setRevealedDeckTranslationKeys((keys) => (
      keys.filter((key) => !key.startsWith(`${deckId}:`))
    ));
    if (translationsWillBeHidden) {
      setHiddenDeckWordIds((ids) => ids.filter((id) => id !== deckId));
      setRevealedDeckWordKeys((keys) => keys.filter((key) => !key.startsWith(`${deckId}:`)));
    }
  }

  function toggleDeckWords(deckId: string) {
    const wordsWillBeHidden = !hiddenDeckWordIds.includes(deckId);
    setHiddenDeckWordIds((ids) => (
      ids.includes(deckId)
        ? ids.filter((id) => id !== deckId)
        : [...ids, deckId]
    ));
    setRevealedDeckWordKeys((keys) => (
      keys.filter((key) => !key.startsWith(`${deckId}:`))
    ));
    if (wordsWillBeHidden) {
      setHiddenDeckTranslationIds((ids) => ids.filter((id) => id !== deckId));
      setRevealedDeckTranslationKeys((keys) => keys.filter((key) => !key.startsWith(`${deckId}:`)));
    }
  }

  function toggleDeckTranslation(deckId: string, cardId: string) {
    const key = `${deckId}:${cardId}`;
    setRevealedDeckTranslationKeys((keys) => (
      keys.includes(key)
        ? keys.filter((item) => item !== key)
        : [...keys, key]
    ));
  }

  function toggleDeckWord(deckId: string, cardId: string) {
    const key = `${deckId}:${cardId}`;
    setRevealedDeckWordKeys((keys) => (
      keys.includes(key)
        ? keys.filter((item) => item !== key)
        : [...keys, key]
    ));
  }

  function toggleMissedTranslation(cardId: string) {
    setRevealedMissedTranslationIds((ids) => (
      ids.includes(cardId)
        ? ids.filter((id) => id !== cardId)
        : [...ids, cardId]
    ));
  }

  useEffect(() => {
    if (view !== "study" || finished) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (event.key === "Escape" && !event.repeat) {
        event.preventDefault();
        setView("home");
      }
      if (event.code === "Space" && !event.repeat && !switching && !target?.closest("button, a, summary")) {
        event.preventDefault();
        setFlipped((value) => !value);
      }
      if (event.key === "ArrowLeft" && !event.repeat && flipped && !switching) { event.preventDefault(); markAnswer(false); }
      if (event.key === "ArrowRight" && !event.repeat && flipped && !switching) { event.preventDefault(); markAnswer(true); }
      if (event.code === "KeyH" && event.shiftKey && !event.repeat && !flipped && !switching && revealedHintLetters > 0) {
        event.preventDefault();
        setRevealedHintLetters(0);
      } else if (event.code === "KeyH" && !event.repeat && !flipped && !switching) {
        event.preventDefault();
        revealAnswerHint();
      }
      if (event.code === "KeyR" && !event.repeat && !flipped && !switching && cardIndex < studyCards.length - 1) {
        event.preventDefault();
        postponeCard();
      }
      if (event.code === "KeyS" && !event.repeat && !switching && studyMode === "learn" && cardIndex < studyCards.length - 1) {
        event.preventDefault();
        shuffleRemainingCards();
      }
      if (event.code === "KeyD" && !event.repeat && !switching) {
        event.preventDefault();
        toggleStudyDirection();
      }
      if (event.code === "KeyP" && !event.repeat && !switching && currentCard) {
        event.preventDefault();
        speak(flipped
          ? (reverse ? currentCard.front : currentCard.back)
          : (reverse ? currentCard.back : currentCard.front), event.shiftKey ? 0.65 : 0.9);
      }
      if (event.code === "KeyL" && !event.repeat && !flipped && !switching && currentCard) {
        event.preventDefault();
        speak(reverse ? currentCard.front : currentCard.back, event.shiftKey ? 0.65 : 0.9);
      }
      if (event.code === "KeyA" && !event.repeat && !switching) {
        event.preventDefault();
        toggleAutoPronounce();
      }
      if (event.code === "KeyB" && !event.repeat && flipped && !switching && currentCard) {
        event.preventDefault();
        speakPair(
          reverse ? currentCard.back : currentCard.front,
          reverse ? currentCard.front : currentCard.back,
          event.shiftKey ? 0.65 : 0.9,
        );
      }
      if (event.code === "KeyC" && !event.repeat && flipped && !switching && currentCard) {
        event.preventDefault();
        void copyCards([currentCard], "Пара скопирована");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [cardIndex, copyCards, currentCard, finished, flipped, markAnswer, postponeCard, revealAnswerHint, revealedHintLetters, reverse, shuffleRemainingCards, speak, speakPair, studyCards.length, studyMode, switching, toggleAutoPronounce, toggleStudyDirection, view]);

  function prepareStudy(deck: Deck) {
    answerLockRef.current = false;
    clearSavedSession();
    setStudyMode("learn");
    setActiveDeckId(deck.id);
    setCardIndex(0);
    setFlipped(false);
    setAnswers([]);
    setReviewMastered([]);
    setSwitching(false);
    setFinished(false);
    setRevealedHintLetters(0);
    setMissedTranslationsHidden(false);
    setRevealedMissedTranslationIds([]);
    setView("study");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function startStudy(deck: Deck) {
    prepareStudy(deck);
    setStudyCards(shuffle(deck.cards));
  }

  function startOrderedStudy(deck: Deck) {
    prepareStudy(deck);
    setStudyCards(deck.cards);
  }

  function startQuickStudy(deck: Deck) {
    prepareStudy(deck);
    setStudyCards(shuffle(deck.cards).slice(0, QUICK_STUDY_CARDS));
  }

  function repeatStudyCards(deck: Deck, cards: WordCard[]) {
    prepareStudy(deck);
    setStudyCards(shuffle(cards));
  }

  function startOppositeStudy(deck: Deck, cards: WordCard[]) {
    prepareStudy(deck);
    setReverse((value) => !value);
    setStudyCards(shuffle(cards));
  }

  function startReview(deck: Deck, focusedCards?: WordCard[]) {
    answerLockRef.current = false;
    clearSavedSession();
    setStudyMode("review");
    setActiveDeckId(deck.id);
    setStudyCards(focusedCards ? shuffle(focusedCards) : selectReviewCards(deck));
    setCardIndex(0);
    setFlipped(false);
    setAnswers([]);
    setReviewMastered([]);
    setSwitching(false);
    setFinished(false);
    setRevealedHintLetters(0);
    setMissedTranslationsHidden(false);
    setRevealedMissedTranslationIds([]);
    setView("study");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function startOppositeReview(deck: Deck, cards: WordCard[]) {
    startReview(deck, cards);
    setReverse((value) => !value);
  }

  function resumeSession(snapshot: SessionSnapshot) {
    answerLockRef.current = false;
    const deck = decks.find((item) => item.id === snapshot.deckId);
    if (!deck) {
      clearSavedSession();
      setNotice("Не удалось найти набор для продолжения");
      return;
    }

    const cardsById = new Map(deck.cards.map((card) => [card.id, card]));
    const restoredQueue = snapshot.queue
      .map((cardId) => cardsById.get(cardId))
      .filter((card): card is WordCard => Boolean(card));

    if (!restoredQueue.length || snapshot.cardIndex >= restoredQueue.length) {
      clearSavedSession();
      setNotice("Сохранённый подход уже завершён");
      return;
    }

    setStudyMode(snapshot.mode);
    setActiveDeckId(snapshot.deckId);
    setStudyCards(restoredQueue);
    setCardIndex(snapshot.cardIndex);
    setFlipped(snapshot.flipped);
    setReverse(snapshot.reverse);
    setAnswers(snapshot.answers);
    setReviewMastered(snapshot.reviewMastered);
    setSwitching(false);
    setFinished(false);
    setRevealedHintLetters(0);
    setMissedTranslationsHidden(false);
    setRevealedMissedTranslationIds([]);
    setView("study");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function createDeck() {
    if (!parsed.cards.length) {
      setNotice("Добавь хотя бы одну строку в формате слово — перевод");
      return;
    }

    const deck: Deck = {
      id: crypto.randomUUID(),
      title: title.trim() || "Новый набор",
      cards: parsed.cards.map((card) => ({ ...card, id: crypto.randomUUID() })),
      createdAt: now,
      lastScore: 0,
      sessions: 0,
    };

    try { serializeBackup(validateDecks([deck, ...decks])); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Не удалось создать набор"); return; }
    setDecks((current) => [deck, ...current]);
    setTitle("");
    setRawText("");
    setNotice(`Готово! Создано карточек: ${deck.cards.length}`);
    setShowImporter(false);
    startStudy(deck);
  }

  function renameDeck(deck: Deck) {
    setEditingDeck(deck);
  }

  function saveEditedDeck(deck: Deck) {
    if (storageConflict) throw new Error("Сначала загрузите обновления из другой вкладки.");
    const nextDecks = validateDecks(decks.map((item) => item.id === deck.id ? deck : item));
    serializeBackup(nextDecks);
    setDecks(nextDecks);
    if (savedSession?.deckId === deck.id && !validateSession(savedSession, nextDecks)) {
      clearSavedSession(); setActiveDeckId(null); setStudyCards([]);
    }
    setDeckPreviewOrders((current) => { const next = { ...current }; delete next[deck.id]; return next; });
    setNotice("Набор сохранён. Прогресс остальных карточек сохранён.");
  }

  function restoreDecks(restored: Deck[]) {
    if (storageConflict) throw new Error("Сначала скачайте текущую копию и загрузите обновления из другой вкладки.");
    const existingIds = new Set(decks.map((deck) => deck.id));
    const additions = restored.map((deck) => existingIds.has(deck.id)
      ? { ...deck, id: crypto.randomUUID(), title: `${deck.title.slice(0, LIBRARY_LIMITS.title - 8)} (копия)` }
      : deck);
    const nextDecks = validateDecks([...decks, ...additions]);
    serializeBackup(nextDecks);
    if (recoveryOriginal !== null) {
      // Keep an exact recovery record before an explicit restore replaces a bad v2 value.
      window.localStorage.setItem(`slovik-recovery-${Date.now()}`, recoveryOriginal);
    }
    storageBlockedRef.current = false;
    setRecoveryOriginal(null);
    setStorageError("");
    setDecks(nextDecks);
  }

  function reloadLibrary() {
    try {
      const state = readLibrary(window.localStorage, DEMO_DECKS);
      if (state.error) { setStorageError(state.error); return; }
      setDecks(state.decks);
      setSavedSession(state.session);
      setActiveDeckId(null);
      setStudyCards([]);
      storageBaselineRef.current = state.baseline;
      storageBlockedRef.current = false;
      setStorageConflict(false);
      setStorageError("");
      setView("home");
      setNotice("Загружена актуальная библиотека");
    } catch { setStorageError("Не удалось открыть хранилище браузера"); }
  }

  function downloadOriginal() {
    if (recoveryOriginal === null) return;
    const url = URL.createObjectURL(new Blob([recoveryOriginal], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "slovik-recovery.txt";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function keepReadableLibrary() {
    try { restoreDecks([]); }
    catch { setNotice("Не удалось сохранить исходную запись. Скачайте её перед восстановлением библиотеки."); }
  }

  function startDailyStudy(deck: Deck) {
    const cards = [...getDueCards(deck, now), ...getNewCards(deck)].slice(0, QUICK_STUDY_CARDS);
    if (!cards.length) { setNotice("На сегодня всё повторено. Можно потренироваться в любом наборе."); return; }
    prepareStudy(deck);
    setStudyCards(cards);
  }

  function dismissSharedDeck() {
    sharedLinkVersionRef.current += 1;
    sharedImportAbortRef.current?.abort();
    sharedImportAbortRef.current = null;
    sharedImportLockRef.current = false;
    setImportingShared(false);
    setIncomingDeck(null);
    setIncomingDeckId("");
    setIncomingError("");
    setIncomingLoading(false);
    if (window.location.hash.startsWith("#deck=")) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#top`);
    }
  }

  async function acceptSharedDeck(shared: SharedDeck, start: boolean) {
    if (!loaded || switching || sharedImportLockRef.current || importingShared || incomingLoading) return;
    if (storageBlockedRef.current || storageError || storageConflict) {
      setIncomingError("Сначала реши проблему сохранения библиотеки. Набор по ссылке пока не добавлен.");
      return;
    }
    const existing = decks.find((deck) => deck.id === incomingDeckId);
    if (existing) {
      dismissSharedDeck();
      if (start) startStudy(existing);
      return;
    }
    const expectedBaseline = storageBaselineRef.current;
    const expectedRevision = libraryRevisionRef.current;
    const acceptedVersion = sharedLinkVersionRef.current;
    const acceptedHash = window.location.hash;
    const controller = new AbortController();
    sharedImportAbortRef.current = controller;
    sharedImportLockRef.current = true;
    setImportingShared(true);
    setIncomingError("");
    try {
      const deck = { ...createSharedDeck(shared), id: incomingDeckId };
      const nextDecks = validateDecks([deck, ...decks]);
      serializeBackup(nextDecks);
      const session: SessionSnapshot | null = activeDeckId && currentCard
        ? finished ? null : {
          deckId: activeDeckId, mode: studyMode, queue: studyCards.map((card) => card.id),
          cardIndex, flipped, reverse, answers, reviewMastered, savedAt: now,
        } : savedSession;
      const persist = () => {
        if (storageBlockedRef.current || storageBaselineRef.current !== expectedBaseline) {
          throw new Error("Библиотека изменилась. Проверь обновления и попробуй добавить набор ещё раз.");
        }
        const result = commitSharedImport(window.localStorage, { decks: nextDecks, session }, {
          expectedBaseline, expectedRevision, getRevision: () => libraryRevisionRef.current,
          signal: controller.signal,
          isCurrent: () => sharedLinkVersionRef.current === acceptedVersion && window.location.hash === acceptedHash,
        });
        if (!result.ok) {
          setStorageError(result.error);
          if (result.conflict) { storageBlockedRef.current = true; setStorageConflict(true); }
          throw new Error(result.error);
        }
        storageBaselineRef.current = result.baseline;
      };
      if (navigator.locks) await navigator.locks.request("slovik-library", { signal: controller.signal }, persist);
      else persist();
      setDecks(nextDecks);
      dismissSharedDeck();
      setNotice(`Набор «${deck.title}» добавлен. Это твоя собственная копия.`);
      if (start) startStudy(deck);
    } catch (error) {
      if (!controller.signal.aborted && sharedLinkVersionRef.current === acceptedVersion) {
        setIncomingError(error instanceof Error ? error.message : "Не удалось добавить набор. Текущая библиотека сохранена.");
      }
    } finally {
      if (sharedImportAbortRef.current === controller) {
        sharedImportAbortRef.current = null;
        sharedImportLockRef.current = false;
        setImportingShared(false);
      }
    }
  }

  function copyDeck(deck: Deck) {
    return copyCards(deck.cards, `Скопировано карточек: ${deck.cards.length}`);
  }

  function copyDifficultCards(deck: Deck) {
    const difficultCards = getDifficultCards(deck);
    return copyCards(difficultCards, `Скопировано сложных слов: ${difficultCards.length}`);
  }

  async function copySkippedLines() {
    const skippedLines = parsed.skipped.join("\n");

    try {
      await window.navigator.clipboard.writeText(skippedLines);
      setNotice(`Скопировано строк: ${parsed.skipped.length}`);
    } catch {
      window.prompt("Скопируй нераспознанные строки", skippedLines);
    }
  }

  function deleteDeck(deckId: string) {
    const deck = decks.find((item) => item.id === deckId);
    if (!deck || !window.confirm(`Удалить набор «${deck.title}»?`)) return;
    if (savedSession?.deckId === deckId) clearSavedSession();
    if (activeDeckId === deckId) { setActiveDeckId(null); setStudyCards([]); }
    setDecks((current) => current.filter((item) => item.id !== deckId));
    setNotice("Набор удалён");
  }

  function focusImporter() {
    setView("home");
    setShowImporter(true);
    window.setTimeout(() => {
      document.getElementById("importer")?.scrollIntoView({ behavior: "smooth", block: "center" });
      titleRef.current?.focus();
    }, 0);
  }

  const storageBanner = storageError ? (
    <div className="storage-warning" role="alert">
      <strong>Изменения требуют внимания</strong><p>{storageError}</p>
      {recoveryOriginal !== null && <button type="button" onClick={downloadOriginal}>Скачать исходную запись</button>}
      {recoveryOriginal !== null && <button type="button" onClick={keepReadableLibrary}>Продолжить с доступными наборами</button>}
      {view === "study" && <button type="button" onClick={() => setView("home")}>К резервной копии</button>}
      {storageConflict && <button type="button" onClick={reloadLibrary}>Загрузить обновления из другой вкладки</button>}
    </div>
  ) : null;

  if (view === "study" && activeDeck && currentCard) {
    const score = Math.round((knownCount / Math.max(answers.length, 1)) * 100);
    const cardFront = reverse ? currentCard.back : currentCard.front;
    const cardBack = reverse ? currentCard.front : currentCard.back;
    const hintLetterCount = Array.from(cardBack).filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
    const maximumHintLetters = Math.max(0, hintLetterCount - 1);
    const progressiveHint = buildProgressiveHint(cardBack, revealedHintLetters);
    const reviewCardCount = countUniqueCards(studyCards);
    const missedCards = studyMode === "learn"
      ? studyCards.filter((_, index) => answers[index] === false)
      : [];
    const progressCurrent = studyMode === "review" ? reviewMastered.length : cardIndex + 1;
    const progressTotal = studyMode === "review" ? reviewCardCount : studyCards.length;
    const completedCards = studyMode === "review" ? reviewMastered.length : cardIndex;

    return (
      <main className="study-shell">
        <header className="study-topbar">
          <button className="back-button" type="button" onClick={() => setView("home")} aria-label="Вернуться к наборам">←</button>
          <button className="brand brand-button" type="button" onClick={() => setView("home")} aria-label="Словик — на главную">
            <BrandMark />
            <span>словик</span>
          </button>
          <div className="study-title-block">
            <span>{studyMode === "review" ? "Умное повторение" : "Тренировка"}</span>
            <strong>{activeDeck.title}</strong>
          </div>
          <button className="direction-button" type="button" onClick={toggleStudyDirection} aria-label="Поменять стороны карточек" disabled={switching}>
            {reverse ? "RU → EN" : "EN → RU"} <span aria-hidden="true">⇄</span>
          </button>
        </header>
        {storageBanner}

        <section className="study-stage" aria-live="polite">
          {!finished ? (
            <>
              <div className={`autosave-status ${storageError ? "has-error" : ""}`}><i /> {storageError ? "Изменения пока не сохранены" : "Прогресс сохраняется в этом браузере"}</div>
              <div className="study-meta">
                <span><strong>{progressCurrent}</strong> / {progressTotal}</span>
                <div className="progress-track" aria-label={`Завершено: ${completedCards} из ${progressTotal}`}>
                  <span style={{ width: `${(completedCards / Math.max(progressTotal, 1)) * 100}%` }} />
                </div>
                {studyMode === "review" ? (
                  <span className="review-loop-note">↻ сложные вернутся</span>
                ) : (
                  <button
                    type="button"
                    onClick={shuffleRemainingCards}
                    disabled={switching || cardIndex >= studyCards.length - 1}
                  >
                    Перемешать оставшиеся
                  </button>
                )}
              </div>

              {answers.length > 0 && (
                <div className="live-answer-stats" role="status" aria-label={`Текущий результат: вспомнил ${knownCount}, нужно повторить ${forgottenCount}, точность ${liveAccuracy}%, серия ${currentStreak}`}>
                  <span className="is-known"><i aria-hidden="true">✓</i> Вспомнил: <strong>{knownCount}</strong></span>
                  <span className="is-forgotten"><i aria-hidden="true">↻</i> Повторить: <strong>{forgottenCount}</strong></span>
                  <span className="is-accuracy"><i aria-hidden="true">%</i> Точность: <strong>{liveAccuracy}%</strong></span>
                  <span className="is-streak"><i aria-hidden="true">✦</i> Серия: <strong>{currentStreak}</strong></span>
                </div>
              )}

              <button className={`flashcard ${Math.max(cardFront.length, cardBack.length) > 80 ? "has-long-text" : ""} ${flipped ? "is-flipped" : ""} ${switching ? "is-switching" : ""}`} type="button" onClick={() => { if (!switching) setFlipped((value) => !value); }} aria-label={flipped ? `Перевод: ${cardBack}` : `Слово: ${cardFront}. Нажмите, чтобы увидеть перевод`}>
                <span className="flashcard-inner">
                  <span className="flashcard-face flashcard-front">
                    <small>{reverse ? "ПЕРЕВОД" : "СЛОВО"}</small>
                    <strong>{cardFront}</strong>
                    <em>Нажми, чтобы перевернуть</em>
                    <span className="card-number">{String(cardIndex + 1).padStart(2, "0")}</span>
                  </span>
                  <span className="flashcard-face flashcard-back">
                    <small>{reverse ? "СЛОВО" : "ПЕРЕВОД"}</small>
                    <strong>{cardBack}</strong>
                    <em>Оцени, получилось ли вспомнить</em>
                    <span className="card-number">✓</span>
                  </span>
                </span>
              </button>

              {!flipped && <button className="primary-button reveal-answer" type="button" onClick={() => setFlipped(true)} disabled={switching}>Показать ответ <span aria-hidden="true">↵</span></button>}
              <div className={`answer-actions ${flipped && !switching ? "is-visible" : ""}`}>
                <button className="answer-button forgot" type="button" onClick={() => markAnswer(false)} disabled={!flipped || switching}>
                  <span>←</span><strong>Пока не помню</strong><small>повторим через 10 минут</small>
                </button>
                <button className="answer-button knew" type="button" onClick={() => markAnswer(true)} disabled={!flipped || switching}>
                  <strong>Вспомнил!</strong><small>планируем повторение</small><span>→</span>
                </button>
              </div>
              <details className="study-extras">
                <summary>Подсказки и озвучивание</summary>
              <div className="study-assists">
                {!flipped && (
                  <button
                    className="hint-button"
                    type="button"
                    onClick={revealAnswerHint}
                    disabled={switching || revealedHintLetters >= maximumHintLetters}
                    aria-label={revealedHintLetters === 0 ? "Показать первую букву ответа" : "Показать ещё одну букву ответа"}
                  >
                    <span aria-hidden="true">✦</span>
                    {revealedHintLetters === 0 ? "Подсказка ответа" : <>Подсказка: <b>{progressiveHint}</b></>}
                  </button>
                )}
                {!flipped && revealedHintLetters > 0 && (
                  <button
                    className="hint-button"
                    type="button"
                    onClick={() => setRevealedHintLetters(0)}
                    disabled={switching}
                  >
                    Скрыть подсказку
                  </button>
                )}
                {!flipped && cardIndex < studyCards.length - 1 && (
                  <button
                    className="postpone-button"
                    type="button"
                    onClick={postponeCard}
                    disabled={switching}
                    aria-label="Вернуться к этому слову позже"
                  >
                    <span aria-hidden="true">↷</span>
                    Вернуться позже
                  </button>
                )}
                {!flipped && (
                  <button
                    className="pronunciation-button"
                    type="button"
                    onClick={() => speak(cardBack)}
                    disabled={switching}
                    aria-label="Озвучить скрытый ответ"
                  >
                    <span aria-hidden="true">◖))</span>
                    Послушать ответ
                  </button>
                )}
                {!flipped && (
                  <button
                    className="pronunciation-button"
                    type="button"
                    onClick={() => speak(cardBack, 0.65)}
                    disabled={switching}
                    aria-label="Озвучить скрытый ответ медленно"
                  >
                    <span aria-hidden="true">◖))</span>
                    Ответ медленно
                  </button>
                )}
                <button
                  className="pronunciation-button"
                  type="button"
                  onClick={() => speak(flipped ? cardBack : cardFront)}
                  disabled={switching}
                  aria-label={`Озвучить: ${flipped ? cardBack : cardFront}`}
                >
                  <span aria-hidden="true">◖))</span>
                  Озвучить эту сторону
                </button>
                <button
                  className="pronunciation-button"
                  type="button"
                  onClick={() => speak(flipped ? cardBack : cardFront, 0.65)}
                  disabled={switching}
                  aria-label={`Озвучить медленно: ${flipped ? cardBack : cardFront}`}
                >
                  <span aria-hidden="true">◖))</span>
                  Медленно
                </button>
                {flipped && (
                  <button
                    className="pronunciation-button"
                    type="button"
                    onClick={() => speakPair(cardFront, cardBack)}
                    disabled={switching}
                    aria-label={`Озвучить пару: ${cardFront} — ${cardBack}`}
                  >
                    <span aria-hidden="true">◖))</span>
                    Озвучить пару
                  </button>
                )}
                {flipped && (
                  <button
                    className="pronunciation-button"
                    type="button"
                    onClick={() => speakPair(cardFront, cardBack, 0.65)}
                    disabled={switching}
                    aria-label={`Озвучить пару медленно: ${cardFront} — ${cardBack}`}
                  >
                    <span aria-hidden="true">◖))</span>
                    Пара медленно
                  </button>
                )}
                {flipped && (
                  <button
                    className="hint-button"
                    type="button"
                    onClick={() => copyCards([currentCard], "Пара скопирована")}
                    disabled={switching}
                    aria-label={`Скопировать пару: ${currentCard.front} — ${currentCard.back}`}
                  >
                    <span aria-hidden="true">⧉</span>
                    Скопировать пару
                  </button>
                )}
                <button
                  className="pronunciation-button"
                  type="button"
                  onClick={toggleAutoPronounce}
                  disabled={switching}
                  aria-pressed={autoPronounce}
                  aria-label={autoPronounce ? "Выключить автоозвучивание карточек" : "Включить автоозвучивание карточек"}
                >
                  <span aria-hidden="true">↻</span>
                  {autoPronounce ? "Автоозвучивание включено" : "Автоозвучивание"}
                </button>
              </div>
              </details>
              <details className="keyboard-help"><summary>Управление с клавиатуры</summary><p className="keyboard-tip"><kbd>Esc</kbd> к наборам · <kbd>Пробел</kbd> перевернуть · <kbd>H</kbd> подсказка · <kbd>Shift</kbd>+<kbd>H</kbd> скрыть · <kbd>L</kbd> послушать ответ · <kbd>Shift</kbd>+<kbd>L</kbd> ответ медленно · <kbd>R</kbd> позже · <kbd>S</kbd> перемешать · <kbd>D</kbd> направление · <kbd>P</kbd> озвучить · <kbd>Shift</kbd>+<kbd>P</kbd> медленно · <kbd>B</kbd> озвучить пару · <kbd>Shift</kbd>+<kbd>B</kbd> пару медленно · <kbd>C</kbd> скопировать пару · <kbd>A</kbd> автоозвучивание · <kbd>←</kbd><kbd>→</kbd> ответить</p></details>
            </>
          ) : (
            <div className="result-card">
              <span className="result-burst" aria-hidden="true">✦</span>
              <span className="eyebrow">{studyMode === "review" ? "ПОВТОРЕНИЕ ЗАВЕРШЕНО" : "ПОДХОД ЗАВЕРШЁН"}</span>
              <h1>{studyMode === "review" ? "Подборка закреплена!" : score >= 80 ? "Отличная работа!" : score >= 50 ? "Хороший темп!" : "Первый шаг сделан!"}</h1>
              <p>{studyMode === "review" ? (
                <>Ты закрепил <strong>{reviewCardCount}</strong> карточек повторными ответами.</>
              ) : (
                <>Ты вспомнил <strong>{knownCount}</strong> из <strong>{studyCards.length}</strong> карточек.</>
              )}</p>
              <div className="score-ring" style={{ "--score": `${score * 3.6}deg` } as React.CSSProperties}>
                <span>{score}%</span>
              </div>
              <small className="score-caption">
                {studyMode === "review" ? "точность ответов" : `лучшая серия: ${longestStreak}`}
              </small>
              <p className="next-review-note">{getDeckLearningStats(activeDeck, now).dueCount > 0
                ? "В наборе остались слова к повторению. Можно сделать ещё один короткий подход."
                : "Следующий шаг запланирован. Вернись на экран «На сегодня», когда подойдёт время повторения."}</p>
              {studyMode === "learn" && missedCards.length > 0 && (
                <details className="missed-word-list">
                  <summary>Посмотреть ошибки этого подхода</summary>
                  <button
                    className="missed-visibility-button"
                    type="button"
                    onClick={toggleMissedTranslations}
                    aria-pressed={missedTranslationsHidden}
                  >
                    <span aria-hidden="true">◉</span>
                    {missedTranslationsHidden ? "Показать переводы" : "Скрыть переводы"}
                  </button>
                  <ul>
                    {missedCards.map((card) => {
                      const translationHidden = missedTranslationsHidden
                        && !revealedMissedTranslationIds.includes(card.id);

                      return (
                        <li key={card.id}>
                          <button
                            className="missed-word-speech"
                            type="button"
                            onClick={() => speak(card.front)}
                            aria-label={`Озвучить: ${card.front}`}
                          >
                            <span>{card.front}</span>
                            <i aria-hidden="true">◖))</i>
                          </button>
                          <i aria-hidden="true">—</i>
                          <span className="missed-translation">
                            <button
                              className="missed-word-speech is-translation"
                              type="button"
                              onClick={() => speak(card.back)}
                              aria-label={translationHidden
                                ? `Озвучить скрытый перевод для: ${card.front}`
                                : `Озвучить: ${card.back}`}
                            >
                              <strong aria-hidden={translationHidden || undefined}>
                                {translationHidden ? "•••••" : card.back}
                              </strong>
                              <i aria-hidden="true">◖))</i>
                            </button>
                            {missedTranslationsHidden && (
                              <button
                                className="missed-reveal-button"
                                type="button"
                                onClick={() => toggleMissedTranslation(card.id)}
                                aria-label={translationHidden
                                  ? `Показать перевод для: ${card.front}`
                                  : `Скрыть перевод для: ${card.front}`}
                              >
                                {translationHidden ? "Показать" : "Скрыть"}
                              </button>
                            )}
                            <button
                              className="copy-missed-pair-button"
                              type="button"
                              onClick={() => copyCards([card], "Пара скопирована")}
                              aria-label={`Скопировать пару: ${card.front} — ${card.back}`}
                              title="Скопировать пару"
                            >
                              ⧉
                            </button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="missed-word-actions">
                    <button
                      className="copy-missed-button"
                      type="button"
                      onClick={() => speakCards(missedCards)}
                      aria-label="Озвучить все ошибки по порядку"
                    >
                      ◖)) Прослушать ошибки
                    </button>
                    <button
                      className="copy-missed-button"
                      type="button"
                      onClick={stopSpeaking}
                      aria-label="Остановить озвучивание ошибок"
                    >
                      ■ Остановить
                    </button>
                    <button
                      className="copy-missed-button"
                      type="button"
                      onClick={() => copyCards(missedCards, `Скопировано ошибок: ${missedCards.length}`)}
                    >
                      ⧉ Скопировать ошибки
                    </button>
                  </div>
                </details>
              )}
              <div className="result-actions">
                {studyMode === "learn" && missedCards.length > 0 ? (
                  <>
                    <button className="secondary-button" type="button" onClick={() => startReview(activeDeck, missedCards)}>
                      Повторить ошибки ({missedCards.length})
                    </button>
                    <button className="secondary-button" type="button" onClick={() => startOppositeReview(activeDeck, missedCards)}>
                      Ошибки в обратную сторону
                    </button>
                  </>
                ) : (
                  <button className="secondary-button" type="button" onClick={() => startReview(activeDeck)}>
                    {studyMode === "review" ? "Повторить ещё раз" : "Закрепить 5 слов"}
                  </button>
                )}
                {studyMode === "learn" && (
                  <button className="secondary-button" type="button" onClick={() => repeatStudyCards(activeDeck, studyCards)}>
                    {studyCards.length < activeDeck.cards.length ? "Повторить эти слова" : "Пройти весь набор снова"}
                  </button>
                )}
                {studyMode === "learn" && (
                  <button className="secondary-button" type="button" onClick={() => startOppositeStudy(activeDeck, studyCards)}>
                    Те же слова в обратную сторону
                  </button>
                )}
                <button className="primary-button compact" type="button" onClick={() => setView("home")}>К моим наборам →</button>
              </div>
            </div>
          )}
        </section>
        {notice && <div className="toast" role="status">{notice}</div>}
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Словик — на главную">
          <BrandMark />
          <span>словик</span>
        </a>
        <nav className="nav-links" aria-label="Основная навигация">
          <a className="active" href="#top">На сегодня</a>
          <a href="#sets">Мои наборы</a>
          <a href="#how">Как учиться</a>
          <a href="#install">На телефон</a>
        </nav>
        <button className="topbar-create" type="button" onClick={focusImporter} disabled={!loaded}><span>＋</span> Новый набор</button>
      </header>
      {storageBanner}

      <SharedDeckImport shared={incomingDeck} error={incomingError} loading={incomingLoading} alreadyAdded={Boolean(alreadyAddedDeck)} disabled={!loaded || switching || importingShared || Boolean(storageError)} onImport={(shared, start) => { void acceptSharedDeck(shared, start); }} onDismiss={dismissSharedDeck} />
      <DeckShareDialog deck={sharingDeck} baseUrl={shareBaseUrl} onClose={() => setSharingDeck(null)} />

      <section className="today-section" id="top" aria-labelledby="today-heading">
        <div className="today-copy">
          <span className="eyebrow">НА СЕГОДНЯ{loaded ? ` · ${new Intl.DateTimeFormat("ru", { day: "numeric", month: "long" }).format(now)}` : ""}</span>
          <h1 id="today-heading">Маленький шаг.<br /><em>Большой словарный запас.</em></h1>
          <p>{dueCount > 0 ? `Пора освежить в памяти ${wordCount(dueCount)}. Начни с короткого подхода — до 10 карточек.`
            : newCount > 0 ? "Новые слова уже ждут. Удели им пять минут — следующие повторения Словик запланирует сам."
            : "На сегодня всё повторено. Добавь новые слова или потренируйся с любимым набором."}</p>
          <div className="today-actions">
            {savedSession && savedDeck ? <button className="primary-button compact" disabled={!loaded} type="button" onClick={() => resumeSession(savedSession)}>Продолжить подход →</button>
              : recommendedDeck ? <button className="primary-button compact" disabled={!loaded} type="button" onClick={() => startDailyStudy(recommendedDeck)}>{dueCount ? "Повторить слова" : "Учить новые слова"} →</button>
                : <button className="primary-button compact" type="button" onClick={focusImporter}>Создать набор →</button>}
            <a href="#sets" className="today-library-link">Открыть библиотеку ↓</a>
          </div>
          {savedSession && savedDeck && savedStats && <p className="today-resume">{savedDeck.title} · пройдено {savedStats.completed} из {savedStats.total}</p>}
          {decks.length === 1 && decks[0].id === "travel-demo" && decks[0].sessions === 0 && <span className="demo-label">Начни с примера «Английский: путешествия» или создай свой набор</span>}
        </div>
        <div className="today-panel">
          <span className="step-label">УЧИМСЯ В СВОЁМ ТЕМПЕ</span>
          <dl className="today-stats">
            <div><dt>К повторению</dt><dd>{dueCount}<span>{wordCount(dueCount).split(" ")[1]}</span></dd></div>
            <div><dt>Новых слов</dt><dd>{newCount}<span>в библиотеке</span></dd></div>
            <div><dt>Ответов сегодня</dt><dd>{dailyStats.reviewed}<span>в завершённых подходах</span></dd></div>
            <div><dt>Серия занятий</dt><dd>{dailyStats.streakDays}<span>{dailyStats.streakDays % 100 >= 11 && dailyStats.streakDays % 100 <= 14 ? "дней" : dailyStats.streakDays % 10 === 1 ? "день" : dailyStats.streakDays % 10 >= 2 && dailyStats.streakDays % 10 <= 4 ? "дня" : "дней"} подряд</span></dd></div>
          </dl>
          <details className="schedule-help"><summary>Как устроено повторение</summary><p>После верного ответа: через 1, 3, 7, 14, 30 и 60 дней. Если слово забыто — через 10 минут. Дополнительная практика до срока не откладывает повторение.</p><p>Дневные показатели считаются по завершённым подходам на этом устройстве.</p></details>
        </div>
      </section>

      {(showImporter || (loaded && decks.length === 0)) && <section className="hero" id="new-deck">
        <div className="hero-copy">
          <span className="eyebrow">УЧИТЬСЯ — ЭТО ЛЕГКО</span>
          <h2>Все новые слова.<br /><em>В одной колоде.</em></h2>
          <p>Вставь свой список целиком — Словик сам разложит его по карточкам.</p>
          <div className="hero-note">
            <span className="note-spark">✦</span>
            <span><strong>Быстрый импорт</strong><small>Слово — перевод, каждая пара с новой строки</small></span>
          </div>
        </div>

        <div className="import-card" id="importer">
          <div className="import-heading">
            <div>
              <span className="step-label">НОВЫЙ НАБОР</span>
              <h2>Вставь слова</h2>
            </div>
            <span className={`pair-count ${parsed.cards.length === 0 ? "is-empty" : ""}`}>
              {parsed.cards.length} {parsed.cards.length === 1 ? "пара" : parsed.cards.length < 5 ? "пары" : "пар"}
            </span>
          </div>
          <label className="field-label" htmlFor="set-title">Название набора</label>
          <input ref={titleRef} id="set-title" className="title-input" value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="Например, Английский для путешествий" />
          <label className="field-label field-label-row" htmlFor="word-list">
            <span>Список слов</span>
            <span>слово — перевод</span>
          </label>
          <textarea id="word-list" className="words-input" value={rawText} onChange={(event) => setRawText(event.target.value)} placeholder={'journey - путешествие\ncozy - уютный'} spellCheck={false} />
          {parsed.skipped.length > 0 && (
            <details className="parse-warning">
              <summary>Не распознано строк: {parsed.skipped.length}. Показать</summary>
              <p>Проверь тире, обе части пары и повторяющиеся строки:</p>
              <ul>
                {parsed.skipped.map((line, index) => (
                  <li key={`${index}-${line}`}>{line}</li>
                ))}
              </ul>
              <button className="parse-copy-button" type="button" onClick={copySkippedLines}>
                ⧉ Скопировать пропущенные строки
              </button>
            </details>
          )}
          <button className="primary-button" type="button" onClick={createDeck} disabled={!loaded || parsed.cards.length === 0}>
            Создать {parsed.cards.length || ""} карточки <span aria-hidden="true">→</span>
          </button>
          <p className="privacy-note"><span aria-hidden="true">✓</span> Наборы сохраняются прямо в браузере</p>
          <button className="import-close" type="button" onClick={() => setShowImporter(false)}>Закрыть импорт</button>
        </div>
      </section>}

      <section className="library-section" id="sets" aria-busy={!loaded} inert={!loaded}>
        <div className="section-heading">
          <div>
            <span className="eyebrow">ТВОЯ БИБЛИОТЕКА</span>
            <h2>Мои наборы</h2>
          </div>
          <button className="secondary-button" type="button" onClick={focusImporter}>＋ Создать новый</button>
        </div>
        <LibraryTools decks={decks} editingDeck={editingDeck} onCloseEditor={() => setEditingDeck(null)} onEdit={saveEditedDeck} onRestore={restoreDecks} />

        {savedSession && savedDeck && savedStats && (
          <div className="resume-banner">
            <span className="resume-icon" aria-hidden="true">↗</span>
            <div className="resume-copy">
              <small>АВТОСОХРАНЕНИЕ</small>
              <strong>Незаконченный подход сохранён</strong>
              <p>{savedDeck.title} · {savedStats.completed} из {savedStats.total} · точность {savedStats.accuracy}%</p>
            </div>
            <div className="resume-progress" aria-label={`Сохранённый прогресс: ${savedStats.progress}%`}>
              <span style={{ width: `${savedStats.progress}%` }} />
            </div>
            <button type="button" onClick={() => resumeSession(savedSession)}>Продолжить <span aria-hidden="true">→</span></button>
          </div>
        )}

        {decks.length > 0 && (
          <div className="deck-search">
            <label htmlFor="deck-search">Найти набор</label>
            <div className="deck-search-controls">
              <input
                id="deck-search"
                type="search"
                className="title-input"
                value={deckSearch}
                onChange={(event) => setDeckSearch(event.target.value)}
                placeholder="Название, слово или перевод"
                aria-describedby="deck-search-count"
              />
              {deckSearch && (
                <button className="secondary-button" type="button" onClick={() => setDeckSearch("")}>Сбросить</button>
              )}
            </div>
            <p id="deck-search-count" role="status">Наборов: {visibleDecks.length} из {decks.length}</p>
          </div>
        )}

        {visibleDecks.length ? (
          <div className="deck-grid">
            {visibleDecks.map(({ deck, deckIndex }) => (
              <article className={`deck-card deck-tone-${deckIndex % 3}`} key={deck.id}>
                <div className="deck-topline">
                  <span className="deck-icon" aria-hidden="true">{deckIndex % 3 === 0 ? "Aa" : deckIndex % 3 === 1 ? "✦" : "あ"}</span>
                  <div className="deck-tools">
                    <button className="copy-button" type="button" onClick={() => copyDeck(deck)} aria-label={`Скопировать слова набора ${deck.title}`} title="Скопировать слова">⧉</button>
                    <button className="edit-button" type="button" onClick={() => renameDeck(deck)} aria-label={`Редактировать набор ${deck.title}`}>✎</button>
                    <button className="delete-button" type="button" onClick={() => deleteDeck(deck.id)} aria-label={`Удалить набор ${deck.title}`}>×</button>
                  </div>
                </div>
                <h3>{deck.title}</h3>
                <p>{deck.cards.length} {deck.cards.length === 1 ? "карточка" : deck.cards.length < 5 ? "карточки" : "карточек"}</p>
                <button className="share-deck-button" type="button" onClick={() => setSharingDeck(deck)} aria-label={`Поделиться набором ${deck.title}`}><span aria-hidden="true">↗</span> Поделиться набором</button>
                <div className="deck-learning-status">
                  <span>{getDeckLearningStats(deck, now).dueCount} к повторению</span>
                  <span>{getDeckLearningStats(deck, now).newCount} новых</span>
                  {getDeckLearningStats(deck, now).nextDueAt && <small>Следующее: {new Intl.DateTimeFormat("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(getDeckLearningStats(deck, now).nextDueAt!)}</small>}
                </div>
                <div className="deck-progress">
                  <span><i style={{ width: `${deck.lastScore}%` }} /></span>
                  <small>
                    {deck.sessions
                      ? `Последний результат ${deck.lastScore}% · ${formatSessionCount(deck.sessions)}`
                      : "Ещё не изучали"}
                    {countDifficultCards(deck) > 0 && (
                      <> · <b>{countDifficultCards(deck)} сложн.</b></>
                    )}
                  </small>
                  {countDifficultCards(deck) > 0 && (
                    <button
                      className="quick-study-link"
                      type="button"
                      onClick={() => copyDifficultCards(deck)}
                    >
                      Скопировать сложные слова
                    </button>
                  )}
                  <button
                    className="quick-study-link"
                    type="button"
                    onClick={() => startOrderedStudy(deck)}
                  >
                    Учить по порядку →
                  </button>
                  {deck.cards.length > QUICK_STUDY_CARDS && (
                    <button
                      className="quick-study-link"
                      type="button"
                      onClick={() => startQuickStudy(deck)}
                    >
                      Быстрый подход: {QUICK_STUDY_CARDS} слов →
                    </button>
                  )}
                </div>
                <details className="deck-word-list">
                  <summary>Посмотреть слова</summary>
                  <div className="deck-word-visibility-controls">
                    <button
                      className="deck-word-visibility-button"
                      type="button"
                      onClick={() => shuffleDeckPreview(deck)}
                      aria-label={`Перемешать слова набора ${deck.title} для самопроверки`}
                    >
                      <span aria-hidden="true">↝</span>
                      Перемешать список
                    </button>
                    <button
                      className="deck-word-visibility-button"
                      type="button"
                      onClick={() => speakCards(getDeckPreviewCards(deck))}
                      aria-label={`Озвучить все пары набора ${deck.title} в показанном порядке`}
                    >
                      <span aria-hidden="true">◖))</span>
                      Прослушать набор
                    </button>
                    <button
                      className="deck-word-visibility-button"
                      type="button"
                      onClick={stopSpeaking}
                      aria-label={`Остановить озвучивание набора ${deck.title}`}
                    >
                      <span aria-hidden="true">■</span>
                      Остановить
                    </button>
                    <button
                      className="deck-word-visibility-button"
                      type="button"
                      onClick={() => toggleDeckWords(deck.id)}
                      aria-pressed={hiddenDeckWordIds.includes(deck.id)}
                    >
                      <span aria-hidden="true">◐</span>
                      {hiddenDeckWordIds.includes(deck.id) ? "Показать слова" : "Скрыть слова"}
                    </button>
                    <button
                      className="deck-word-visibility-button"
                      type="button"
                      onClick={() => toggleDeckTranslations(deck.id)}
                      aria-pressed={hiddenDeckTranslationIds.includes(deck.id)}
                    >
                      <span aria-hidden="true">◐</span>
                      {hiddenDeckTranslationIds.includes(deck.id) ? "Показать переводы" : "Скрыть переводы"}
                    </button>
                  </div>
                  <ul>
                    {getDeckPreviewCards(deck).map((card) => {
                      const wordKey = `${deck.id}:${card.id}`;
                      const translationKey = `${deck.id}:${card.id}`;
                      const wordsHidden = hiddenDeckWordIds.includes(deck.id);
                      const wordHidden = wordsHidden
                        && !revealedDeckWordKeys.includes(wordKey);
                      const translationsHidden = hiddenDeckTranslationIds.includes(deck.id);
                      const translationHidden = translationsHidden
                        && !revealedDeckTranslationKeys.includes(translationKey);

                      return (
                        <li key={card.id}>
                          <div className="deck-word-front">
                            <button
                              className="deck-word-speech"
                              type="button"
                              onClick={() => speak(card.front)}
                              aria-label={wordHidden
                                ? `Озвучить скрытое слово для: ${card.back}`
                                : `Озвучить: ${card.front}`}
                            >
                              <span>{wordHidden ? "•••••" : card.front}</span>
                              <small aria-hidden="true">♪</small>
                            </button>
                            {wordsHidden && (
                              <button
                                className="deck-word-reveal-button"
                                type="button"
                                onClick={() => toggleDeckWord(deck.id, card.id)}
                                aria-label={wordHidden
                                  ? `Показать слово для: ${card.back}`
                                  : `Скрыть слово для: ${card.back}`}
                              >
                                {wordHidden ? "Показать" : "Скрыть"}
                              </button>
                            )}
                          </div>
                          <i aria-hidden="true">—</i>
                          <div className="deck-word-translation">
                            <button
                              className="deck-word-speech is-translation"
                              type="button"
                              onClick={() => speak(card.back)}
                              aria-label={translationHidden
                                ? `Озвучить скрытый перевод для: ${card.front}`
                                : `Озвучить: ${card.back}`}
                            >
                              <strong>{translationHidden ? "•••••" : card.back}</strong>
                              <small aria-hidden="true">♪</small>
                            </button>
                            {translationsHidden && (
                              <button
                                className="deck-word-reveal-button"
                                type="button"
                                onClick={() => toggleDeckTranslation(deck.id, card.id)}
                                aria-label={translationHidden
                                  ? `Показать перевод для: ${card.front}`
                                  : `Скрыть перевод для: ${card.front}`}
                              >
                                {translationHidden ? "Показать" : "Скрыть"}
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </details>
                <div className={`deck-actions ${countDifficultCards(deck) > 0 ? "has-difficult" : ""}`}>
                  <button className="review-button" type="button" onClick={() => startReview(deck)}>
                    <span aria-hidden="true">↻</span> Повторить
                  </button>
                  {countDifficultCards(deck) > 0 && (
                    <button className="difficult-button" type="button" onClick={() => startReview(deck, getDifficultCards(deck))}>
                      <span aria-hidden="true">✦</span> Сложные
                    </button>
                  )}
                  <button className="study-button" type="button" onClick={() => startStudy(deck)}>
                    Учить <span aria-hidden="true">→</span>
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : decks.length > 0 ? (
          <div className="empty-library">
            <h3>Наборы не найдены</h3>
            <p>Попробуй другое слово или перевод либо сбрось поиск.</p>
          </div>
        ) : (
          <div className="empty-library">
            <span aria-hidden="true">✦</span>
            <h3>Здесь появятся твои наборы</h3>
            <p>Вставь список выше — и первая колода будет готова за несколько секунд.</p>
            <button className="primary-button compact" type="button" onClick={focusImporter}>Создать набор →</button>
          </div>
        )}
      </section>

      <section className="how-section" id="how">
        <div className="how-copy">
          <span className="eyebrow">ТРИ ПРОСТЫХ ШАГА</span>
          <h2>От списка до уверенного ответа</h2>
        </div>
        <ol className="steps-list">
          <li><span>01</span><div><strong>Вставь</strong><p>Скопируй сразу весь список в привычном формате.</p></div></li>
          <li><span>02</span><div><strong>Переверни</strong><p>Вспомни перевод и открой обратную сторону.</p></div></li>
          <li><span>03</span><div><strong>Закрепи</strong><p>Сложные слова сами вернутся в случайном порядке.</p></div></li>
        </ol>
      </section>

      <section className="install-section" id="install">
        <div className="install-heading">
          <span className="eyebrow">БЕЗ СЛОЖНОЙ УСТАНОВКИ</span>
          <h2>Устанавливать ничего не нужно</h2>
          <p>Открой Словик в браузере и при желании добавь его значок на главный экран телефона.</p>
        </div>
        <div className="install-options">
          <article>
            <span className="install-icon" aria-hidden="true">↗</span>
            <div>
              <strong>На телефоне</strong>
              <p><b>iPhone или iPad:</b> Safari → «Поделиться» → «На экран Домой».</p>
              <p><b>Android:</b> Chrome → меню ⋮ → «Добавить на главный экран».</p>
            </div>
          </article>
          <article>
            <span className="install-icon teacher" aria-hidden="true">Aa</span>
            <div>
              <strong>Преподавателю и ученикам</strong>
              <p>Нажми «Поделиться набором» и отправь ссылку ученику. Он увидит слова и начнёт учиться в своей библиотеке.</p>
              <small>У каждого сохраняются свои результаты на его устройстве.</small>
            </div>
          </article>
        </div>
      </section>

      <footer className="footer">
        <span className="brand small"><BrandMark />словик</span>
        <p>Учись в своём ритме. Данные остаются на этом устройстве.</p>
      </footer>

      {notice && <div className="toast" role="status"><span>✓</span>{notice}</div>}
    </main>
  );
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
