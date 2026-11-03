import { LIBRARY_LIMITS, type Deck } from "./library.ts";

export type SharedDeck = {
  title: string;
  cards: { front: string; back: string }[];
};

export const SHARING_LIMITS = {
  token: 24000,
  decodedBytes: 256 * 1024,
  cards: 200,
  title: LIBRARY_LIMITS.title,
  side: LIBRARY_LIMITS.side,
} as const;

const TOO_LARGE = "Набор слишком большой для ссылки. Используйте резервную копию файла.";
const INVALID_LINK = "Ссылка на набор повреждена или имеет неверный формат.";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, limit: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) {
    throw new Error(`${label}: требуется текст длиной от 1 до ${limit} символов.`);
  }
  return value;
}

function validateSharedDeck(value: unknown): SharedDeck {
  if (!object(value)) throw new Error(INVALID_LINK);
  const title = text(value.title, SHARING_LIMITS.title, "Название набора");
  if (!Array.isArray(value.cards) || !value.cards.length || value.cards.length > SHARING_LIMITS.cards) {
    throw new Error(`По ссылке можно передать от 1 до ${SHARING_LIMITS.cards} карточек. Для большого набора используйте файл.`);
  }
  const pairs = new Set<string>();
  const cards = value.cards.map((card) => {
    if (!object(card)) throw new Error(INVALID_LINK);
    const front = text(card.front, SHARING_LIMITS.side, "Слово");
    const back = text(card.back, SHARING_LIMITS.side, "Перевод");
    const key = JSON.stringify([front, back].map((side) => side.normalize("NFKC").trim().toLowerCase()));
    if (pairs.has(key)) throw new Error("В наборе повторяются одинаковые пары слов.");
    pairs.add(key);
    // The allowlist deliberately drops IDs, results and review metadata.
    return { front, back };
  });
  return { title, cards };
}

function payloadBytes(value: SharedDeck): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength > SHARING_LIMITS.decodedBytes) throw new Error(TOO_LARGE);
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error(INVALID_LINK);
  let binary: string;
  try {
    binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
  } catch {
    throw new Error(INVALID_LINK);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  // atob accepts non-zero padding bits; only the canonical encoding is valid.
  if (toBase64Url(bytes) !== value) throw new Error(INVALID_LINK);
  return bytes;
}

function tokenParts(token: string): { version: "v1" | "j1"; encoded: string } {
  if (typeof token !== "string" || token.length > SHARING_LIMITS.token) throw new Error(TOO_LARGE);
  const separator = token.indexOf(".");
  if (separator < 0) throw new Error(INVALID_LINK);
  const version = token.slice(0, separator);
  if (version !== "v1" && version !== "j1") throw new Error("Эта версия ссылки не поддерживается. Попросите отправителя создать новую ссылку.");
  const encoded = token.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) throw new Error(INVALID_LINK);
  return { version, encoded };
}

async function collectBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > limit - total) {
        await reader.cancel().catch(() => {});
        throw new Error(TOO_LARGE);
      }
      total += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function byteStream(bytes: Uint8Array): ReadableStream<BufferSource> {
  return new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(Uint8Array.from(bytes));
      controller.close();
    },
  });
}

/** Tokens contain only vocabulary. Fragments are not sent in HTTP requests. */
export async function encodeSharedDeck(deck: Pick<Deck, "title" | "cards">): Promise<string> {
  const shared = validateSharedDeck(deck);
  const bytes = payloadBytes(shared);
  let token: string;
  if (typeof CompressionStream === "function") {
    try {
      const compressed = await collectBounded(byteStream(bytes).pipeThrough(new CompressionStream("gzip")), SHARING_LIMITS.decodedBytes + 4096);
      token = `v1.${toBase64Url(compressed)}`;
    } catch {
      // Older Web API implementations may expose the class without gzip support.
      token = `j1.${toBase64Url(bytes)}`;
    }
  } else {
    token = `j1.${toBase64Url(bytes)}`;
  }
  if (token.length > SHARING_LIMITS.token) throw new Error(TOO_LARGE);
  return token;
}

export async function decodeSharedDeck(token: string): Promise<SharedDeck> {
  const { version, encoded } = tokenParts(token);
  const input = fromBase64Url(encoded);
  let bytes: Uint8Array;
  if (version === "v1") {
    if (typeof DecompressionStream !== "function") {
      throw new Error("Браузер не поддерживает сжатые ссылки. Откройте ссылку в современном браузере или попросите файл набора.");
    }
    try {
      bytes = await collectBounded(byteStream(input).pipeThrough(new DecompressionStream("gzip")), SHARING_LIMITS.decodedBytes);
    } catch (error) {
      if (error instanceof Error && error.message === TOO_LARGE) throw error;
      throw new Error(INVALID_LINK);
    }
  } else {
    bytes = input;
  }
  if (bytes.byteLength > SHARING_LIMITS.decodedBytes) throw new Error(TOO_LARGE);
  let value: unknown;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(json);
  } catch {
    throw new Error(INVALID_LINK);
  }
  return validateSharedDeck(value);
}

/** Imports a copy with a new identity and no learning history from its sender. */
export function createSharedDeck(shared: SharedDeck, now = Date.now()): Deck {
  const validated = validateSharedDeck(shared);
  payloadBytes(validated);
  if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) throw new Error("Недопустимая дата создания набора.");
  return {
    id: crypto.randomUUID(),
    title: validated.title,
    cards: validated.cards.map((card) => ({ id: crypto.randomUUID(), ...card })),
    createdAt: now,
    sessions: 0,
    lastScore: 0,
    history: [],
  };
}

/** Stable content identity survives URL compression, card ordering and renaming after import. */
export async function sharedDeckId(shared: SharedDeck): Promise<string> {
  const validated = validateSharedDeck(shared);
  payloadBytes(validated);
  const canonicalText = (value: string) => value.trim().normalize("NFC");
  const pairs = validated.cards.map((card) => [canonicalText(card.front), canonicalText(card.back)]);
  pairs.sort((first, second) => {
    const left = JSON.stringify(first);
    const right = JSON.stringify(second);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const bytes = new TextEncoder().encode(JSON.stringify([canonicalText(validated.title), pairs]));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `shared-${hex}`;
}

export function buildShareUrl(baseUrl: string, token: string): string {
  let base: URL;
  try { base = new URL(baseUrl); }
  catch { throw new Error("Не удалось определить адрес приложения для ссылки."); }
  if ((base.protocol !== "http:" && base.protocol !== "https:") || base.username || base.password) {
    throw new Error("Для ссылки нужен адрес HTTP или HTTPS без имени пользователя и пароля.");
  }
  const { encoded } = tokenParts(token);
  fromBase64Url(encoded);
  const result = new URL("/", base);
  result.hash = `deck=${token}`;
  return result.href;
}
