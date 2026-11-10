/**
 * Codexが`CODEX_MODEL`を受け付けなかったときの判定と日本語の説明（#444）。
 *
 * ポーラー（`codex-analysis-worker.mjs`）がTypeScriptを読めない（VPSのNodeの版に依存させない）ため、
 * 純粋な関数だけをこの`.mjs`に置く。DB・ファイル・環境変数に触れないので、`node --test`から
 * 直接importして検証できる（`src/lib/codex-model-diagnosis.test.ts`）。
 */

/** 指定したモデルをChatGPTアカウントのCodexが受け付けなかったことを表す出力。 */
const MODEL_REJECTED_PATTERNS = [/model is not supported when using Codex/i, /"code"\s*:\s*"model_not_found"/i];

/** 拒否されたモデル名を拾う（`The 'gpt-6-luna' model is not supported ...`）。 */
const REJECTED_MODEL_NAME = /The '([^']{1,80})' model is not supported when using Codex/i;

export function isModelRejected(text) {
  return typeof text === "string" && MODEL_REJECTED_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * 拒否の原因と対処の説明。拒否の出力でなければnull。
 *
 * - `model`: ポーラーが`-m`で渡したモデル（`CODEX_MODEL`）。出力から拾えなければこれを使う
 * - `codexVersion`: `codex --version`の出力。取れなければ「不明」と書く
 * - `retried`: 既定のモデルでやり直すか（やり直したか）。やり直すときだけ、概算金額が単価不明になる注記を添える
 * - `done`: やり直しを終えたあとの記録用の文面にするか（既定は「やり直します」の予告）
 */
export function describeModelRejection({ stderr, model, codexVersion, retried, done = false }) {
  if (!isModelRejected(stderr)) return null;
  const named = REJECTED_MODEL_NAME.exec(stderr)?.[1] ?? (model || null);
  const modelText = named ? `指定モデル「${named}」` : "指定したモデル";
  const version = codexVersion ? codexVersion : "不明";
  const parts = [
    `${modelText}はこのCodex（版: ${version}）では使えません。`,
    "Codex CLIの版が古いか、ChatGPTアカウントでは使えないモデルです。VPSのCodex CLIを更新するか、.envの`CODEX_MODEL`を使えるモデルへ見直してください。",
  ];
  if (retried) {
    parts.push(done ? "既定のモデルでやり直しました。" : "既定のモデルでやり直します。");
    parts.push("この解析は使ったモデルが記録されない（model=null）ため、概算金額は単価不明になります。");
  }
  return parts.join("");
}
