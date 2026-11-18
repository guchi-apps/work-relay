import { parseTriageParam, type TriageParam, type TriageState } from "./triage.ts";

/**
 * 記事詳細画面の「戻る」リンクと、開いた時の自動解析の可否（#467）。
 *
 * 業界ニュースのタイムライン（`/dashboard`。#476で新着記事画面を統合）から開いたときだけ
 * `?from=inbox`（と開いていた仕分けタブの`&triage=`）が付く。値の`inbox`は統合前の
 * 新着記事画面（`/dashboard/inbox`）の名残で、既に開かれているURLを壊さないためそのまま使う。
 * 許可した値以外は無視し、任意のパスへ飛ばさない。DB・Prismaに触れないので`node --test`で直接読める。
 */
export type ArticleOrigin = "inbox";

export const INBOX_ORIGIN_PARAM = "inbox";

export function parseArticleOrigin(value: string | string[] | undefined): ArticleOrigin | null {
  return value === INBOX_ORIGIN_PARAM ? "inbox" : null;
}

function timelineHref(tab: TriageParam): string {
  return `/dashboard?triage=${tab}`;
}

export function articleBackLink(origin: ArticleOrigin | null, triageParam?: string | string[] | undefined): { href: string; label: string } {
  return { href: origin === "inbox" ? timelineHref(parseTriageParam(triageParam)) : "/dashboard", label: "業界ニュースへ戻る" };
}

/** 業界ニュースの一覧から開いた未解析の記事だけ、開いた時点で解析ジョブを積む。不採用の記事は見返しただけで解析枠を使わない。 */
export function shouldAutoAnalyze(origin: ArticleOrigin | null, status: string | null, triage: TriageState): boolean {
  return origin === "inbox" && status === null && triage !== "rejected";
}

/** 一覧から詳細を開くリンク。開いていた仕分けタブを`triage`で引き継ぐ（未判定タブは省略する）。 */
export function articleDetailHref(articleId: string, origin: ArticleOrigin | null, triageParam?: string | null): string {
  if (origin !== "inbox") return `/dashboard/articles/${articleId}`;
  const tab = parseTriageParam(triageParam ?? undefined);
  return `/dashboard/articles/${articleId}?from=${INBOX_ORIGIN_PARAM}${tab === "pending" ? "" : `&triage=${tab}`}`;
}
