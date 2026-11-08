import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTokenUsage, summarizeFeature, tokenColumns, UNKNOWN_MODEL } from "./ai-usage.ts";

const now = new Date("2026-09-25T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);

test("記録が無ければ空配列", () => {
  assert.deepEqual(summarizeFeature("記事のAI解析", [], now), []);
});

test("24時間・7日間をモデル別に数え、7日より古い記録は除く", () => {
  const rows = summarizeFeature(
    "記事のAI解析",
    [
      { model: "gpt-5", at: hoursAgo(1) },
      { model: "gpt-5", at: hoursAgo(30) },
      { model: "gpt-5", at: hoursAgo(24 * 8) },
      { model: "gpt-5-mini", at: hoursAgo(2) },
    ],
    now,
  );
  assert.deepEqual(rows, [
    { label: "記事のAI解析", model: "gpt-5", last24h: { calls: 1 }, last7d: { calls: 2 } },
    { label: "記事のAI解析", model: "gpt-5-mini", last24h: { calls: 1 }, last7d: { calls: 1 } },
  ]);
});

test("modelがnull・空文字の行は固定IDに合算する", () => {
  const rows = summarizeFeature("週の総括", [{ model: null, at: hoursAgo(1) }, { model: " ", at: hoursAgo(50) }], now);
  assert.deepEqual(rows, [{ label: "週の総括", model: UNKNOWN_MODEL, last24h: { calls: 1 }, last7d: { calls: 2 } }]);
});

const tk = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, cacheReadTokens: 10, cacheWriteTokens: 0 });

test("全記録にトークンがあれば期間ごとに合算して返す", () => {
  const rows = summarizeFeature("記事のAI解析", [{ model: "gpt-6-luna", at: hoursAgo(1), tokens: tk(100, 5) }, { model: "gpt-6-luna", at: hoursAgo(30), tokens: tk(200, 7) }], now);
  assert.deepEqual(rows[0].last24h, { calls: 1, inputTokens: 100, outputTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 0 });
  assert.deepEqual(rows[0].last7d, { calls: 2, inputTokens: 300, outputTokens: 12, cacheReadTokens: 20, cacheWriteTokens: 0 });
});

test("トークンの無い記録が混じる期間は、少なく見せないよう数値を省く", () => {
  const rows = summarizeFeature("記事のAI解析", [{ model: "m", at: hoursAgo(1), tokens: tk(100, 5) }, { model: "m", at: hoursAgo(30), tokens: null }], now);
  assert.deepEqual(rows[0].last24h, { calls: 1, inputTokens: 100, outputTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 0 });
  assert.deepEqual(rows[0].last7d, { calls: 2 });
});

test("parseTokenUsageは4項目すべてが負でない整数のときだけ受け入れる", () => {
  assert.deepEqual(parseTokenUsage(tk(1, 2)), tk(1, 2));
  assert.equal(parseTokenUsage({ inputTokens: 1 }), null);
  assert.equal(parseTokenUsage({ ...tk(1, 2), outputTokens: -1 }), null);
  assert.equal(parseTokenUsage(null), null);
  assert.deepEqual(tokenColumns(null), { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null });
});
