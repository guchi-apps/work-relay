/**
 * 業界ニュースのタイムライン表示（#476）の並び順・日付区切り・期間の判定。
 *
 * 以前の業界ニュース画面は「公開日の週 × 事業区分」で区切り、新着記事画面は収集日で並べていた。
 * RSSが30日前の記事まで取り込んでいたこともあり、今日取り込んで採用した記事が過去の週へ入って
 * しまい「今日何が届いたか」が分からなかった。1本のタイムラインにまとめ、**取り込んだ日（JST）の
 * 新しい日が上、同じ日の中は公開日の新しい順**に並べる。
 *
 * DB・Prismaに触れない純粋な関数だけを置き、`node --test`で直接読めるようにしてある。
 */
import { DAY_MS, jstParts, OLDEST_WEEK_OFFSET } from "./jst-week.ts";
import type { TriageParam } from "./triage.ts";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** 既定の表示期間（日）。取り込んだ日がこの日数以内の記事を出す。 */
export const RECENT_PERIOD_DAYS = 30;

/** 1画面に描く記事数の上限。日次収集は1回30件まで（RSS）なので、30日ぶんでも多くはこの範囲に収まる。 */
export const TIMELINE_LIMIT = 200;

/** 公開から何日たった記事を「少し前の記事」として公開日を目立たせるか。 */
export const STALE_ARTICLE_DAYS = 3;

/** 表示期間。`recent`は取り込んだ日が直近30日、`week`は従来どおり公開日の週（週報メールの作成用）。 */
export type TimelinePeriod = { kind: "recent" } | { kind: "week"; offset: number };

/** `?period=`を読む。`recent`（既定）か、`w0`〜`w-8`（今週を0とする週のオフセット）。 */
export function parsePeriodParam(value: string | string[] | undefined): TimelinePeriod {
  if (typeof value !== "string") return { kind: "recent" };
  const match = value.match(/^w(0|-[1-9]\d*)$/);
  if (!match) return { kind: "recent" };
  const offset = Number(match[1]);
  return offset >= OLDEST_WEEK_OFFSET ? { kind: "week", offset } : { kind: "recent" };
}

export function periodParam(period: TimelinePeriod): string {
  return period.kind === "recent" ? "recent" : `w${period.offset}`;
}

/** JSTの日付キー（`YYYY-MM-DD`）。日付区切りの見出しに使う。 */
export function jstDayKey(date: Date): string {
  const { year, month, day } = jstParts(date);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** `now`が属するJSTの日の0時（UTC表現）。「今日の収集」の集計範囲に使う。 */
export function jstDayStart(now: Date): Date {
  const { year, month, day } = jstParts(now);
  return new Date(Date.UTC(year, month - 1, day) - JST_OFFSET_MS);
}

/** 「11月18日（水）」の形。 */
export function formatDayWithWeekday(date: Date): string {
  const { month, day } = jstParts(date);
  const weekday = new Date(date.getTime() + JST_OFFSET_MS).getUTCDay();
  return `${month}月${day}日（${WEEKDAYS[weekday]}）`;
}

/** 日付区切りの見出し。今日・昨日だけ言葉にし、それ以前は日付で出す。 */
export function dayHeading(date: Date, now = new Date()): string {
  const diff = Math.round((jstDayStart(now).getTime() - jstDayStart(date).getTime()) / DAY_MS);
  if (diff === 0) return "今日";
  if (diff === 1) return "昨日";
  return formatDayWithWeekday(date);
}

export type TimelineFields = { collectedAt: Date; publishedAt: Date | null; occurredAt: Date | null };

/** 記事の「公開日」として見せる日付。公開日が無ければ発生日、それも無ければ取り込んだ日。 */
export function displayDate(item: TimelineFields): Date {
  return item.publishedAt ?? item.occurredAt ?? item.collectedAt;
}

/** 取り込んだ時点で公開から`STALE_ARTICLE_DAYS`日以上たっていた記事か（公開日を目立たせる）。 */
export function isStaleArticle(item: TimelineFields): boolean {
  const published = item.publishedAt ?? item.occurredAt;
  if (!published) return false;
  return item.collectedAt.getTime() - published.getTime() >= STALE_ARTICLE_DAYS * DAY_MS;
}

export type TimelineDay<T> = { key: string; date: Date; items: T[] };

/**
 * 取り込んだ日（JST）ごとに区切る。日は新しい順、同じ日の中は公開日（`displayDate()`）の新しい順、
 * 公開日が同じなら取り込んだ時刻の新しい順。
 */
export function groupByCollectedDay<T extends TimelineFields>(items: readonly T[]): TimelineDay<T>[] {
  const days = new Map<string, TimelineDay<T>>();
  for (const item of items) {
    const key = jstDayKey(item.collectedAt);
    const day = days.get(key);
    if (day) day.items.push(item);
    else days.set(key, { key, date: item.collectedAt, items: [item] });
  }
  const sorted = [...days.values()].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  for (const day of sorted) {
    day.items.sort((a, b) => displayDate(b).getTime() - displayDate(a).getTime() || b.collectedAt.getTime() - a.collectedAt.getTime());
  }
  return sorted;
}

/**
 * `?triage=`が無いときに開くタブ。未判定が残っていれば「未判定」、無ければ「採用」。
 * 新着記事画面を統合したため、仕分け待ちがあればまずそれを見せ、片付いていれば採用した記事を読む画面にする。
 */
export function defaultTriageTab(pendingCount: number): TriageParam {
  return pendingCount > 0 ? "pending" : "adopted";
}

/** 続報として元記事を探す範囲（取り込んでからの日数）。 */
export const FOLLOW_UP_DAYS = 30;

/** 続報の元記事を探す下限（`now`の`FOLLOW_UP_DAYS`日前）。 */
export function followUpCutoff(now: Date): Date {
  return new Date(now.getTime() - FOLLOW_UP_DAYS * 24 * 60 * 60 * 1000);
}

/** 続報カードの文言。「11/02に採用した『…』の続報です」。採用日はJSTで表す。 */
export function followUpLabel(adoptedAt: Date | null, title: string): string {
  if (!adoptedAt) return `採用した『${title}』の続報です`;
  const [, month, day] = jstDayKey(adoptedAt).split("-");
  return `${month}/${day}に採用した『${title}』の続報です`;
}

export type RunCounts = { insertedCount: number; mergedCount: number; excludedCount: number };

/** 今日の収集ランの件数を合計する（RSSとAI検索収集で、1日に複数のランがある）。 */
export function sumRunCounts(runs: readonly RunCounts[]): RunCounts {
  return runs.reduce((total, run) => ({ insertedCount: total.insertedCount + run.insertedCount, mergedCount: total.mergedCount + run.mergedCount, excludedCount: total.excludedCount + run.excludedCount }), { insertedCount: 0, mergedCount: 0, excludedCount: 0 });
}

/**
 * カードの「NEW／更新」バッジ。今日の収集ランで作られた記事は`new`、今日のランで別の記事が
 * 統合された（`updatedByRunId`が今日のラン）記事は`updated`。
 */
export function cardBadge(item: { collectionRunId: string | null; updatedByRunId: string | null }, todayRunIds: ReadonlySet<string>): "new" | "updated" | null {
  if (item.collectionRunId && todayRunIds.has(item.collectionRunId)) return "new";
  if (item.updatedByRunId && todayRunIds.has(item.updatedByRunId)) return "updated";
  return null;
}
