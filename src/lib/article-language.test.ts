import assert from "node:assert/strict";
import { test } from "node:test";
import { containsJapanese, isForeignLanguageTitle, isSummaryUntranslated } from "./article-language.ts";

test("日本語（ひらがな・カタカナ・漢字）を含むと判定する", () => {
  assert.equal(containsJapanese("宅配ボックス"), true);
  assert.equal(containsJapanese("ロッカー"), true);
  assert.equal(containsJapanese("Smart ポスト"), true);
  assert.equal(containsJapanese("Parcel locker market grows 12%"), false);
  assert.equal(containsJapanese(null), false);
});

test("題名が外国語かどうか", () => {
  assert.equal(isForeignLanguageTitle("Amazon expands parcel lockers in the UK"), true);
  assert.equal(isForeignLanguageTitle("Amazon、英国で宅配ロッカーを拡大"), false);
  assert.equal(isForeignLanguageTitle("  "), false);
});

test("要約が英語のままかどうか", () => {
  assert.equal(isSummaryUntranslated("Amazon expands its locker network."), true);
  assert.equal(isSummaryUntranslated("英国で宅配ロッカーを拡大する記事。"), false);
  assert.equal(isSummaryUntranslated(null), false);
  assert.equal(isSummaryUntranslated(""), false);
});
