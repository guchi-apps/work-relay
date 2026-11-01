import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acceptsJson,
  buildNewsMailPickPath,
  buildSharePagePath,
  extractUrl,
  fallbackArticleTitle,
  hasPendingShare,
  isRequestBodyTooLarge,
  normalizeBatchId,
  normalizeSharedText,
  putShareEntry,
  takeShareEntry,
  SHARE_INBOX_MAX_ENTRIES,
  SHARE_INBOX_MAX_FILES,
  SHARE_INBOX_MAX_REQUEST_BYTES,
  SHARE_INBOX_MAX_TOTAL_BYTES,
  SHARE_INBOX_TTL_MS,
  SHARE_TEXT_QUERY_MAX_LENGTH,
  type ShareInboxEntry,
  type SharedFile,
} from "./share-inbox.ts";

const photo = (bytes = 10): SharedFile => ({ name: "a.jpg", type: "image/jpeg", data: new Uint8Array(bytes) });

describe("putShareEntry / takeShareEntry", () => {
  it("置いた写真は一度だけ取り出せる", () => {
    const store = new Map<string, ShareInboxEntry>();
    const put = putShareEntry(store, { title: " 現場 ", files: [photo(), photo()] }, 0, "x");
    assert.deepEqual(put, { ok: true, id: "x", count: 2 });
    const taken = takeShareEntry(store, "x", 1);
    assert.equal(taken?.title, "現場");
    assert.equal(taken?.files.length, 2);
    assert.equal(takeShareEntry(store, "x", 2), null);
  });

  it("idを省くと一番新しいものを取り出す", () => {
    const store = new Map<string, ShareInboxEntry>();
    putShareEntry(store, { title: "古い", files: [photo()] }, 0, "a");
    putShareEntry(store, { title: "新しい", files: [photo()] }, 1, "b");
    assert.equal(takeShareEntry(store, null, 2)?.id, "b");
  });

  it("期限を過ぎたものは取り出せない", () => {
    const store = new Map<string, ShareInboxEntry>();
    putShareEntry(store, { title: "", files: [photo()] }, 0, "a");
    assert.equal(hasPendingShare(store, SHARE_INBOX_TTL_MS), true);
    assert.equal(takeShareEntry(store, "a", SHARE_INBOX_TTL_MS + 1), null);
    assert.equal(store.size, 0);
  });

  it("件数の上限を超えると古いものから捨てる", () => {
    const store = new Map<string, ShareInboxEntry>();
    for (let i = 0; i <= SHARE_INBOX_MAX_ENTRIES; i++) putShareEntry(store, { title: "", files: [photo()] }, i, `e${i}`);
    assert.equal(store.size, SHARE_INBOX_MAX_ENTRIES);
    assert.equal(store.has("e0"), false);
  });

  it("枚数・合計サイズ・画像以外を断る", () => {
    const store = new Map<string, ShareInboxEntry>();
    assert.deepEqual(putShareEntry(store, { title: "", files: [] }, 0), { ok: false, reason: "no_files" });
    assert.deepEqual(putShareEntry(store, { title: "", files: Array.from({ length: SHARE_INBOX_MAX_FILES + 1 }, () => photo()) }, 0), { ok: false, reason: "too_many_files" });
    assert.deepEqual(putShareEntry(store, { title: "", files: [photo(SHARE_INBOX_MAX_TOTAL_BYTES + 1)] }, 0), { ok: false, reason: "too_large" });
    assert.deepEqual(putShareEntry(store, { title: "", files: [{ name: "a.pdf", type: "application/pdf", data: new Uint8Array(1) }] }, 0), { ok: false, reason: "not_image" });
    assert.equal(store.size, 0);
  });
});

