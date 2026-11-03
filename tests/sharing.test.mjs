import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { validateDecks } from "../app/lib/library.ts";
import {
  SHARING_LIMITS,
  buildShareUrl,
  createSharedDeck,
  decodeSharedDeck,
  encodeSharedDeck,
  sharedDeckId,
} from "../app/lib/sharing.ts";

function shared(overrides = {}) {
  return {
    title: "Слова в дороге ✈️",
    cards: [
      { front: "journey", back: "путешествие" },
      { front: "luggage", back: "багаж" },
    ],
    ...overrides,
  };
}

function rawToken(value) {
  return `j1.${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}

function gzipToken(text) {
  return `v1.${gzipSync(Buffer.from(text)).toString("base64url")}`;
}

async function withGlobal(name, value, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  try { return await callback(); }
  finally {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
}

test("gzip links preserve Unicode, punctuation and original card order", async () => {
  const original = shared({
    title: "Словарь — 日本語 / العربية 🧑🏽‍🚀",
    cards: [
      { front: "こんにちは", back: "Здравствуйте 👋" },
      { front: "مَرْحَبًا", back: 'Привет! "Да" — нет\nСледующая строка' },
      { front: "cafe\u0301", back: "кофе ☕" },
    ],
  });
  const token = await encodeSharedDeck(original);
  assert.ok(token.startsWith("v1."));
  assert.ok(token.length <= SHARING_LIMITS.token);
  assert.deepEqual(await decodeSharedDeck(token), original);
});

test("sharing excludes teacher IDs, mistakes, review schedule and history", async () => {
  const original = {
    ...shared(), id: "teacher-deck", createdAt: 10, sessions: 50, lastScore: 95,
    cards: shared().cards.map((card, index) => ({ ...card, id: `teacher-card-${index}` })),
    mistakes: { "teacher-card-0": 5 },
    review: { "teacher-card-0": { dueAt: 456, intervalDays: 2, streak: 1, reviewedAt: 123 } },
    history: [{ at: 123, correct: 2, total: 2 }],
  };
  const decoded = await decodeSharedDeck(await encodeSharedDeck(original));
  assert.deepEqual(decoded, shared());
  assert.deepEqual(Object.keys(decoded).sort(), ["cards", "title"]);
  for (const card of decoded.cards) assert.deepEqual(Object.keys(card).sort(), ["back", "front"]);
  // Directly supplied extra fields cannot sneak progress through the import API.
  const imported = createSharedDeck(original, 999);
  assert.equal(imported.sessions, 0);
  assert.equal(imported.lastScore, 0);
  assert.deepEqual(imported.history, []);
  assert.equal(imported.review, undefined);
  assert.equal(imported.mistakes, undefined);
  assert.equal(imported.createdAt, 999);
  assert.notEqual(imported.id, original.id);
  assert.notEqual(imported.cards[0].id, original.cards[0].id);
});

test("uncompressed links work without compression or decompression Web APIs", async () => {
  await withGlobal("CompressionStream", undefined, async () => {
    await withGlobal("DecompressionStream", undefined, async () => {
      const token = await encodeSharedDeck(shared());
      assert.ok(token.startsWith("j1."));
      assert.deepEqual(await decodeSharedDeck(token), shared());
    });
  });
});

test("partial gzip implementations fall back to an interoperable raw token", async () => {
  await withGlobal("CompressionStream", class UnsupportedCompression {
    constructor() { throw new Error("Unsupported format"); }
  }, async () => {
    const token = await encodeSharedDeck(shared());
    assert.ok(token.startsWith("j1."));
    assert.deepEqual(await decodeSharedDeck(token), shared());
  });
});

test("an unsupported decoder reports how to open a compressed link", async () => {
  const token = gzipToken(JSON.stringify(shared()));
  await withGlobal("DecompressionStream", undefined, async () => {
    await assert.rejects(decodeSharedDeck(token), /современном браузере|файл/);
  });
});

test("malformed base64, unknown versions and non-canonical padding bits are rejected", async () => {
  const invalid = ["", "v1", "v1.", "v2.YQ", "j2.YQ", "j1.A", "j1.YQ==", "j1.Y Q", "j1.a+b/", "j1.YQ?", "j1.YQ.more"];
  for (const token of invalid) await assert.rejects(decodeSharedDeck(token));
  let json = JSON.stringify(shared());
  if (Buffer.byteLength(json) % 3 === 0) json += " ";
  const encoded = Buffer.from(json).toString("base64url");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const alias = encoded.slice(0, -1) + alphabet[alphabet.indexOf(encoded.at(-1)) + 1];
  assert.deepEqual(Buffer.from(alias, "base64url"), Buffer.from(encoded, "base64url"));
  assert.deepEqual(await decodeSharedDeck(`j1.${encoded}`), shared());
  await assert.rejects(decodeSharedDeck(`j1.${alias}`));
});

test("truncated, corrupted gzip and malformed UTF-8 do not produce partial decks", async () => {
  const compressed = gzipSync(Buffer.from(JSON.stringify(shared())));
  await assert.rejects(decodeSharedDeck(`v1.${compressed.subarray(0, -3).toString("base64url")}`));
  const corrupted = Buffer.from(compressed);
  corrupted[corrupted.length - 5] ^= 255;
  await assert.rejects(decodeSharedDeck(`v1.${corrupted.toString("base64url")}`));
  await assert.rejects(decodeSharedDeck("v1.YWJjZA"));
  await assert.rejects(decodeSharedDeck("j1._w"));
  await assert.rejects(decodeSharedDeck(rawToken(null)));
  await assert.rejects(decodeSharedDeck(`j1.${Buffer.from("{broken").toString("base64url")}`));
});

test("decompression stops at its byte limit even for a tiny valid-JSON gzip bomb", async () => {
  const inflated = JSON.stringify(shared()) + " ".repeat(SHARING_LIMITS.decodedBytes);
  const token = gzipToken(inflated);
  assert.ok(token.length < SHARING_LIMITS.token);
  await assert.rejects(decodeSharedDeck(token), /слишком большой/);
});

test("encoding enforces decoded byte limits before compressing repetitive Unicode", async () => {
  const tooLarge = shared({ cards: Array.from({ length: 200 }, (_, index) => ({
    front: `${index}${"я".repeat(1800)}`, back: "翻訳".repeat(900),
  })) });
  await assert.rejects(encodeSharedDeck(tooLarge), /слишком большой/);
  assert.throws(() => createSharedDeck(tooLarge), /слишком большой/);
});

test("long incompressible links and oversized input tokens are rejected", async () => {
  let seed = 0x12345678;
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  function noise(length) {
    let result = "";
    for (let index = 0; index < length; index += 1) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      result += characters[(seed >>> 0) % characters.length];
    }
    return result;
  }
  const largeLink = shared({ cards: Array.from({ length: 50 }, () => ({ front: noise(1000), back: noise(1000) })) });
  await assert.rejects(encodeSharedDeck(largeLink), /слишком большой/);
  await assert.rejects(decodeSharedDeck(`j1.${"A".repeat(SHARING_LIMITS.token)}`), /слишком большой/);
  await withGlobal("CompressionStream", undefined, async () => {
    const rawTooLong = shared({ cards: [{ front: "a".repeat(2000), back: "b".repeat(2000) },
      ...Array.from({ length: 5 }, (_, index) => ({ front: `${index}${"a".repeat(1999)}`, back: "b".repeat(2000) }))] });
    await assert.rejects(encodeSharedDeck(rawTooLong), /слишком большой/);
  });
});

test("schema validation rejects empty content, duplicate pairs and exceeded limits", async () => {
  const invalid = [
    shared({ title: " " }), shared({ title: "a".repeat(SHARING_LIMITS.title + 1) }),
    shared({ cards: [] }), shared({ cards: [null] }),
    shared({ cards: [{ front: " ", back: "meaning" }] }),
    shared({ cards: [{ front: "word", back: 123 }] }),
    shared({ cards: [{ front: "word", back: "a".repeat(SHARING_LIMITS.side + 1) }] }),
    shared({ cards: Array.from({ length: SHARING_LIMITS.cards + 1 }, (_, index) => ({ front: `word-${index}`, back: "слово" })) }),
    shared({ cards: [{ front: "café", back: "кофе" }, { front: " CAFE\u0301 ", back: "кофе" }] }),
  ];
  for (const value of invalid) {
    await assert.rejects(encodeSharedDeck(value));
    await assert.rejects(decodeSharedDeck(rawToken(value)));
    assert.throws(() => createSharedDeck(value));
  }
});

test("allowed title, side and card-count boundaries remain shareable", async () => {
  const longText = shared({ title: "a".repeat(SHARING_LIMITS.title), cards: [{
    front: "a".repeat(SHARING_LIMITS.side), back: "б".repeat(SHARING_LIMITS.side),
  }] });
  assert.deepEqual(await decodeSharedDeck(await encodeSharedDeck(longText)), longText);
  const manyCards = shared({ cards: Array.from({ length: SHARING_LIMITS.cards }, (_, index) => ({ front: `word-${index}`, back: "слово" })) });
  assert.deepEqual(await decodeSharedDeck(await encodeSharedDeck(manyCards)), manyCards);
});

test("each imported copy gets fresh deck and card identities with valid empty progress", () => {
  const first = createSharedDeck(shared(), 123);
  const second = createSharedDeck(shared(), 456);
  const ids = [first.id, second.id, ...first.cards.map((card) => card.id), ...second.cards.map((card) => card.id)];
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(validateDecks([first, second]), [first, second]);
  for (const now of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 8640000000000001]) {
    assert.throws(() => createSharedDeck(shared(), now));
  }
});

test("share URLs use the origin root and strip unrelated paths, queries and fragments", async () => {
  const token = await encodeSharedDeck(shared());
  const url = new URL(buildShareUrl("https://example.test/folder/page?secret=discard#old", token));
  assert.equal(url.origin, "https://example.test");
  assert.equal(url.pathname, "/");
  assert.equal(url.search, "");
  assert.equal(url.hash, `#deck=${token}`);
  assert.equal(buildShareUrl("http://localhost:3000/test?x=1", token), `http://localhost:3000/#deck=${token}`);
});

