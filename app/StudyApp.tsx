"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type WordCard = {
  id: string;
  front: string;
  back: string;
};

type Deck = {
  id: string;
  title: string;
  cards: WordCard[];
  createdAt: number;
  lastScore: number;
  sessions: number;
};

type View = "home" | "study";
type StudyMode = "learn" | "review";

type SessionSnapshot = {
  deckId: string;
  mode: StudyMode;
  queue: string[];
  cardIndex: number;
  flipped: boolean;
  reverse: boolean;
  answers: boolean[];
  reviewMastered: string[];
  savedAt: number;
};

const STORAGE_KEY = "slovik-decks-v1";
const SESSION_KEY = "slovik-active-session-v1";
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
    lastScore: 67,
    sessions: 2,
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

    const divider = line.match(/\s+(?:-|–|—)\s+|[–—]/);
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

function getSessionStats(snapshot: SessionSnapshot, deck: Deck) {
  const completed = snapshot.mode === "review"
    ? snapshot.reviewMastered.length
    : Math.min(snapshot.cardIndex, deck.cards.length);
  const correct = snapshot.answers.filter(Boolean).length;

  return {
    completed,
    total: deck.cards.length,
    progress: Math.round((completed / Math.max(deck.cards.length, 1)) * 100),
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
  const [view, setView] = useState<View>("home");
  const [studyMode, setStudyMode] = useState<StudyMode>("learn");
  const [activeDeckId, setActiveDeckId] = useState<string | null>(null);
  const [studyCards, setStudyCards] = useState<WordCard[]>([]);
  const [cardIndex, setCardIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [reverse, setReverse] = useState(false);
  const [answers, setAnswers] = useState<boolean[]>([]);
  const [reviewMastered, setReviewMastered] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [finished, setFinished] = useState(false);
  const [savedSession, setSavedSession] = useState<SessionSnapshot | null>(null);
  const [notice, setNotice] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);

  const parsed = useMemo(() => parsePairs(rawText), [rawText]);
  const activeDeck = decks.find((deck) => deck.id === activeDeckId) ?? null;
  const currentCard = studyCards[cardIndex];
  const knownCount = answers.filter(Boolean).length;
  const savedDeck = savedSession
    ? decks.find((deck) => deck.id === savedSession.deckId) ?? null
    : null;
  const savedStats = savedSession && savedDeck
    ? getSessionStats(savedSession, savedDeck)
    : null;

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      let availableDecks = DEMO_DECKS;
      try {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        if (saved) {
          const storedDecks = JSON.parse(saved) as Deck[];
          if (Array.isArray(storedDecks)) {
            availableDecks = storedDecks;
            setDecks(storedDecks);
          }
        }

        const savedProgress = window.localStorage.getItem(SESSION_KEY);
        if (savedProgress) {
          const snapshot = JSON.parse(savedProgress) as SessionSnapshot;
          if (
            snapshot
            && Array.isArray(snapshot.queue)
            && Array.isArray(snapshot.answers)
            && availableDecks.some((deck) => deck.id === snapshot.deckId)
          ) {
            setSavedSession(snapshot);
          } else {
            window.localStorage.removeItem(SESSION_KEY);
          }
        }
      } catch {
        // Keep the example deck if browser storage is unavailable or damaged.
      } finally {
        setLoaded(true);
      }
    }, 0);

    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(decks));
  }, [decks, loaded]);

  useEffect(() => {
    if (!loaded || view !== "study" || !activeDeckId || !currentCard || finished) return;

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

    window.localStorage.setItem(SESSION_KEY, JSON.stringify(snapshot));
    const timeout = window.setTimeout(() => setSavedSession(snapshot), 0);
    return () => window.clearTimeout(timeout);
  }, [activeDeckId, answers, cardIndex, currentCard, finished, flipped, loaded, reverse, reviewMastered, studyCards, studyMode, view]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 3200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    return () => {
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, [cardIndex, view]);

  const clearSavedSession = useCallback(() => {
    window.localStorage.removeItem(SESSION_KEY);
    setSavedSession(null);
  }, []);

  const finishSession = useCallback((finalAnswers: boolean[]) => {
    if (!activeDeckId) return;
    const score = Math.round((finalAnswers.filter(Boolean).length / Math.max(finalAnswers.length, 1)) * 100);
    setDecks((current) => current.map((deck) => (
      deck.id === activeDeckId
        ? { ...deck, lastScore: score, sessions: deck.sessions + 1 }
        : deck
    )));
    clearSavedSession();
    setFinished(true);
  }, [activeDeckId, clearSavedSession]);

  const markAnswer = useCallback((known: boolean) => {
    if (finished || !currentCard || !flipped || previewing) return;
    const nextAnswers = [...answers, known];
    setAnswers(nextAnswers);

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

        if (nextMastered.length >= activeDeck.cards.length) {
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

      setCardIndex((index) => index + 1);
      setFlipped(false);
      return;
    }

    if (cardIndex >= studyCards.length - 1) {
      finishSession(nextAnswers);
      return;
    }
    setCardIndex((index) => index + 1);
    setFlipped(false);
  }, [activeDeck, answers, cardIndex, currentCard, finishSession, finished, flipped, previewing, reviewMastered, studyCards, studyMode]);

  useEffect(() => {
    if (view !== "study" || finished || studyMode !== "review" || !currentCard) return;

    const startTimeout = window.setTimeout(() => {
      setPreviewing(true);
      setFlipped(true);
    }, 0);
    const endTimeout = window.setTimeout(() => {
      setPreviewing(false);
      setFlipped(false);
    }, 1000);

    return () => {
      window.clearTimeout(startTimeout);
      window.clearTimeout(endTimeout);
    };
  }, [cardIndex, currentCard, finished, studyMode, view]);

  useEffect(() => {
    if (view !== "study" || finished) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space" && !previewing) {
        event.preventDefault();
        setFlipped((value) => !value);
      }
      if (event.key === "ArrowLeft" && flipped && !previewing) markAnswer(false);
      if (event.key === "ArrowRight" && flipped && !previewing) markAnswer(true);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [finished, flipped, markAnswer, previewing, view]);

  function startStudy(deck: Deck, shouldShuffle = false) {
    clearSavedSession();
    setStudyMode("learn");
    setActiveDeckId(deck.id);
    setStudyCards(shouldShuffle ? shuffle(deck.cards) : [...deck.cards]);
    setCardIndex(0);
    setFlipped(false);
    setAnswers([]);
    setReviewMastered([]);
    setPreviewing(false);
    setFinished(false);
    setView("study");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function startReview(deck: Deck) {
    clearSavedSession();
    setStudyMode("review");
    setActiveDeckId(deck.id);
    setStudyCards(shuffle(deck.cards));
    setCardIndex(0);
    setFlipped(true);
    setAnswers([]);
    setReviewMastered([]);
    setPreviewing(true);
    setFinished(false);
    setView("study");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function resumeSession(snapshot: SessionSnapshot) {
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
    setPreviewing(false);
    setFinished(false);
    setView("study");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function createDeck() {
    if (!parsed.cards.length) {
      setNotice("Добавь хотя бы одну строку в формате слово — перевод");
      return;
    }

    const deck: Deck = {
      id: `deck-${Date.now().toString(36)}`,
      title: title.trim() || "Новый набор",
      cards: parsed.cards.map((card, index) => ({ ...card, id: `${Date.now()}-${index}` })),
      createdAt: Date.now(),
      lastScore: 0,
      sessions: 0,
    };

    setDecks((current) => [deck, ...current]);
    setTitle("");
    setRawText("");
    setNotice(`Готово! Создано карточек: ${deck.cards.length}`);
    window.setTimeout(() => startStudy(deck), 450);
  }

  function deleteDeck(deckId: string) {
    const deck = decks.find((item) => item.id === deckId);
    if (!deck || !window.confirm(`Удалить набор «${deck.title}»?`)) return;
    if (savedSession?.deckId === deckId) clearSavedSession();
    setDecks((current) => current.filter((item) => item.id !== deckId));
    setNotice("Набор удалён");
  }

  function focusImporter() {
    setView("home");
    window.setTimeout(() => {
      document.getElementById("importer")?.scrollIntoView({ behavior: "smooth", block: "center" });
      titleRef.current?.focus();
    }, 0);
  }

  function speak(text: string) {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      setNotice("Озвучивание не поддерживается в этом браузере");
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = /[\u0400-\u04ff]/.test(text) ? "ru-RU" : "en-US";
    utterance.rate = 0.9;
    window.speechSynthesis.speak(utterance);
  }

  if (view === "study" && activeDeck && currentCard) {
    const score = Math.round((knownCount / Math.max(answers.length, 1)) * 100);
    const cardFront = reverse ? currentCard.back : currentCard.front;
    const cardBack = reverse ? currentCard.front : currentCard.back;
    const progressCurrent = studyMode === "review" ? reviewMastered.length : cardIndex + 1;
    const progressTotal = studyMode === "review" ? activeDeck.cards.length : studyCards.length;

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
          <button className="direction-button" type="button" onClick={() => { setReverse((value) => !value); setFlipped(false); }} aria-label="Поменять стороны карточек" disabled={previewing}>
            {reverse ? "RU → EN" : "EN → RU"} <span aria-hidden="true">⇄</span>
          </button>
        </header>

        <section className="study-stage" aria-live="polite">
          {!finished ? (
            <>
              <div className="autosave-status"><i /> Прогресс сохраняется автоматически</div>
              <div className="study-meta">
                <span><strong>{progressCurrent}</strong> / {progressTotal}</span>
                <div className="progress-track" aria-label={`Прогресс: ${progressCurrent} из ${progressTotal}`}>
                  <span style={{ width: `${(progressCurrent / Math.max(progressTotal, 1)) * 100}%` }} />
                </div>
                {studyMode === "review" ? (
                  <span className="review-loop-note">↻ сложные вернутся</span>
                ) : (
                  <button type="button" onClick={() => { setStudyCards(shuffle(studyCards)); setCardIndex(0); setAnswers([]); setFlipped(false); }}>
                    Перемешать
                  </button>
                )}
              </div>

              <button className={`flashcard ${flipped ? "is-flipped" : ""} ${previewing ? "is-previewing" : ""}`} type="button" onClick={() => { if (!previewing) setFlipped((value) => !value); }} aria-label={previewing ? `Подсказка на одну секунду: ${cardBack}` : flipped ? `Перевод: ${cardBack}` : `Слово: ${cardFront}. Нажмите, чтобы увидеть перевод`}>
                <span className="flashcard-inner">
                  <span className="flashcard-face flashcard-front">
                    <small>{reverse ? "ПЕРЕВОД" : "СЛОВО"}</small>
                    <strong>{cardFront}</strong>
                    <em>Нажми, чтобы перевернуть</em>
                    <span className="card-number">{String(cardIndex + 1).padStart(2, "0")}</span>
                  </span>
                  <span className="flashcard-face flashcard-back">
                    <small>{previewing ? "ПОДСКАЗКА · 1 СЕК" : reverse ? "СЛОВО" : "ПЕРЕВОД"}</small>
                    <strong>{cardBack}</strong>
                    <em>{previewing ? "Смотри внимательно — сейчас исчезнет" : "Оцени, получилось ли вспомнить"}</em>
                    <span className="card-number">{previewing ? "1s" : "✓"}</span>
                  </span>
                </span>
              </button>

              <button
                className="pronunciation-button"
                type="button"
                onClick={() => speak(flipped ? cardBack : cardFront)}
                disabled={previewing}
                aria-label={`Озвучить: ${flipped ? cardBack : cardFront}`}
              >
                <span aria-hidden="true">◖))</span>
                Озвучить эту сторону
              </button>

              <div className={`answer-actions ${flipped && !previewing ? "is-visible" : ""}`}>
                <button className="answer-button forgot" type="button" onClick={() => markAnswer(false)} disabled={!flipped || previewing}>
                  <span>←</span><strong>Пока не помню</strong><small>стрелка влево</small>
                </button>
                <button className="answer-button knew" type="button" onClick={() => markAnswer(true)} disabled={!flipped || previewing}>
                  <strong>Вспомнил!</strong><small>стрелка вправо</small><span>→</span>
                </button>
              </div>
              <p className="keyboard-tip"><kbd>Пробел</kbd> перевернуть · <kbd>←</kbd><kbd>→</kbd> ответить</p>
            </>
          ) : (
            <div className="result-card">
              <span className="result-burst" aria-hidden="true">✦</span>
              <span className="eyebrow">{studyMode === "review" ? "ПОВТОРЕНИЕ ЗАВЕРШЕНО" : "ПОДХОД ЗАВЕРШЁН"}</span>
              <h1>{studyMode === "review" ? "Все карточки закреплены!" : score >= 80 ? "Отличная работа!" : score >= 50 ? "Хороший темп!" : "Первый шаг сделан!"}</h1>
              <p>{studyMode === "review" ? (
                <>Ты прошёл все <strong>{activeDeck.cards.length}</strong> карточек. Сложные слова возвращались в очередь.</>
              ) : (
                <>Ты вспомнил <strong>{knownCount}</strong> из <strong>{studyCards.length}</strong> карточек.</>
              )}</p>
              <div className="score-ring" style={{ "--score": `${score * 3.6}deg` } as React.CSSProperties}>
                <span>{score}%</span>
              </div>
              {studyMode === "review" && <small className="score-caption">точность ответов</small>}
              <div className="result-actions">
                <button className="secondary-button" type="button" onClick={() => startReview(activeDeck)}>{studyMode === "review" ? "Повторить ещё раз" : "Повторить сложные"}</button>
                <button className="primary-button compact" type="button" onClick={() => setView("home")}>К моим наборам →</button>
              </div>
            </div>
          )}
        </section>
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
          <a className="active" href="#sets">Мои наборы</a>
          <a href="#how">Как учиться</a>
        </nav>
        <button className="topbar-create" type="button" onClick={focusImporter}><span>＋</span> Новый набор</button>
        <div className="avatar" aria-label="Локальный профиль">О</div>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <span className="eyebrow">УЧИТЬСЯ — ЭТО ЛЕГКО</span>
          <h1>Все новые слова.<br /><em>В одной колоде.</em></h1>
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
          <input ref={titleRef} id="set-title" className="title-input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Например, Английский для путешествий" />
          <label className="field-label field-label-row" htmlFor="word-list">
            <span>Список слов</span>
            <span>слово — перевод</span>
          </label>
          <textarea id="word-list" className="words-input" value={rawText} onChange={(event) => setRawText(event.target.value)} placeholder={'journey - путешествие\ncozy - уютный'} spellCheck={false} />
          {parsed.skipped.length > 0 && (
            <p className="parse-warning">Не распознано строк: {parsed.skipped.length}. Проверь тире и перевод.</p>
          )}
          <button className="primary-button" type="button" onClick={createDeck} disabled={parsed.cards.length === 0}>
            Создать {parsed.cards.length || ""} карточки <span aria-hidden="true">→</span>
          </button>
          <p className="privacy-note"><span aria-hidden="true">✓</span> Наборы сохраняются прямо в браузере</p>
        </div>
      </section>

      <section className="library-section" id="sets">
        <div className="section-heading">
          <div>
            <span className="eyebrow">ТВОЯ БИБЛИОТЕКА</span>
            <h2>Мои наборы</h2>
          </div>
          <button className="secondary-button" type="button" onClick={focusImporter}>＋ Создать новый</button>
        </div>

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

        {decks.length ? (
          <div className="deck-grid">
            {decks.map((deck, deckIndex) => (
              <article className={`deck-card deck-tone-${deckIndex % 3}`} key={deck.id}>
                <div className="deck-topline">
                  <span className="deck-icon" aria-hidden="true">{deckIndex % 3 === 0 ? "Aa" : deckIndex % 3 === 1 ? "✦" : "あ"}</span>
                  <button className="delete-button" type="button" onClick={() => deleteDeck(deck.id)} aria-label={`Удалить набор ${deck.title}`}>×</button>
                </div>
                <h3>{deck.title}</h3>
                <p>{deck.cards.length} {deck.cards.length === 1 ? "карточка" : deck.cards.length < 5 ? "карточки" : "карточек"}</p>
                <div className="deck-progress">
                  <span><i style={{ width: `${deck.lastScore}%` }} /></span>
                  <small>{deck.sessions ? `Последний результат ${deck.lastScore}%` : "Ещё не изучали"}</small>
                </div>
                <div className="deck-actions">
                  <button className="review-button" type="button" onClick={() => startReview(deck)}>
                    <span aria-hidden="true">↻</span> Повторить
                  </button>
                  <button className="study-button" type="button" onClick={() => startStudy(deck)}>
                    Учить <span aria-hidden="true">→</span>
                  </button>
                </div>
              </article>
            ))}
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
