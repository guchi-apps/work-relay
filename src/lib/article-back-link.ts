/**
 * 記事詳細画面の「戻る」リンクと、開いた時の自動解析の可否（#467）。
 *
 * 新着記事（`/dashboard/inbox`）から開いたときだけ`?from=inbox`が付く。許可した値以外は
 * 無視し、任意のパスへ飛ばさない。DB・Prismaに触れないので`node --test`で直接読める。
 */
export type ArticleOrigin = "inbox";

export const INBOX_ORIGIN_PARAM = "inbox";

export function parseArticleOrigin(value: string | string[] | undefined): ArticleOrigin | null {
  return value === INBOX_ORIGIN_PARAM ? "inbox" : null;
}

export function articleBackLink(origin: ArticleOrigin | null): { href: string; label: string } {
  return origin === "inbox" ? { href: "/dashboard/inbox", label: "新着記事へ戻る" } : { href: "/dashboard", label: "業界ニュースへ戻る" };
}

/** 新着記事から開いた未解析の記事だけ、開いた時点で解析ジョブを積む。 */
export function shouldAutoAnalyze(origin: ArticleOrigin | null, status: string | null): boolean {
  return origin === "inbox" && status === null;
}

export function articleDetailHref(articleId: string, origin: ArticleOrigin | null): string {
  return `/dashboard/articles/${articleId}${origin === "inbox" ? `?from=${INBOX_ORIGIN_PARAM}` : ""}`;
}
