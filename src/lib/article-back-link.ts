import { parseTriageParam, type TriageParam, type TriageState } from "./triage.ts";

/**
 * 記事詳細画面の「戻る」リンクと、開いた時の自動解析の可否（#467）。
 *
 * 新着記事（`/dashboard/inbox`）から開いたときだけ`?from=inbox`（と開いていた仕分けタブの
 * `&triage=`）が付く。許可した値以外は無視し、任意のパスへ飛ばさない。DB・Prismaに触れないので
 * `node --test`で直接読める。
 */
export type ArticleOrigin = "inbox";

export const INBOX_ORIGIN_PARAM = "inbox";

export function parseArticleOrigin(value: string | string[] | undefined): ArticleOrigin | null {
  return value === INBOX_ORIGIN_PARAM ? "inbox" : null;
}

function inboxHref(tab: TriageParam): string {
  return tab === "pending" ? "/dashboard/inbox" : `/dashboard/inbox?triage=${tab}`;
}

export function articleBackLink(origin: ArticleOrigin | null, triageParam?: string | string[] | undefined): { href: string; label: string } {
  return origin === "inbox" ? { href: inboxHref(parseTriageParam(triageParam)), label: "新着記事へ戻る" } : { href: "/dashboard", label: "業界ニュースへ戻る" };
}

/** 新着記事から開いた未解析の記事だけ、開いた時点で解析ジョブを積む。不採用の記事は見返しただけで解析枠を使わない。 */
export function shouldAutoAnalyze(origin: ArticleOrigin | null, status: string | null, triage: TriageState): boolean {
  return origin === "inbox" && status === null && triage !== "rejected";
}

/** 新着記事から詳細を開くリンク。開いていた仕分けタブを`triage`で引き継ぐ。 */
export function articleDetailHref(articleId: string, origin: ArticleOrigin | null, triageParam?: string | null): string {
  if (origin !== "inbox") return `/dashboard/articles/${articleId}`;
  const tab = parseTriageParam(triageParam ?? undefined);
  return `/dashboard/articles/${articleId}?from=${INBOX_ORIGIN_PARAM}${tab === "pending" ? "" : `&triage=${tab}`}`;
}
