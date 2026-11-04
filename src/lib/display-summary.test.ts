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