describe("putShareEntry / takeShareEntry（冪等キーと所有者。#354）", () => {
  it("同じ利用者・同じキーの再送は最初の共有を返し、写真を足さない", () => {
    const store = new Map<string, ShareInboxEntry>();
    assert.deepEqual(putShareEntry(store, { title: "", files: [photo(), photo()], key: "k1", owner: "a@example.com" }, 0, "x"), { ok: true, id: "x", count: 2 });
    assert.deepEqual(putShareEntry(store, { title: "", files: [photo(), photo()], key: "k1", owner: "a@example.com" }, 1, "y"), { ok: true, id: "x", count: 2 });
    assert.equal(store.size, 1);
    assert.equal(takeShareEntry(store, "x", 2, "a@example.com")?.files.length, 2);
    // 取り出した後に残存entryは無い
    assert.equal(takeShareEntry(store, null, 3, "a@example.com"), null);
    assert.equal(store.size, 0);
  });

  it("別の利用者の同じキーは別の共有になる", () => {
    const store = new Map<string, ShareInboxEntry>();
    putShareEntry(store, { title: "", files: [photo()], key: "k1", owner: "a@example.com" }, 0, "x");
    assert.deepEqual(putShareEntry(store, { title: "", files: [photo()], key: "k1", owner: "b@example.com" }, 1, "y"), { ok: true, id: "y", count: 1 });
    assert.equal(store.size, 2);
  });

  it("他の利用者の共有は取り出せず、消えもしない", () => {
    const store = new Map<string, ShareInboxEntry>();
    putShareEntry(store, { title: "", files: [photo()], owner: "a@example.com" }, 0, "x");
    assert.equal(takeShareEntry(store, "x", 1, "b@example.com"), null);
    assert.equal(takeShareEntry(store, null, 1, "b@example.com"), null);
    assert.equal(store.size, 1);
    assert.equal(takeShareEntry(store, null, 2, "a@example.com")?.id, "x");
  });

  it("所有者のない共有（ショートカット）はログイン中の誰でも取り出せる", () => {
    const store = new Map<string, ShareInboxEntry>();
    putShareEntry(store, { title: "", files: [photo()] }, 0, "x");
    assert.equal(takeShareEntry(store, "x", 1, "b@example.com")?.id, "x");
  });
});

describe("putShareEntry（batchでまとめる。#163）", () => {
  it("同じbatchの写真は1つの置き場へ追記し、合計の枚数を返す", () => {
    const store = new Map<string, ShareInboxEntry>();
    assert.deepEqual(putShareEntry(store, { title: "", files: [photo()], batch: "b1" }, 0, "x"), { ok: true, id: "x", count: 1 });
    assert.deepEqual(putShareEntry(store, { title: "現場", files: [photo()], batch: "b1" }, 1, "y"), { ok: true, id: "x", count: 2 });
    assert.equal(store.size, 1);
    const taken = takeShareEntry(store, "x", 2);
    assert.equal(taken?.files.length, 2);
    assert.equal(taken?.title, "現場");
  });

  it("タイトルは最初に入っていたものを優先する", () => {
    const store = new Map<string, ShareInboxEntry>();
    putShareEntry(store, { title: "最初", files: [photo()], batch: "b1" }, 0, "x");
    putShareEntry(store, { title: "後から", files: [photo()], batch: "b1" }, 1, "y");
    assert.equal(takeShareEntry(store, "x", 2)?.title, "最初");
  });

  it("batchが違う、またはbatchが無い写真は別の置き場になる", () => {
    const store = new Map<string, ShareInboxEntry>();
    putShareEntry(store, { title: "", files: [photo()], batch: "b1" }, 0, "a");
    putShareEntry(store, { title: "", files: [photo()], batch: "b2" }, 1, "b");
    putShareEntry(store, { title: "", files: [photo()] }, 2, "c");
    putShareEntry(store, { title: "", files: [photo()] }, 3, "d");
    assert.equal(store.size, SHARE_INBOX_MAX_ENTRIES);
    assert.equal(store.has("a"), false);
  });

  it("追記で置き場が上限に達していても、同じbatchなら古いものを捨てずに追記する", () => {
    const store = new Map<string, ShareInboxEntry>();
    for (let i = 0; i < SHARE_INBOX_MAX_ENTRIES; i++) putShareEntry(store, { title: "", files: [photo()], batch: `b${i}` }, i, `e${i}`);
    putShareEntry(store, { title: "", files: [photo()], batch: "b0" }, 10, "z");
    assert.equal(store.size, SHARE_INBOX_MAX_ENTRIES);
    assert.equal(store.get("e0")?.files.length, 2);
  });

  it("枚数・合計サイズの上限はまとめた単位で守り、超える追記は断ってそれまでの写真は残す", () => {
    const store = new Map<string, ShareInboxEntry>();
    putShareEntry(store, { title: "", files: Array.from({ length: SHARE_INBOX_MAX_FILES }, () => photo()), batch: "b1" }, 0, "x");
    assert.deepEqual(putShareEntry(store, { title: "", files: [photo()], batch: "b1" }, 1), { ok: false, reason: "too_many_files" });
    assert.equal(store.get("x")?.files.length, SHARE_INBOX_MAX_FILES);

    const large = new Map<string, ShareInboxEntry>();
    putShareEntry(large, { title: "", files: [photo(SHARE_INBOX_MAX_TOTAL_BYTES)], batch: "b1" }, 0, "y");
    assert.deepEqual(putShareEntry(large, { title: "", files: [photo(1)], batch: "b1" }, 1), { ok: false, reason: "too_large" });
    assert.equal(large.get("y")?.files.length, 1);
  });

  it("有効期限は最初の1枚を置いた時点から数える", () => {
    const store = new Map<string, ShareInboxEntry>();
    putShareEntry(store, { title: "", files: [photo()], batch: "b1" }, 0, "x");
    putShareEntry(store, { title: "", files: [photo()], batch: "b1" }, SHARE_INBOX_TTL_MS - 1, "y");
    assert.equal(takeShareEntry(store, "x", SHARE_INBOX_TTL_MS + 1), null);
  });
});

