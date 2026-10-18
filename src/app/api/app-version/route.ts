import { NextResponse } from "next/server";

import { readAppCommitSha } from "@/lib/app-commit";

import packageJson from "../../../../package.json";

// PWAとしてホーム画面に追加した状態でも再インストールなしに新バージョンへ
// 追従できるよう、クライアント（AppUpdateChecker）がこのエンドポイントを
// ポーリングしてデプロイ済みのバージョンと比較する。CDN/ブラウザにキャッシュ
// されると新バージョンを検知できなくなるため常に無効化する。
//
// `sha` は稼働しているコミット（#302）。`deploy.yml` のヘルスチェックが今回デプロイした
// `APP_COMMIT_SHA` と一致するまで成功にしない。AppUpdateChecker は `version` しか読まない。
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { version: packageJson.version, sha: readAppCommitSha(process.env) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
