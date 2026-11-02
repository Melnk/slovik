"use client";

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { LIBRARY_LIMITS, parseBackup, serializeBackup, updateDeckContent } from "./lib/library";
import type { Deck } from "./lib/library";
import "./library-tools.css";

type LibraryToolsProps = {
  decks: Deck[];
  onRestore: (decks: Deck[]) => void;
  onEdit: (deck: Deck) => void;
  editingDeck: Deck | null;
  onCloseEditor: () => void;
};

type EditorRow = { key: string; front: string; back: string };
type RowErrors = Record<string, { front?: string; back?: string; duplicate?: string }>;

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function pluralCards(count: number) {
  const lastTwo = count % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return `${count} карточек`;
  const last = count % 10;
  return `${count} ${last === 1 ? "карточка" : last >= 2 && last <= 4 ? "карточки" : "карточек"}`;
}

export default function LibraryTools({ decks, onRestore, onEdit, editingDeck, onCloseEditor }: LibraryToolsProps) {
  const [pendingBackup, setPendingBackup] = useState<{ decks: Deck[]; filename: string } | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const readVersionRef = useRef(0);

  useEffect(() => () => { readVersionRef.current += 1; }, []);

  function exportLibrary() {
    setError("");
    setStatus("");
    let downloadUrl: string | null = null;
    try {
      const backup = serializeBackup(decks);
      const blob = new Blob([backup], { type: "application/json;charset=utf-8" });
      downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const date = new Intl.DateTimeFormat("sv-SE").format(new Date());
      link.href = downloadUrl;
      link.download = `slovik-backup-${date}.json`;
      link.hidden = true;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setStatus("Файл резервной копии подготовлен. Сохрани его в надёжном месте.");
    } catch (cause) {
      setError(errorMessage(cause, "Не удалось подготовить копию. Попробуй ещё раз."));
    } finally {
      if (downloadUrl) {
        const url = downloadUrl;
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    }
  }

  async function readBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const version = ++readVersionRef.current;
    setPendingBackup(null);
    setError("");
    setStatus("");
    if (!file) {
      setReading(false);
      return;
    }
    if (file.size > LIBRARY_LIMITS.backupBytes) {
      setReading(false);
      setError(`Файл слишком большой. Максимальный размер — ${LIBRARY_LIMITS.backupBytes / (1024 * 1024)} МБ.`);
      event.target.value = "";
      return;
    }
    setReading(true);
    try {
      const text = await file.text();
      if (version !== readVersionRef.current) return;
      const restoredDecks = parseBackup(text);
      if (!restoredDecks.length) throw new Error("В этом файле нет наборов для восстановления.");
      if (decks.length + restoredDecks.length > LIBRARY_LIMITS.decks) {
        throw new Error(`После добавления будет слишком много наборов. Лимит библиотеки — ${LIBRARY_LIMITS.decks}.`);
      }
      if ([...decks, ...restoredDecks].reduce((total, deck) => total + deck.cards.length, 0) > LIBRARY_LIMITS.totalCards) {
        throw new Error(`После добавления будет слишком много карточек. Лимит библиотеки — ${LIBRARY_LIMITS.totalCards}.`);
      }
      setPendingBackup({ decks: restoredDecks, filename: file.name });
    } catch (cause) {
      if (version !== readVersionRef.current) return;
      setError(errorMessage(cause, "Не удалось прочитать файл. Выбери JSON-копию Словика."));
    } finally {
      if (version === readVersionRef.current) {
        setReading(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    }
  }

  function addBackup() {
    if (!pendingBackup) return;
    setError("");
    try {
      if (decks.length + pendingBackup.decks.length > LIBRARY_LIMITS.decks) {
        throw new Error(`В библиотеке может быть не больше ${LIBRARY_LIMITS.decks} наборов.`);
      }
      if ([...decks, ...pendingBackup.decks].reduce((total, deck) => total + deck.cards.length, 0) > LIBRARY_LIMITS.totalCards) {
        throw new Error(`В библиотеке может быть не больше ${LIBRARY_LIMITS.totalCards} карточек.`);
      }
      onRestore(pendingBackup.decks);
      setStatus(`Наборы из копии добавлены: ${pendingBackup.decks.length}.`);
      setPendingBackup(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (cause) {
      setError(errorMessage(cause, "Не удалось добавить наборы. Проверь свободное место в браузере."));
    }
  }

  function cancelImport() {
    readVersionRef.current += 1;
    setPendingBackup(null);
    setReading(false);
    setError("");
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <>
      <details className="library-tools">
        <summary>Резервная копия и перенос <span aria-hidden="true">↗</span></summary>
        <div className="library-tools-content">
          <p className="library-tools-description">Сохрани все наборы, результаты и расписание повторений в одном JSON-файле.</p>
          <button className="secondary-button library-export-button" type="button" onClick={exportLibrary} disabled={decks.length === 0}>
            Скачать резервную копию
          </button>
          <div className="library-import-block">
            <label htmlFor="library-backup-file">Добавить наборы из копии</label>
            <p id="library-backup-help">Выбери JSON-файл Словика до {LIBRARY_LIMITS.backupBytes / (1024 * 1024)} МБ. Перед добавлением появится предпросмотр.</p>
            <input ref={fileRef} id="library-backup-file" type="file" accept=".json,application/json" onChange={readBackup} aria-describedby="library-backup-help" disabled={reading} />
            {reading && <p className="library-feedback" role="status">Проверяем резервную копию…</p>}
            {pendingBackup && (
              <div className="library-backup-preview">
                <strong>Копия готова к добавлению</strong>
                <span className="library-backup-filename">{pendingBackup.filename}</span>
                <p>Наборов: {pendingBackup.decks.length} · {pluralCards(pendingBackup.decks.reduce((total, deck) => total + deck.cards.length, 0))}</p>
                <p>Текущие наборы сохранятся. Из копии будут добавлены отдельные наборы с их учебным прогрессом.</p>
                <div className="library-backup-actions">
                  <button className="secondary-button" type="button" onClick={cancelImport}>Отмена</button>
                  <button className="primary-button compact" type="button" onClick={addBackup}>Добавить наборы</button>
                </div>
              </div>
            )}
          </div>
          {error && <p className="library-feedback is-error" role="alert">{error}</p>}
          {status && <p className="library-feedback is-success" role="status">{status}</p>}
          <p className="library-privacy-note">Данные хранятся в этом браузере. Для переноса на другое устройство и на случай очистки браузера нужна резервная копия. JSON-файл содержит твои слова и результаты — передавай его только тем, кому доверяешь.</p>
        </div>
      </details>
      {editingDeck && <DeckEditor key={editingDeck.id} deck={editingDeck} onSave={onEdit} onClose={onCloseEditor} />}
    </>
  );
}

function DeckEditor({ deck, onSave, onClose }: { deck: Deck; onSave: (deck: Deck) => void; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const lastRowFrontRef = useRef<HTMLInputElement>(null);
  const rowKeyRef = useRef(deck.cards.length);
  const focusNewRowRef = useRef(false);
  const [title, setTitle] = useState(deck.title);
  const [rows, setRows] = useState<EditorRow[]>(() => deck.cards.map((card, index) => ({ key: `row-${index}`, front: card.front, back: card.back })));
  const [titleError, setTitleError] = useState("");
  const [rowErrors, setRowErrors] = useState<RowErrors>({});
  const [formError, setFormError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    titleRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    if (focusNewRowRef.current) {
      lastRowFrontRef.current?.focus();
      focusNewRowRef.current = false;
    }
  }, [rows.length]);

  function changeRow(key: string, field: "front" | "back", value: string) {
    setRows((current) => current.map((row) => row.key === key ? { ...row, [field]: value } : row));
  }

  function addRow() {
    if (rows.length >= LIBRARY_LIMITS.cardsPerDeck) return;
    focusNewRowRef.current = true;
    setRows((current) => [...current, { key: `row-${rowKeyRef.current++}`, front: "", back: "" }]);
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const errors: RowErrors = {};
    const seen = new Set<string>();
    const nextTitleError = !title.trim() ? "Укажи название набора." : title.trim().length > LIBRARY_LIMITS.title ? `Не больше ${LIBRARY_LIMITS.title} символов.` : "";
    rows.forEach((row) => {
      const front = row.front.trim();
      const back = row.back.trim();
      const rowError: RowErrors[string] = {};
      if (!front) rowError.front = "Добавь слово или фразу.";
      else if (front.length > LIBRARY_LIMITS.side) rowError.front = `Не больше ${LIBRARY_LIMITS.side} символов.`;
      if (!back) rowError.back = "Добавь перевод или ответ.";
      else if (back.length > LIBRARY_LIMITS.side) rowError.back = `Не больше ${LIBRARY_LIMITS.side} символов.`;
      const pair = JSON.stringify([front.toLocaleLowerCase(), back.toLocaleLowerCase()]);
      if (front && back && seen.has(pair)) rowError.duplicate = "Такая пара уже есть в наборе. Измени её или удали повтор.";
      seen.add(pair);
      if (Object.keys(rowError).length) errors[row.key] = rowError;
    });
    setTitleError(nextTitleError);
    setRowErrors(errors);
    setFormError("");
    if (nextTitleError || Object.keys(errors).length || !rows.length) {
      setFormError("Проверь отмеченные поля. В наборе нужна хотя бы одна заполненная пара.");
      if (nextTitleError) titleRef.current?.focus();
      else {
        const firstErrorKey = Object.keys(errors)[0];
        if (firstErrorKey) document.getElementById(`editor-${firstErrorKey}-${errors[firstErrorKey].front ? "front" : "back"}`)?.focus();
      }
      return;
    }
    try {
      onSave(updateDeckContent(deck, title.trim(), rows.map(({ front, back }) => ({ front: front.trim(), back: back.trim() }))));
      onClose();
    } catch (cause) {
      setFormError(errorMessage(cause, "Не удалось сохранить набор. Попробуй ещё раз."));
    }
  }

  return (
    <dialog ref={dialogRef} className="library-editor" aria-labelledby="deck-editor-title" aria-describedby="deck-editor-description" onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <form onSubmit={save} noValidate>
        <div className="library-editor-heading">
          <div><span className="step-label">ТВОЙ НАБОР</span><h2 id="deck-editor-title">Редактировать набор</h2></div>
          <button className="library-editor-close" type="button" onClick={onClose} aria-label="Закрыть редактор">×</button>
        </div>
        <div className="library-editor-body">
          <p id="deck-editor-description">Исправляй слова, добавляй новые пары и убирай лишние. Прогресс неизменённых карточек сохранится.</p>
          <label className="field-label" htmlFor="deck-editor-name">Название набора</label>
          <input ref={titleRef} className="title-input" id="deck-editor-name" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={LIBRARY_LIMITS.title} aria-invalid={Boolean(titleError)} aria-describedby={titleError ? "deck-editor-name-error" : undefined} />
          {titleError && <p className="library-field-error" id="deck-editor-name-error">{titleError}</p>}
          <div className="library-editor-list-heading"><h3>Слова и переводы</h3><span>{pluralCards(rows.length)}</span></div>
          <ol className="library-editor-rows">
            {rows.map((row, index) => {
              const errors = rowErrors[row.key];
              const frontId = `editor-${row.key}-front`;
              const backId = `editor-${row.key}-back`;
              return (
                <li className="library-editor-row" key={row.key}>
                  <span className="library-editor-row-number" aria-hidden="true">{index + 1}</span>
                  <div className="library-editor-field">
                    <label htmlFor={frontId}>Слово или фраза <span className="sr-only">{index + 1}</span></label>
                    <input ref={index === rows.length - 1 ? lastRowFrontRef : undefined} id={frontId} value={row.front} onChange={(event) => changeRow(row.key, "front", event.target.value)} maxLength={LIBRARY_LIMITS.side} aria-invalid={Boolean(errors?.front || errors?.duplicate)} aria-describedby={errors?.front ? `${frontId}-error` : errors?.duplicate ? `${frontId}-duplicate` : undefined} />
                    {errors?.front && <p className="library-field-error" id={`${frontId}-error`}>{errors.front}</p>}
                  </div>
                  <div className="library-editor-field">
                    <label htmlFor={backId}>Перевод или ответ <span className="sr-only">{index + 1}</span></label>
                    <input id={backId} value={row.back} onChange={(event) => changeRow(row.key, "back", event.target.value)} maxLength={LIBRARY_LIMITS.side} aria-invalid={Boolean(errors?.back || errors?.duplicate)} aria-describedby={errors?.back ? `${backId}-error` : undefined} />
                    {errors?.back && <p className="library-field-error" id={`${backId}-error`}>{errors.back}</p>}
                  </div>
                  <button className="library-editor-remove" type="button" onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))} disabled={rows.length === 1} aria-label={`Удалить пару ${index + 1}${row.front ? `: ${row.front}` : ""}`}>×</button>
                  {errors?.duplicate && <p className="library-field-error library-pair-error" id={`${frontId}-duplicate`}>{errors.duplicate}</p>}
                </li>
              );
            })}
          </ol>
          <button className="secondary-button library-add-row" type="button" onClick={addRow} disabled={rows.length >= LIBRARY_LIMITS.cardsPerDeck}>＋ Добавить пару</button>
          {rows.length >= LIBRARY_LIMITS.cardsPerDeck && <p className="library-feedback">В одном наборе может быть до {LIBRARY_LIMITS.cardsPerDeck} карточек.</p>}
          {formError && <p className="library-feedback is-error" role="alert">{formError}</p>}
        </div>
        <div className="library-editor-actions">
          <button className="secondary-button" type="button" onClick={onClose}>Отмена</button>
          <button className="primary-button compact" type="submit">Сохранить набор</button>
        </div>
      </form>
    </dialog>
  );
}