describe("isRequestBodyTooLarge（#172）", () => {
  it("上限（写真の合計＋フォームの余白）を超えるContent-Lengthは断る", () => {
    assert.equal(isRequestBodyTooLarge(String(SHARE_INBOX_MAX_REQUEST_BYTES + 1)), true);
  });

  it("上限ちょうどまでと、写真の合計上限ちょうどの共有は通す", () => {
    assert.equal(isRequestBodyTooLarge(String(SHARE_INBOX_MAX_REQUEST_BYTES)), false);
    assert.equal(isRequestBodyTooLarge(String(SHARE_INBOX_MAX_TOTAL_BYTES)), false);
    assert.ok(SHARE_INBOX_MAX_REQUEST_BYTES > SHARE_INBOX_MAX_TOTAL_BYTES);
  });

  it("ヘッダーが無い・数値でないときは判定できないので通す", () => {
    assert.equal(isRequestBodyTooLarge(null), false);
    assert.equal(isRequestBodyTooLarge(undefined), false);
    assert.equal(isRequestBodyTooLarge(""), false);
    assert.equal(isRequestBodyTooLarge("abc"), false);
    assert.equal(isRequestBodyTooLarge("-1"), false);
  });
});

describe("normalizeBatchId", () => {
  it("空ならnull、使える文字ならそのまま返す", () => {
    assert.equal(normalizeBatchId(null), null);
    assert.equal(normalizeBatchId("  "), null);
    assert.equal(normalizeBatchId(" 2026-09-19T10:30:15 "), "2026-09-19T10:30:15");
  });

  it("使えない文字や長すぎる値はinvalid", () => {
    assert.equal(normalizeBatchId("a b"), "invalid");
    assert.equal(normalizeBatchId("あ"), "invalid");
    assert.equal(normalizeBatchId("a".repeat(65)), "invalid");
  });
});

