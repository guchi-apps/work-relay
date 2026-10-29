#!/usr/bin/env node
// サーバー（TypeScript）とiOSアプリ（Swift）で揃えておく値・判定が食い違っていないかを照合する。
// Xcodeの無い環境（subpc・CI）でも動く。`pnpm test` の `src/lib/native-auth/ios-consistency.test.ts`
// が同じ関数を使う。単独でも `node ios/scripts/check-consistency.mjs` で実行できる。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(root, path), "utf-8");

/** 問題の一覧を返す（空なら整合している）。 */
export function checkConsistency() {
  const problems = [];
  const appConfig = read("ios/WorkRelay/AppConfig.swift");
  const nativeApp = read("src/lib/native-auth/native-app.ts");
  const webViewModel = read("ios/WorkRelay/WebViewModel.swift");
  const nativeAuth = read("ios/WorkRelay/NativeAuth.swift");
  const pbxproj = read("ios/WorkRelay.xcodeproj/project.pbxproj");

  const swiftScheme = appConfig.match(/authCallbackScheme = "([^"]+)"/)?.[1];
  const tsScheme = nativeApp.match(/NATIVE_SCHEME = "([^"]+)"/)?.[1];
  if (!swiftScheme || swiftScheme !== tsScheme) {
    problems.push(`戻り先スキームが一致しません: Swift=${swiftScheme} / TS=${tsScheme}`);
  }

  // 戻り先のホスト（auth-callback / google-connected）
  for (const host of ["auth-callback"]) {
    if (!nativeApp.includes(`://${host}`)) problems.push(`native-app.ts に ${host} がありません`);
    if (!webViewModel.includes(`"${host}"`)) problems.push(`WebViewModel.swift に ${host} がありません`);
  }

  // 横取りするパスは、Web側の入口と同じ
  for (const path of ["/auth/signin"]) {
    if (!appConfig.includes(`"${path}"`)) problems.push(`AppConfig.swift が ${path} を横取りしていません`);
  }
  // 引き継ぎの経路
  for (const path of ["auth/native/start", "/auth/native/consume"]) {
    if (!webViewModel.includes(path)) problems.push(`WebViewModel.swift が ${path} を使っていません`);
  }

  // 同一オリジン判定は、スキーム・ホスト・ポートまで見る（ワークリレー外はWebViewへ読み込まない）
  if (!/url\.scheme == baseURL\.scheme && url\.host == baseURL\.host && url\.port == baseURL\.port/.test(appConfig)) {
    problems.push("AppConfig.isAppURL がスキーム・ホスト・ポートの一致を見ていません");
  }
  if (!/openExternally\(url\)\s*\n\s*return \.cancel/.test(webViewModel)) {
    problems.push("WebViewModel.swift が外部URLをSafariで開いて .cancel していません");
  }

  // 認証シートは毎回エフェメラル（Safariの既存セッションに触れない）
  if (!nativeAuth.includes("prefersEphemeralWebBrowserSession = true")) {
    problems.push("認証シートがエフェメラルではありません");
  }

  // Bundle ID・表示名
  if (!pbxproj.includes("PRODUCT_BUNDLE_IDENTIFIER = com.gucchii.workrelay;")) problems.push("Bundle ID が com.gucchii.workrelay ではありません");
  if (!pbxproj.includes('INFOPLIST_KEY_CFBundleDisplayName = "ワークリレー";')) problems.push("表示名が ワークリレー ではありません");

  // 版番号（MARKETING_VERSION）が package.json の version と揃っている（sync-version.mjs で揃える）。
  // リリースのバンプPRで version が先に動くため、CI（pnpm test）では見ず、配布スクリプトだけが見る
  const { version } = JSON.parse(read("package.json"));
  for (const m of process.env.IOS_CHECK_VERSION === "1" ? pbxproj.matchAll(/MARKETING_VERSION = ([^;]+);/g) : []) {
    if (m[1] !== version) problems.push(`MARKETING_VERSION(${m[1]}) が package.json の version(${version}) と違います。node ios/scripts/sync-version.mjs を実行してください`);
  }

  // 開発用のURLをコミットしていない
  if (!/baseURL = URL\(string: "https:\/\/research-desk\.gucchii\.com\/"\)!/.test(appConfig)) {
    problems.push("AppConfig.baseURL が本番URLではありません（開発用のまま？）");
  }

  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkConsistency();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✖ ${problem}`);
    process.exit(1);
  }
  console.log("iOSアプリとサーバーの整合: OK");
}
