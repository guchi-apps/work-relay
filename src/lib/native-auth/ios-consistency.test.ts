import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("iOSアプリ（Swift）とサーバー（TS）で、戻り先スキーム・横取りするパス・同一オリジン判定・エフェメラルが揃っている", () => {
  const script = new URL("../../../ios/scripts/check-consistency.mjs", import.meta.url).pathname;
  // 食い違いがあると終了コード1で落ち、標準エラーに理由が出る
  const output = execFileSync(process.execPath, [script], { encoding: "utf-8" });
  assert.match(output, /OK/);
});
