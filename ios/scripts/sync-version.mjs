#!/usr/bin/env node
// XcodeプロジェクトのMARKETING_VERSIONを package.json の version に合わせる（#920）。
// package.json の `version` lifecycleスクリプトから呼ばれ、リリースのバンプPR
// （release-develop-to-main.yml）で package.json と一緒に pbxproj も更新される（#338。IssueDeckと同じ方式）。
// 共有ワークフローは依存をインストールしないため、Node標準モジュールだけで書くこと。
// 手で揃えたいときも実行できる。冪等で、リポジトリルート・ios/ のどちらからでも動く。
//
//   node ios/scripts/sync-version.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const IOS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = dirname(IOS_DIR);
const PACKAGE_JSON_PATH = join(ROOT, "package.json");
const PBXPROJ_PATH = join(
  IOS_DIR,
  "WorkRelay.xcodeproj",
  "project.pbxproj"
);

function main() {
  const { version } = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
  if (!version) {
    throw new Error(`version not found in ${PACKAGE_JSON_PATH}`);
  }

  const original = readFileSync(PBXPROJ_PATH, "utf8");
  const pattern = /MARKETING_VERSION = [^;]+;/g;
  const matches = original.match(pattern) ?? [];
  if (matches.length === 0) {
    throw new Error(`MARKETING_VERSION not found in ${PBXPROJ_PATH}`);
  }

  const updated = original.replace(pattern, `MARKETING_VERSION = ${version};`);
  if (updated === original) {
    console.log(`MARKETING_VERSION is already ${version}; skipping.`);
    return;
  }

  writeFileSync(PBXPROJ_PATH, updated, "utf8");
  console.log(
    `Updated MARKETING_VERSION to ${version} (${matches.length} occurrence(s)).`
  );
}

main();
