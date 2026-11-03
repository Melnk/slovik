"use client";

import { useEffect, useRef, useState } from "react";
import type { Deck } from "./lib/library";
import { buildShareUrl, encodeSharedDeck } from "./lib/sharing";
import type { SharedDeck } from "./lib/sharing";
import "./deck-sharing.css";

type DeckShareDialogProps = {
  deck: Deck | null;
  baseUrl: string;
  onClose: () => void;
};

type SharedDeckImportProps = {
  shared: SharedDeck | null;
  error: string;
  loading: boolean;
  onImport: (shared: SharedDeck, start: boolean) => void;
  onDismiss: () => void;
  alreadyAdded: boolean;
  disabled?: boolean;
};

type GeneratedLink = { deck: Deck; baseUrl: string; url: string; error: string };

function describeError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function cardCount(count: number) {
  const lastTwo = count % 100;
  const last = count % 10;
  const noun = lastTwo >= 11 && lastTwo <= 14 ? "карточек" : last === 1 ? "карточка" : last >= 2 && last <= 4 ? "карточки" : "карточек";
  return `${count} ${noun}`;
}

function pairList(cards: { front: string; back: string }[]) {
  return cards.map(({ front, back }) => `${front} — ${back}`).join("\n");
}

export default function DeckShareDialog({ deck, baseUrl, onClose }: DeckShareDialogProps) {
  return deck ? <ShareDialog key={deck.id} deck={deck} baseUrl={baseUrl} onClose={onClose} /> : null;
}

function ShareDialog({ deck, baseUrl, onClose }: { deck: Deck; baseUrl: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const linkRef = useRef<HTMLTextAreaElement>(null);
  const wordsRef = useRef<HTMLTextAreaElement>(null);
  const [generated, setGenerated] = useState<GeneratedLink | null>(null);
  const [notice, setNotice] = useState("");
  const [showWords, setShowWords] = useState(false);
  const [sharing, setSharing] = useState(false);
  const current = generated?.deck === deck && generated.baseUrl === baseUrl ? generated : null;
  const loading = current === null;
  const link = current?.url ?? "";
  const generationError = current?.error ?? "";
  const systemShareAvailable = Boolean(link && typeof navigator !== "undefined" && typeof navigator.share === "function");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    headingRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    encodeSharedDeck(deck)
      .then((token) => {
        const url = buildShareUrl(baseUrl, token);
        if (!cancelled) setGenerated({ deck, baseUrl, url, error: "" });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setGenerated({ deck, baseUrl, url: "", error: describeError(cause, "Не удалось создать ссылку. Можно передать набор обычным списком слов.") });
      });
    return () => { cancelled = true; };
  }, [deck, baseUrl]);

  function selectLink() {
    linkRef.current?.focus();
    linkRef.current?.select();
  }

  async function copyLink() {
    if (!link) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard-unavailable");
      await navigator.clipboard.writeText(link);
      setNotice("Ссылка скопирована. Теперь её можно вставить в сообщение ученику.");
    } catch {
      selectLink();
      setNotice("Ссылка выделена. Скопируй её через меню браузера или сочетанием Ctrl+C / ⌘C.");
    }
  }

  async function copyWords() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard-unavailable");
      await navigator.clipboard.writeText(pairList(deck.cards));
      setNotice("Список слов скопирован. Получатель сможет вставить его при создании набора.");
    } catch {
      setShowWords(true);
      window.requestAnimationFrame(() => {
        wordsRef.current?.focus();
        wordsRef.current?.select();
      });
      setNotice("Список выделен ниже. Скопируй его через меню браузера или сочетанием Ctrl+C / ⌘C.");
    }
  }

  async function shareLink() {
    if (!link || sharing || typeof navigator.share !== "function") return;
    try {
      // Keep this call in the click handler so the browser receives a user gesture.
      const result = navigator.share({ title: deck.title, text: "Набор слов в Словике", url: link });
      setSharing(true);
      await result;
    } catch (cause) {
      if (!(cause instanceof Error && cause.name === "AbortError")) {
        setNotice("Не удалось открыть меню отправки. Скопируй ссылку и вставь её в нужное приложение.");
      }
    } finally {
      setSharing(false);
    }
  }

  return (
    <dialog ref={dialogRef} className="deck-share-dialog" aria-labelledby="deck-share-heading" aria-describedby="deck-share-description" onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <div className="deck-share-heading">
        <div><span className="step-label">НАБОР ДЛЯ УЧЕНИКА</span><h2 id="deck-share-heading" ref={headingRef} tabIndex={-1}>Поделиться набором</h2></div>
        <button className="deck-share-close" type="button" onClick={onClose} aria-label="Закрыть окно отправки набора">×</button>
      </div>
      <div className="deck-share-body">
        <div className="deck-share-summary"><span aria-hidden="true">Aa</span><div><strong>{deck.title}</strong><small>{cardCount(deck.cards.length)}</small></div></div>
        <p id="deck-share-description">Получатель откроет ссылку, посмотрит слова и добавит набор в свою библиотеку. Его прогресс начнётся с нуля.</p>
        <div className="deck-share-link-area" aria-busy={loading}>
          {loading && <p className="deck-share-loading" role="status"><span aria-hidden="true">↗</span> Готовим ссылку на набор…</p>}
          {generationError && <div className="deck-share-error" role="alert"><strong>Ссылка пока недоступна</strong><p>{generationError}</p><p>Можно скопировать слова ниже и передать их обычным списком.</p></div>}
          {link && (
            <>
              <label htmlFor="deck-share-link">Ссылка на набор</label>
              <textarea ref={linkRef} id="deck-share-link" className="deck-share-link" rows={3} value={link} readOnly spellCheck={false} onFocus={(event) => event.currentTarget.select()} aria-describedby="deck-share-link-help" />
              <p className="deck-share-link-help" id="deck-share-link-help">Любой, кому доступна ссылка, сможет прочитать название и слова.</p>
              <div className="deck-share-primary-actions">
                <button className="primary-button compact" type="button" onClick={copyLink}>Скопировать ссылку</button>
                {systemShareAvailable && <button className="secondary-button" type="button" onClick={shareLink} disabled={sharing}>{sharing ? "Меню отправки открыто…" : "Поделиться…"}</button>}
                <button className="deck-share-text-button" type="button" onClick={selectLink}>Выделить ссылку</button>
              </div>
            </>
          )}
        </div>
        <div className="deck-share-words">
          <div className="deck-share-words-heading"><strong>Передать обычным списком</strong><button className="deck-share-text-button" type="button" onClick={copyWords}>Скопировать слова</button></div>
          <button className="deck-share-list-toggle" type="button" onClick={() => setShowWords((value) => !value)} aria-expanded={showWords} aria-controls="deck-share-words-panel">{showWords ? "Скрыть список" : "Показать список слов"} <span aria-hidden="true">{showWords ? "−" : "+"}</span></button>
          <div id="deck-share-words-panel" hidden={!showWords}>
            <label className="deck-share-sr-only" htmlFor="deck-share-words">Список слов для ручного копирования</label>
            <textarea ref={wordsRef} id="deck-share-words" className="deck-share-word-text" rows={6} value={pairList(deck.cards)} readOnly spellCheck={false} />
          </div>
        </div>
        {notice && <p className="deck-share-notice" role="status">{notice}</p>}
        <div className="deck-share-privacy"><span aria-hidden="true">✓</span><p>В ссылке только название и слова. Результаты, расписание повторений и данные профиля не передаются. Ссылка передаёт слова, но не меняет доступ к сервису.</p></div>
      </div>
      <div className="deck-share-footer"><button className="secondary-button" type="button" onClick={onClose}>Готово</button></div>
    </dialog>
  );
}