test("unsafe base URLs, credentials and invalid token syntax cannot create links", () => {
  const token = rawToken(shared());
  for (const base of ["/relative", "not a URL", "javascript:alert(1)", "data:text/plain,x", "file:///tmp/site", "ftp://example.test", "https://user:pass@example.test/", "https://user@example.test/"]) {
    assert.throws(() => buildShareUrl(base, token));
  }
  for (const invalid of ["j1.A", "v2.YQ", "j1.YQ#other", "j1.YQ="]) {
    assert.throws(() => buildShareUrl("https://example.test", invalid));
  }
});

test("shared identity is stable across card ordering, surrounding spaces and NFC Unicode", async () => {
  const first = shared({ title: " Café ", cards: [{ front: " résumé ", back: " резюме " }, { front: "猫", back: "кошка" }] });
  const reordered = shared({ title: "Cafe\u0301", cards: [{ front: "猫", back: "кошка" }, { front: "re\u0301sume\u0301", back: "резюме" }] });
  const id = await sharedDeckId(first);
  assert.match(id, /^shared-[0-9a-f]{64}$/);
  assert.equal(await sharedDeckId(reordered), id);
});

test("shared identity distinguishes case, compatibility symbols and changed translations", async () => {
  const original = shared({ title: "Words", cards: [{ front: "A", back: "значение" }] });
  const id = await sharedDeckId(original);
  for (const changed of [
    { ...original, title: "words" },
    { ...original, cards: [{ front: "a", back: "значение" }] },
    { ...original, cards: [{ front: "Ａ", back: "значение" }] },
    { ...original, cards: [{ front: "A", back: "другое значение" }] },
  ]) assert.notEqual(await sharedDeckId(changed), id);
});

test("raw and compressed links yield the same identity without source progress", async () => {
  const original = shared();
  const raw = await decodeSharedDeck(rawToken(original));
  const compressed = await decodeSharedDeck(await encodeSharedDeck({ ...original, sessions: 99, lastScore: 100 }));
  assert.equal(await sharedDeckId(raw), await sharedDeckId(compressed));
});
