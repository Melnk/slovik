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

const STORAGE_KEY = "slovik-decks-v1";
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

export default function StudyApp() {
  const [decks, setDecks] = useState<Deck[]>(DEMO_DECKS);
  const [loaded, setLoaded] = useState(false);
  const [title, setTitle] = useState("Английский для путешествий");
  const [rawText, setRawText] = useState(SAMPLE_TEXT);
  const [view, setView] = useState<View>("home");
  const [activeDeckId, setActiveDeckId] = useState<string | null>(null);
  const [studyCards, setStudyCards] = useState<WordCard[]>([]);
  const [cardIndex, setCardIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [reverse, setReverse] = useState(false);
  const [answers, setAnswers] = useState<boolean[]>([]);
  const [finished, setFinished] = useState(false);
  const [notice, setNotice] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);

  const parsed = useMemo(() => parsePairs(rawText), [rawText]);
  const activeDeck = decks.find((deck) => deck.id === activeDeckId) ?? null;
  const currentCard = studyCards[cardIndex];
  const knownCount = answers.filter(Boolean).length;

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const storedDecks = JSON.parse(saved) as Deck[];
        if (Array.isArray(storedDecks)) setDecks(storedDecks);
      }
    } catch {
      // Keep the example deck if browser storage is unavailable or damaged.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!loaded) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(decks));
  }, [decks, loaded]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 3200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const finishSession = useCallback((finalAnswers: boolean[]) => {
    if (!activeDeckId) return;
    const score = Math.round((finalAnswers.filter(Boolean).length / Math.max(finalAnswers.length, 1)) * 100);
    setDecks((current) => current.map((deck) => (
      deck.id === activeDeckId
        ? { ...deck, lastScore: score, sessions: deck.sessions + 1 }
        : deck
    )));
    setFinished(true);
  }, [activeDeckId]);

  const markAnswer = useCallback((known: boolean) => {
    if (finished || !currentCard || !flipped) return;
    const nextAnswers = [...answers, known];
    setAnswers(nextAnswers);
    if (cardIndex >= studyCards.length - 1) {
      finishSession(nextAnswers);
      return;
    }
    setCardIndex((index) => index + 1);
    setFlipped(false);
  }, [answers, cardIndex, currentCard, finishSession, finished, flipped, studyCards.length]);

  useEffect(() => {
    if (view !== "study" || finished) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        event.preventDefault();
        setFlipped((value) => !value);
      }
      if (event.key === "ArrowLeft" && flipped) markAnswer(false);
      if (event.key === "ArrowRight" && flipped) markAnswer(true);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [finished, flipped, markAnswer, view]);

  function startStudy(deck: Deck, shouldShuffle = false) {
    setActiveDeckId(deck.id);
    setStudyCards(shouldShuffle ? shuffle(deck.cards) : [...deck.cards]);
    setCardIndex(0);
    setFlipped(false);
    setAnswers([]);
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

  if (view === "study" && activeDeck && currentCard) {
    const score = Math.round((knownCount / Math.max(answers.length, 1)) * 100);
    const cardFront = reverse ? currentCard.back : currentCard.front;
    const cardBack = reverse ? currentCard.front : currentCard.back;

    return (
      <main className="study-shell">
        <header className="study-topbar">
          <button className="back-button" type="button" onClick={() => setView("home")} aria-label="Вернуться к наборам">←</button>
          <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setView("home"); }} aria-label="Словик — на главную">
            <BrandMark />
            <span>словик</span>
          </a>
          <div className="study-title-block">
            <span>Тренировка</span>
            <strong>{activeDeck.title}</strong>
          </div>
          <button className="direction-button" type="button" onClick={() => { setReverse((value) => !value); setFlipped(false); }} aria-label="Поменять стороны карточек">
            {reverse ? "RU → EN" : "EN → RU"} <span aria-hidden="true">⇄</span>
          </button>
        </header>

        <section className="study-stage" aria-live="polite">
          {!finished ? (
            <>
              <div className="study-meta">
                <span><strong>{cardIndex + 1}</strong> / {studyCards.length}</span>
                <div className="progress-track" aria-label={`Прогресс: ${cardIndex + 1} из ${studyCards.length}`}>
                  <span style={{ width: `${((cardIndex + 1) / studyCards.length) * 100}%` }} />
                </div>
                <button type="button" onClick={() => { setStudyCards(shuffle(studyCards)); setCardIndex(0); setAnswers([]); setFlipped(false); }}>
                  Перемешать
                </button>
              </div>

              <button className={`flashcard ${flipped ? "is-flipped" : ""}`} type="button" onClick={() => setFlipped((value) => !value)} aria-label={flipped ? `Перевод: ${cardBack}` : `Слово: ${cardFront}. Нажмите, чтобы увидеть перевод`}>
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

              <div className={`answer-actions ${flipped ? "is-visible" : ""}`}>
                <button className="answer-button forgot" type="button" onClick={() => markAnswer(false)} disabled={!flipped}>
                  <span>←</span><strong>Пока не помню</strong><small>стрелка влево</small>
                </button>
                <button className="answer-button knew" type="button" onClick={() => markAnswer(true)} disabled={!flipped}>
                  <strong>Вспомнил!</strong><small>стрелка вправо</small><span>→</span>
                </button>
              </div>
              <p className="keyboard-tip"><kbd>Пробел</kbd> перевернуть · <kbd>←</kbd><kbd>→</kbd> ответить</p>
            </>
          ) : (
            <div className="result-card">
              <span className="result-burst" aria-hidden="true">✦</span>
              <span className="eyebrow">ПОДХОД ЗАВЕРШЁН</span>
              <h1>{score >= 80 ? "Отличная работа!" : score >= 50 ? "Хороший темп!" : "Первый шаг сделан!"}</h1>
              <p>Ты вспомнил <strong>{knownCount}</strong> из <strong>{studyCards.length}</strong> карточек.</p>
              <div className="score-ring" style={{ "--score": `${score * 3.6}deg` } as React.CSSProperties}>
                <span>{score}%</span>
              </div>
              <div className="result-actions">
                <button className="secondary-button" type="button" onClick={() => startStudy(activeDeck, true)}>Ещё раз</button>
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
                <button className="study-button" type="button" onClick={() => startStudy(deck)}>
                  Учить <span aria-hidden="true">→</span>
                </button>
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
          <li><span>03</span><div><strong>Закрепи</strong><p>Отметь ответ и повтори слова, которые пока сложны.</p></div></li>
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
