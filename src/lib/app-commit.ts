/**
 * 稼働しているコミットの SHA（#302）。`deploy.yml` が `.env` へ書く `APP_COMMIT_SHA` を読む。
 *
 * `/api/app-version` がこの値を返し、デプロイのヘルスチェックは今回デプロイしたコミットと
 * 一致するまで成功にしない（旧版が HTTP 200 を返しているだけの状態を成功と見なさないため）。
 * issue-deck のリリース完了判定も同じ値で稼働中の版を照合する。
 * 未設定・空白だけ（ローカル開発など）は null。
 *
 * Prismaをimportしないモジュールに置き、`node --test` から読めるようにしている。
 */
export function readAppCommitSha(env: Record<string, string | undefined>): string | null {
  const value = env.APP_COMMIT_SHA?.trim();
  return value ? value : null;
}