export function SharedDeckImport({ shared, error, loading, onImport, onDismiss, alreadyAdded, disabled = false }: SharedDeckImportProps) {
  const [actionError, setActionError] = useState<{ shared: SharedDeck; message: string } | null>(null);
  if (!shared && !loading && !error) return null;
  const currentActionError = actionError?.shared === shared ? actionError?.message : "";

  function importDeck(start: boolean) {
    if (!shared || disabled || loading) return;
    try {
      onImport(shared, start);
      setActionError(null);
    } catch (cause) {
      setActionError({ shared, message: describeError(cause, "Не удалось добавить набор. Попробуй ещё раз.") });
    }
  }

  return (
    <section className="shared-deck-import" aria-labelledby="shared-deck-heading" aria-busy={loading}>
      <div className="shared-deck-topline"><span className="shared-deck-eyebrow"><span aria-hidden="true">↗</span> НАБОР ПО ССЫЛКЕ</span><button className="shared-deck-dismiss" type="button" onClick={onDismiss} aria-label="Закрыть предпросмотр набора">×</button></div>
      {loading ? (
        <div className="shared-deck-loading" role="status"><h2 id="shared-deck-heading">Открываем набор…</h2><p>Проверяем слова перед добавлением в библиотеку.</p></div>
      ) : shared ? (
        <>
          <div className="shared-deck-intro"><div><h2 id="shared-deck-heading">{shared.title}</h2><p>{cardCount(shared.cards.length)} · твой собственный прогресс</p></div><span className="shared-deck-badge" aria-hidden="true">Aa</span></div>
          <p className="shared-deck-description">{alreadyAdded ? "Открой тренировку из своей библиотеки. Текущие результаты и расписание повторений сохранятся." : "Посмотри слова и реши, добавить ли набор. Можно сразу начать тренировку или оставить его на потом."}</p>
          <div className="shared-deck-preview" aria-label="Слова из набора">
            <ul className="shared-deck-pairs">{shared.cards.slice(0, 4).map((card, index) => <li key={index}><span>{card.front}</span><i aria-hidden="true">→</i><strong>{card.back}</strong></li>)}</ul>
            {shared.cards.length > 4 && <details className="shared-deck-more"><summary>Показать остальные ({shared.cards.length - 4})</summary><ul className="shared-deck-pairs">{shared.cards.slice(4).map((card, index) => <li key={index}><span>{card.front}</span><i aria-hidden="true">→</i><strong>{card.back}</strong></li>)}</ul></details>}
          </div>
          {alreadyAdded && <p className="shared-deck-added" role="status"><span aria-hidden="true">✓</span> Этот набор уже в твоей библиотеке. Можно продолжить учиться.</p>}
          <div className="shared-deck-import-actions">
            <button className="primary-button compact" type="button" onClick={() => importDeck(true)} disabled={disabled || loading}>{alreadyAdded ? "Учить этот набор" : "Добавить и учить"}<span aria-hidden="true">→</span></button>
            {!alreadyAdded && <button className="secondary-button" type="button" onClick={() => importDeck(false)} disabled={disabled || loading}>Добавить в библиотеку</button>}
          </div>
          <p className="shared-deck-privacy">В ссылке только название и слова. После добавления твои ответы и результаты хранятся в этом браузере; отправитель их не получает.</p>
        </>
      ) : <h2 id="shared-deck-heading">Не удалось открыть набор</h2>}
      {(error || currentActionError) && <div className="shared-deck-error" role="alert">{error || currentActionError}</div>}
      {!shared && !loading && <p className="shared-deck-error-help">Попроси отправителя создать ссылку заново или передать обычный список слов. Твоя библиотека сохранена.</p>}
    </section>
  );
}
