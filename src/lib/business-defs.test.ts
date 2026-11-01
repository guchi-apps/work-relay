import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BUSINESSES, businessKeys, businessLabel, normalizeBusinessKey, parseBusinessParam, zeroCounts } from "./business-defs.ts";

describe("事業区分の定義", () => {
  it("エクステリア・ロッカー・AI関連の3区分が並び順どおりに並ぶ", () => {
    assert.deepEqual(businessKeys(DEFAULT_BUSINESSES), ["EXTERIOR", "LOCKER", "AI"]);
    assert.equal(businessLabel(DEFAULT_BUSINESSES, "AI"), "AI関連");
  });

  it("未知の値は弾く（旧DELIVERYの読み替えは外した）", () => {
    assert.equal(normalizeBusinessKey(DEFAULT_BUSINESSES, "DELIVERY"), null);
    assert.equal(normalizeBusinessKey(DEFAULT_BUSINESSES, "AI"), "AI");
    assert.equal(normalizeBusinessKey(DEFAULT_BUSINESSES, "OTHER"), null);
    assert.equal(normalizeBusinessKey(DEFAULT_BUSINESSES, 1), null);
  });

  it("?business=は小文字キーを受け、旧delivery・未知の値は`all`に丸める", () => {
    assert.equal(parseBusinessParam(DEFAULT_BUSINESSES, "ai"), "ai");
    assert.equal(parseBusinessParam(DEFAULT_BUSINESSES, "delivery"), "all");
    assert.equal(parseBusinessParam(DEFAULT_BUSINESSES, "unknown"), "all");
    assert.equal(parseBusinessParam(DEFAULT_BUSINESSES, undefined), "all");
  });

  it("集計用の初期値を区分ごとに0で作る", () => {
    assert.deepEqual(zeroCounts(DEFAULT_BUSINESSES), { EXTERIOR: 0, LOCKER: 0, AI: 0 });
  });
});
