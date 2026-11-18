import assert from "node:assert/strict";
import test from "node:test";
import { pickDisplaySummary } from "./display-summary.ts";

test("解析結果の要約があればそれを使う", () => {
  assert.equal(pickDisplaySummary({ summary: "記事側", analyses: [{ summary: "解析側" }] }), "解析側");
});

test("記事側だけ要約があるときは記事側を使う", () => {
  assert.equal(pickDisplaySummary({ summary: "記事側", analyses: [] }), "記事側");
});

test("記事側が空でも解析結果の要約を使う", () => {
  assert.equal(pickDisplaySummary({ summary: null, analyses: [{ summary: "解析側" }] }), "解析側");
});

test("解析結果の要約が空白だけなら記事側へ戻る", () => {
  assert.equal(pickDisplaySummary({ summary: "記事側", analyses: [{ summary: "  " }] }), "記事側");
});

test("どちらも無ければnull", () => {
  assert.equal(pickDisplaySummary({ summary: null, analyses: [] }), null);
  assert.equal(pickDisplaySummary({ summary: " ", analyses: [] }), null);
});

import { summaryPlaceholder } from "./display-summary.ts";

test("要約が無いとき、解析待ち・実行中は生成中、それ以外は従来の文言を返す", () => {
  assert.equal(summaryPlaceholder("QUEUED"), "要約を生成中です。");
  assert.equal(summaryPlaceholder("RUNNING"), "要約を生成中です。");
  assert.equal(summaryPlaceholder("FAILED"), "要約は登録されていません。");
  assert.equal(summaryPlaceholder(null), "要約は登録されていません。");
});
