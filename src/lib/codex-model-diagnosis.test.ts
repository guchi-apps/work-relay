// Codexのモデル未対応エラー → 日本語の原因と対処（#444）。
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeModelRejection, isModelRejected } from "../../scripts/codex-model-diagnosis.mjs";

const LUNA = `The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account.`;
const CODE = `{"error":{"code":"model_not_found"}}`.replace("model_not_found", "model_not_found");

describe("isModelRejected", () => {
  it("英語の拒否文とmodel_not_foundを拒否として判定する", () => {
    assert.equal(isModelRejected(LUNA), true);
    assert.equal(isModelRejected(CODE), true);
  });
  it("別のエラーや文字列以外は拒否としない", () => {
    assert.equal(isModelRejected("401 Unauthorized"), false);
    assert.equal(isModelRejected(null), false);
  });
});

describe("describeModelRejection", () => {
  it("モデル名・版・対処・単価不明の注記を日本語で返す", () => {
    const text = describeModelRejection({ stderr: LUNA, model: "gpt-6-luna", codexVersion: "codex-cli 0.152.0", retried: true });
    assert.ok(text);
    assert.match(text, /指定モデル「gpt-6-luna」/);
    assert.match(text, /版: codex-cli 0\.152\.0/);
    assert.match(text, /CODEX_MODEL/);
    assert.match(text, /やり直します/);
    assert.match(text, /単価不明/);
  });
  it("記録用の文面は過去形になる", () => {
    assert.match(describeModelRejection({ stderr: LUNA, model: "x", codexVersion: null, retried: true, done: true }) ?? "", /やり直しました/);
  });
  it("出力にモデル名が無ければ渡したモデルを使い、版が取れなければ不明と書く", () => {
    const text = describeModelRejection({ stderr: CODE, model: "gpt-x", codexVersion: null, retried: false });
    assert.match(text ?? "", /「gpt-x」/);
    assert.match(text ?? "", /版: 不明/);
    assert.doesNotMatch(text ?? "", /単価不明/);
  });
  it("拒否でなければnull", () => {
    assert.equal(describeModelRejection({ stderr: "boom", model: "x", codexVersion: null, retried: true }), null);
  });
});
