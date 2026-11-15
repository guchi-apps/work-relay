import { prisma } from "@/lib/db";
import { DEFAULT_BUSINESSES, normalizeExcludeKeywords, sortBusinesses, type BusinessColor, type BusinessDef, type BusinessFeed } from "@/lib/business-defs";

export * from "@/lib/business-defs";

const COLORS: BusinessColor[] = ["teal", "orange", "violet"];

function toFeeds(value: unknown): BusinessFeed[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const { name, query, lang } = item as Record<string, unknown>;
    return typeof name === "string" && typeof query === "string" && (lang === "ja" || lang === "en") ? [{ name, query, lang }] : [];
  });
}

/** 事業区分のマスタを並び順どおりに読む。表が空のとき（未マイグレーション等）は初期値を返す。 */
export async function getBusinesses(): Promise<BusinessDef[]> {
  const rows = await prisma.industryBusiness.findMany({ orderBy: { sortOrder: "asc" } });
  if (rows.length === 0) return DEFAULT_BUSINESSES;
  return sortBusinesses(rows.map((row) => ({
    key: row.key,
    label: row.label,
    shortLabel: row.shortLabel,
    hint: row.hint,
    scope: row.scope,
    defaultPolicy: row.defaultPolicy,
    color: (COLORS as string[]).includes(row.color) ? (row.color as BusinessColor) : "teal",
    sortOrder: row.sortOrder,
    feeds: toFeeds(row.feeds),
    excludeKeywords: normalizeExcludeKeywords(row.excludeKeywords),
  })));
}

/** RSS収集で使う検索フィード（区分ごとのクエリをGoogleニュースのURLに展開したもの）。 */
export function googleNewsRssUrl(query: string, lang: "ja" | "en", excludeKeywords: readonly string[] = []): string {
  // 除外語はGoogleニュース側でも`-"語"`で外す（取得後のタイトル照合と二重に効かせる）。
  const full = [query, ...excludeKeywords.filter((word) => !word.includes('"')).map((word) => `-"${word}"`)].join(" ");
  const region = lang === "ja" ? "hl=ja&gl=JP&ceid=JP:ja" : "hl=en&gl=US&ceid=US:en";
  return `https://news.google.com/rss/search?q=${encodeURIComponent(full)}&${region}`;
}

export function buildFeeds(defs: readonly BusinessDef[]) {
  return defs.flatMap((def) => def.feeds.map((feed) => ({ business: def.key, ...feed, url: googleNewsRssUrl(feed.query, feed.lang, def.excludeKeywords) })));
}
