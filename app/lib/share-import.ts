import { saveLibrary, type LibraryState } from "./persistence.ts";

export type SharedImportContext = {
  expectedBaseline: string | null;
  expectedRevision: number;
  getRevision: () => number;
  signal: AbortSignal;
  isCurrent: () => boolean;
};

/** Call inside the library Web Lock, immediately before committing an import. */
export function commitSharedImport(
  storage: Pick<Storage, "getItem" | "setItem">,
  state: LibraryState,
  context: SharedImportContext,
): ReturnType<typeof saveLibrary> {
  // A delayed lock callback must not resurrect a dismissed link or overwrite
  // local changes that have not reached browser storage yet.
  if (context.signal.aborted || !context.isCurrent()) {
    throw new Error("Добавление набора отменено");
  }
  if (context.getRevision() !== context.expectedRevision) {
    throw new Error("Библиотека изменилась. Проверь обновления и попробуй добавить набор ещё раз.");
  }
  return saveLibrary(storage, state, context.expectedBaseline);
}
