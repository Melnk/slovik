import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Slovik home page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Словик — карточки для изучения слов<\/title>/i);
  assert.match(html, /Все новые слова/);
  assert.match(html, /Мои наборы/);
  assert.match(html, /Последний результат 67% · 2 подхода/);
  assert.match(html, /Наборы сохраняются прямо в браузере/);
  assert.match(html, /Устанавливать ничего не нужно/);
  assert.match(html, /Преподавателю и ученикам/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("keeps the finished app free of starter preview code", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<StudyApp \/>/);
  assert.match(layout, /Словик — карточки для изучения слов/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await assert.rejects(
    access(new URL("app/_sites-preview/SkeletonPreview.tsx", templateRoot)),
  );
});

test("offers pronunciation for the visible card side", async () => {
  const source = await readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8");

  assert.match(source, /new SpeechSynthesisUtterance\(text\)/);
  assert.match(source, /utterance\.lang = \/\[\\u0400-\\u04ff\]\//);
  assert.match(source, /aria-label=\{`Озвучить:/);
  assert.match(source, /flipped \? cardBack : cardFront/);
});

test("reveals the hidden answer one letter at a time without showing it completely", async () => {
  const source = await readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8");

  assert.match(source, /function buildProgressiveHint\(answer: string, revealedLetters: number\)/);
  assert.match(source, /letterIndex <= revealedLetters \? character : "·"/);
  assert.match(source, /const maximumHintLetters = Math\.max\(0, hintLetterCount - 1\)/);
  assert.match(source, /setRevealedHintLetters\(\(count\) => Math\.min\(count \+ 1, maximumHintLetters\)\)/);
  assert.match(source, /Подсказка: <b>\{progressiveHint\}<\/b>/);
  assert.match(source, /setFlipped\(false\);[\s\S]*?setRevealedHintLetters\(0\);/);
});

test("hides an opened hint so the same card can be recalled unaided", async () => {
  const source = await readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8");

  assert.match(source, /!flipped && revealedHintLetters > 0 && \(/);
  assert.match(source, /onClick=\{\(\) => setRevealedHintLetters\(0\)\}/);
  assert.match(source, /disabled=\{switching\}[\s\S]*?Скрыть подсказку/);
  assert.match(source, /revealedHintLetters === 0 \? "Подсказка ответа"/);
});

test("reveals the next hint letter with the H key", async () => {
  const source = await readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8");

  assert.match(source, /event\.code === "KeyH"/);
  assert.match(source, /!event\.repeat && !flipped && !switching/);
  assert.match(source, /revealAnswerHint\(\)/);
  assert.match(source, /<kbd>H<\/kbd> подсказка/);
});

test("pronounces the visible card side with the P key", async () => {
  const source = await readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8");

  assert.match(source, /event\.code === "KeyP"/);
  assert.match(source, /!event\.repeat && !switching && currentCard/);
  assert.match(source, /speak\(flipped[\s\S]*?currentCard\.front[\s\S]*?currentCard\.back/);
  assert.match(source, /<kbd>P<\/kbd> озвучить/);
});

test("postpones an unrevealed card without recording an answer", async () => {
  const source = await readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8");

  assert.match(source, /const postponeCard = useCallback/);
  assert.match(source, /next\.splice\(cardIndex, 1\)/);
  assert.match(source, /next\.push\(postponed\)/);
  assert.match(source, /onClick=\{postponeCard\}/);
  assert.match(source, /Вернуться позже/);
  assert.doesNotMatch(source.match(/const postponeCard[\s\S]*?\}, \[cardIndex/)?.[0] ?? "", /setAnswers|markAnswer/);
});

test("postpones an unrevealed card with the R key", async () => {
  const source = await readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8");

  assert.match(source, /event\.code === "KeyR"/);
  assert.match(source, /!event\.repeat && !flipped && !switching && cardIndex < studyCards\.length - 1/);
  assert.match(source, /postponeCard\(\)/);
  assert.match(source, /<kbd>R<\/kbd> позже/);
});

test("starts a focused review with only the mistakes from the finished study session", async () => {
  const source = await readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8");

  assert.match(source, /const missedCards = studyMode === "learn"[\s\S]*?answers\[index\] === false/);
  assert.match(source, /function startReview\(deck: Deck, focusedCards\?: WordCard\[\]\)/);
  assert.match(source, /setStudyCards\(focusedCards \? shuffle\(focusedCards\) : selectReviewCards\(deck\)\)/);
  assert.match(source, /startReview\(activeDeck, missedCards\)/);
  assert.match(source, /Повторить ошибки \(\{missedCards\.length\}\)/);
});

test("restarts the full deck directly from a finished study session", async () => {
  const source = await readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8");

  assert.match(source, /studyMode === "learn" && \([\s\S]*?onClick=\{\(\) => startStudy\(activeDeck\)\}/);
  assert.match(source, /Пройти весь набор снова/);
});

test("shuffles only the remaining study cards without resetting progress", async () => {
  const source = await readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8");

  assert.match(source, /const shuffleRemainingCards = useCallback/);
  assert.match(source, /\.\.\.current\.slice\(0, cardIndex\)/);
  assert.match(source, /\.\.\.shuffle\(current\.slice\(cardIndex\)\)/);
  assert.match(source, /onClick=\{shuffleRemainingCards\}/);
  assert.match(source, /Перемешать оставшиеся/);
  assert.doesNotMatch(
    source.match(/const shuffleRemainingCards[\s\S]*?\}, \[cardIndex/)?.[0] ?? "",
    /setAnswers|setCardIndex/,
  );
});

test("shuffles the remaining study cards with the S key", async () => {
  const source = await readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8");

  assert.match(source, /event\.code === "KeyS"/);
  assert.match(source, /!event\.repeat && !switching && studyMode === "learn" && cardIndex < studyCards\.length - 1/);
  assert.match(source, /shuffleRemainingCards\(\)/);
  assert.match(source, /<kbd>S<\/kbd> перемешать/);
});

test("switches the study direction with the D key", async () => {
  const source = await readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8");

  assert.match(source, /const toggleStudyDirection = useCallback/);
  assert.match(source, /setReverse\(\(value\) => !value\)/);
  assert.match(source, /setFlipped\(false\)/);
  assert.match(source, /setRevealedHintLetters\(0\)/);
  assert.match(source, /event\.code === "KeyD"/);
  assert.match(source, /!event\.repeat && !switching/);
  assert.match(source, /toggleStudyDirection\(\)/);
  assert.match(source, /onClick=\{toggleStudyDirection\}/);
  assert.match(source, /<kbd>D<\/kbd> направление/);
});

test("shows a live answer summary during a study session", async () => {
  const source = await readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8");

  assert.match(source, /const forgottenCount = answers\.length - knownCount/);
  assert.match(source, /answers\.length > 0 && \(/);
  assert.match(source, /Вспомнил: <strong>\{knownCount\}<\/strong>/);
  assert.match(source, /Повторить: <strong>\{forgottenCount\}<\/strong>/);
  assert.match(source, /aria-label=\{`Текущий результат: вспомнил \$\{knownCount\}, нужно повторить \$\{forgottenCount\}`\}/);
});

test("does not auto-reveal the next review card", async () => {
  const source = await readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /setPreviewing|setFlipped\(true\)/);
  assert.match(source, /function startReview[\s\S]*?setFlipped\(false\)/);
});

test("randomizes study sessions and builds a mixed five-card review", async () => {
  const source = await readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8");

  assert.match(source, /function startStudy[\s\S]*?setStudyCards\(shuffle\(deck\.cards\)\)/);
  assert.match(source, /function selectReviewCards[\s\S]*?deck\.mistakes/);
  assert.match(source, /const REVIEW_CARDS = 5/);
  assert.match(source, /const DIFFICULT_REVIEW_CARDS = 3/);
  assert.match(source, /const familiarCards = shuffle/);
  assert.match(source, /return shuffle\(selectedCards\)/);
});

test("shows how many difficult words each deck contains", async () => {
  const source = await readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8");

  assert.match(source, /function countDifficultCards\(deck: Deck\)/);
  assert.match(source, /return getDifficultCards\(deck\)\.length/);
  assert.match(source, /countDifficultCards\(deck\).*?сложн\./s);
});

test("shows the completed study session count for each practiced deck", async () => {
  const source = await readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8");

  assert.match(source, /function formatSessionCount\(count: number\)/);
  assert.match(source, /lastTwoDigits >= 11 && lastTwoDigits <= 14/);
  assert.match(source, /Последний результат \$\{deck\.lastScore\}% · \$\{formatSessionCount\(deck\.sessions\)\}/);
  assert.doesNotMatch(
    source.match(/function formatSessionCount[\s\S]*?\n\}/)?.[0] ?? "",
    /localStorage|setDecks|setSavedSession/,
  );
});

test("starts a focused review with every difficult word in a deck", async () => {
  const source = await readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8");

  assert.match(source, /function getDifficultCards\(deck: Deck\)/);
  assert.match(source, /deck\.cards\.filter\(\(card\) => \(deck\.mistakes\?\.\[card\.id\] \?\? 0\) > 0\)/);
  assert.match(source, /countDifficultCards\(deck\) > 0 && \(/);
  assert.match(source, /startReview\(deck, getDifficultCards\(deck\)\)/);
  assert.match(source, /> Сложные/);
});

test("renames a deck without replacing its saved data", async () => {
  const source = await readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8");

  assert.match(source, /function renameDeck\(deck: Deck\)/);
  assert.match(source, /window\.prompt\("Новое название набора", deck\.title\)/);
  assert.match(source, /item\.id === deck\.id \? \{ \.\.\.item, title: normalizedTitle \} : item/);
  assert.match(source, /onClick=\{\(\) => renameDeck\(deck\)\}/);
});

test("copies a deck without changing its saved data", async () => {
  const source = await readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8");

  assert.match(source, /function copyDeck\(deck: Deck\)/);
  assert.match(source, /\.map\(\(card\) => `\$\{card\.front\} — \$\{card\.back\}`\)/);
  assert.match(source, /navigator\.clipboard\.writeText\(wordList\)/);
  assert.match(source, /window\.prompt\("Скопируй список слов", wordList\)/);
  assert.match(source, /onClick=\{\(\) => copyDeck\(deck\)\}/);
});

test("resets the card face before replacing its content", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../app/StudyApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(source, /setSwitching\(true\);[\s\S]*?setFlipped\(false\);[\s\S]*?requestAnimationFrame[\s\S]*?setCardIndex/);
  assert.match(source, /switching \? "is-switching"/);
  assert.match(css, /\.flashcard\.is-switching \.flashcard-inner \{ transform: rotateY\(0deg\); transition: none; \}/);
});