describe("normalizeSharedText", () => {
  it("urlが空なら文章からURLを拾い、文章からは取り除く", () => {
    assert.deepEqual(normalizeSharedText({ title: "", text: "駅ナカにロッカー増設 https://example.com/news/1?utm_source=x", url: "" }), {
      title: "",
      text: "駅ナカにロッカー増設",
      url: "https://example.com/news/1?utm_source=x",
    });
  });

  it("urlと文章が同じなら文章は空にする", () => {
    assert.deepEqual(normalizeSharedText({ title: "記事", text: "https://example.com/a", url: "https://example.com/a" }), { title: "記事", text: "", url: "https://example.com/a" });
  });

  it("http(s)以外のURLは記事として扱わない", () => {
    assert.equal(normalizeSharedText({ url: "javascript:alert(1)" }).url, null);
    assert.equal(extractUrl("メモだけ"), null);
  });

  it("URLの末尾の句読点は含めない", () => {
    assert.equal(extractUrl("こちら https://example.com/a。"), "https://example.com/a");
  });

  it("ショートカット「ワークリレーへ記事」はURLでない入力も`url=`へ載せて開くため、文章として拾う（#149）", () => {
    assert.deepEqual(normalizeSharedText({ url: "明日の会議は10時からです" }), { title: "", text: "明日の会議は10時からです", url: null });
  });

  it("`url=`に載った文章の中にURLがあれば記事として扱う（#149）", () => {
    assert.deepEqual(normalizeSharedText({ url: "この記事みて https://example.com/a" }), { title: "", text: "この記事みて", url: "https://example.com/a" });
  });

  it("urlもtextも無ければ何も拾わない", () => {
    assert.deepEqual(normalizeSharedText({}), { title: "", text: "", url: null });
  });
});

describe("buildSharePagePath / fallbackArticleTitle", () => {
  it("共有された内容をクエリにする", () => {
    assert.equal(buildSharePagePath({ title: "記事", text: "", url: "https://example.com/a" }), "/dashboard/share?url=https%3A%2F%2Fexample.com%2Fa&title=%E8%A8%98%E4%BA%8B");
    assert.equal(buildSharePagePath({ title: "", text: "", url: null }), "/dashboard/share");
  });

  it("文章がSHARE_TEXT_QUERY_MAX_LENGTHを超える場合は切り詰める", () => {
    const long = "あ".repeat(SHARE_TEXT_QUERY_MAX_LENGTH + 50);
    const path = buildSharePagePath({ title: "", text: long, url: null });
    const params = new URLSearchParams(path.split("?")[1]);
    assert.equal(params.get("text")?.length, SHARE_TEXT_QUERY_MAX_LENGTH);
  });

  it("タイトルが無ければ文章の1行目、それも無ければホスト名を使う", () => {
    assert.equal(fallbackArticleTitle({ title: "", text: "一行目\n二行目", url: "https://example.com/a" }), "一行目");
    assert.equal(fallbackArticleTitle({ title: "", text: "", url: "https://www.example.com/a" }), "www.example.com");
  });
});

describe("buildNewsMailPickPath", () => {
  const now = new Date("2026-09-17T03:00:00Z"); // JSTの木曜
  it("記事の日付が入っている週を開く", () => {
    assert.equal(buildNewsMailPickPath("a1", new Date("2026-09-16T00:00:00Z"), now), "/dashboard/news-mail?week=0&basis=either&triage=all&pick=a1");
    assert.equal(buildNewsMailPickPath("a1", new Date("2026-09-08T00:00:00Z"), now), "/dashboard/news-mail?week=-1&basis=either&triage=all&pick=a1");
  });
  it("遡れる範囲より古ければ今週にする", () => {
    assert.match(buildNewsMailPickPath("a1", new Date("2025-01-01T00:00:00Z"), now), /week=0&/);
  });
});

describe("acceptsJson（#318）", () => {
  it("JSONを求めるAcceptだけtrue", () => {
    assert.equal(acceptsJson("application/json"), true);
    assert.equal(acceptsJson("text/html, Application/JSON; q=0.9"), true);
  });
  it("ブラウザのフォーム送信や未指定はfalse（従来のリダイレクトを保つ）", () => {
    assert.equal(acceptsJson("text/html,application/xhtml+xml,*/*;q=0.8"), false);
    assert.equal(acceptsJson("*/*"), false);
    assert.equal(acceptsJson(null), false);
    assert.equal(acceptsJson("application/jsonx"), false);
  });
});
