import { validateDecks, validateSession, type Deck, type SessionSnapshot } from "./library.ts";

export const LIBRARY_KEY = "slovik-library-v2";
type Store = Pick<Storage, "getItem" | "setItem">;
export type LibraryState = { decks: Deck[]; session: SessionSnapshot | null };
type ReadResult = LibraryState & { baseline: string | null; error: string; original: string | null };

// One write commits the cards, their review schedule and the active session together.
// The v1 keys remain untouched so a failed migration is always recoverable.
export function readLibrary(storage: Store, fallback: Deck[]): ReadResult {
  let original: string | null = null;
  let baseline: string | null = null;
  try {
    baseline = storage.getItem(LIBRARY_KEY);
    original = baseline;
    if (baseline !== null) {
      const data = JSON.parse(baseline);
      if (data?.version !== 2 || data?.format !== "slovik-library") throw new Error("Неизвестный формат библиотеки");
      const decks = validateDecks(data.decks);
      const session = validateSession(data.session, decks);
      if (data.session != null && session === null) {
        return { decks, session: null, baseline, original,
          error: "Наборы прочитаны, но сохранённый подход повреждён. Скачайте исходную запись или продолжите с доступными наборами; оригинал будет сохранён отдельно." };
      }
      return { decks, session, baseline, error: "", original: null };
    }
    const legacy = storage.getItem("slovik-decks-v1");
    original = legacy;
    const decks = legacy === null ? fallback : validateDecks(JSON.parse(legacy));
    // A damaged session must not hide an otherwise healthy library.
    let session: SessionSnapshot | null = null;
    try {
      const rawSession = storage.getItem("slovik-active-session-v1");
      session = rawSession ? validateSession(JSON.parse(rawSession), decks) : null;
    } catch { /* The legacy session is retained for recovery. */ }
    return { decks, session, baseline, error: "", original: null };
  } catch {
    return { decks: fallback, session: null, baseline, original,
      error: "Не удалось прочитать сохранённые данные. Исходная запись не изменена. Скачайте её и восстановите библиотеку из резервной копии." };
  }
}

export function saveLibrary(storage: Store, state: LibraryState, expected: string | null):
  { ok: true; baseline: string } | { ok: false; conflict: boolean; error: string } {
  try {
    if (storage.getItem(LIBRARY_KEY) !== expected) {
      return { ok: false, conflict: true,
        error: "Библиотека изменена в другой вкладке. Скачайте копию текущих изменений, затем загрузите обновления." };
    }
    const decks = validateDecks(state.decks);
    if (state.session !== null && !validateSession(state.session, state.decks)) {
      return { ok: false, conflict: false, error: "Подход не удалось сохранить. Вернитесь к наборам и начните новый подход; библиотека сохранена без изменений." };
    }
    const baseline = JSON.stringify({ format: "slovik-library", version: 2, decks, session: state.session });
    if (baseline !== expected) storage.setItem(LIBRARY_KEY, baseline);
    return { ok: true, baseline };
  } catch {
    return { ok: false, conflict: false,
      error: "Браузер не смог сохранить изменения. Они доступны в этой вкладке: скачайте резервную копию перед закрытием." };
  }
}
