import assert from "node:assert/strict";
import { test } from "node:test";
import { isForeignLanguageTitle, isMostlyJapanese, isSummaryUntranslated, japaneseRatio } from "./article-language.ts";

test("日本語の割合で判定する", () => {
  assert.equal(isMostlyJapanese("宅配ボックス"), true);
  assert.equal(isMostlyJapanese("Amazon、英国で宅配ロッカーを拡大"), true);
  assert.equal(isMostlyJapanese("Parcel locker market grows 12%"), false);
  assert.equal(isMostlyJapanese(null), false);
  assert.equal(japaneseRatio("1234 !!"), 0);
});

test("英語本文に日本語が1語混じるだけでは日本語とみなさない", () => {
  const mixed = "Yamato Transport expands its parcel locker network across the city with ヤマト";
  assert.equal(isMostlyJapanese(mixed), false);
  assert.equal(isSummaryUntranslated(mixed), true);
});

test("題名が外国語かどうか", () => {
  assert.equal(isForeignLanguageTitle("Amazon expands parcel lockers in the UK"), true);
  assert.equal(isForeignLanguageTitle("Amazon、英国で宅配ロッカーを拡大"), false);
  assert.equal(isForeignLanguageTitle("  "), false);
  assert.equal(isForeignLanguageTitle("2026"), false);
});

test("要約が英語のままかどうか", () => {
  assert.equal(isSummaryUntranslated("Amazon expands its locker network."), true);
  assert.equal(isSummaryUntranslated("英国で宅配ロッカーを拡大する記事。Amazonが発表した。"), false);
  assert.equal(isSummaryUntranslated(null), false);
  assert.equal(isSummaryUntranslated(""), false);
});
