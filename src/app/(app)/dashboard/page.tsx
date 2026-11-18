import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import AnalysisStatusStrip from "@/components/AnalysisStatusStrip";
import ArticleAnalysisBlock from "@/components/ArticleAnalysisBlock";
import { ForeignTitleBadge, UntranslatedSummaryNote } from "@/components/ArticleLanguageMarks";
import HeaderUserMenu from "@/components/HeaderUserMenu";
import { getCurrentUser } from "@/lib/auth";
import { businessLabel, businessParam, getBusinesses, parseBusinessParam, sortBusinesses, type BusinessDef } from "@/lib/businesses";
import { getAnalysisOverview } from "@/lib/article-analysis";
import { pickDisplaySummary, summaryPlaceholder } from "@/lib/display-summary";
import { countTriage, formatDateTime, formatWeekLabel, getLastCollectedAt, getTodayCollection, getWeekRange, listTimeline, OLDEST_WEEK_OFFSET, toMergedSources, toStringArray, type BusinessParam, type ImportanceParam, type TimelineItem, type TodayCollection } from "@/lib/industry-information";
import { cardBadge, dayHeading, defaultTriageTab, displayDate, followUpLabel, formatDayWithWeekday, groupByCollectedDay, isStaleArticle, parsePeriodParam, periodParam, RECENT_PERIOD_DAYS, TIMELINE_LIMIT, type TimelinePeriod } from "@/lib/timeline";
import { getTriageState, TRIAGE_PARAMS, type TriageParam } from "@/lib/triage";

// 業界ニュースのタイムライン（#476）。以前の「公開日の週×事業区分」の段組みと、新着記事画面
// （`/dashboard/inbox`。今はここへの転送だけ）の仕分けを1画面にまとめた。取り込んだ日の新しい日が上、
// 同じ日の中は公開日の新しい順に並べる（`src/lib/timeline.ts`）。
// 仕分け（採用／不採用）を押した直後に古い内容を返さないよう、毎リクエストでDBを読む。
export const dynamic = "force-dynamic";

const importanceLabels = { HIGH: "高", MEDIUM: "中", REFERENCE: "参考" } as const;
const tabLabels: Record<TriageParam, string> = { pending: "未判定", adopted: "採用", all: "すべて", rejected: "不採用" };
// タブの並びは見た目案どおり「未判定・採用・すべて・不採用」（不採用は普段開かないので最後）。
const TAB_ORDER: readonly TriageParam[] = ["pending", "adopted", "all", "rejected"];
const tabHints: Record<TriageParam, string> = {
  pending: "まだ採用・不採用を決めていない記事です。不採用にすると隠れ、「不採用」タブから戻せます。",
  adopted: "採用した記事です。週報メールに使う記事はここから選べます。",
  all: "取り込んだすべての記事です。仕分けの状態は各カードの札で分かります。",
  rejected: "不採用にした記事です。削除はしていないので、「採用」を押せば戻せます。",
};
const emptyMessages: Record<TriageParam, string> = {
  pending: "未判定の記事はありません。毎朝の収集で新しい記事が届くとここに表示されます。",
  adopted: "この条件で採用した記事はありません。",
  all: "この条件に一致する記事はありません。",
  rejected: "不採用にした記事はありません。",
};

type Query = { triage: TriageParam; business: BusinessParam; importance: ImportanceParam; keyword: string; period: TimelinePeriod };

function buildHref(query: Query, change: Partial<Query>): string {
  const next = { ...query, ...change };
  const params = new URLSearchParams({ triage: next.triage });
  if (next.business !== "all") params.set("business", next.business);
  if (next.period.kind !== "recent") params.set("period", periodParam(next.period));
  if (next.importance !== "all") params.set("importance", next.importance);
  if (next.keyword) params.set("keyword", next.keyword);
  return `/dashboard?${params.toString()}`;
}

function TodayStrip({ today, pendingCount, pendingHref }: { today: TodayCollection; pendingCount: number; pendingHref: string }) {
  return <section className="today-strip" aria-label="今日の収集">
    <div className="ttl">今日の収集<small>{today.lastRunAt ? `${formatDateTime(today.lastRunAt)}・RSSとAI検索` : "今日はまだ収集していません"}</small></div>
    <div className="st hl"><b>{today.insertedCount}</b><span>新しく取り込み</span></div>
    <div className="st"><b>{today.followUpCount}</b><span>続報として紐付け</span></div>
    <div className="st"><b>{today.mergedCount}</b><span>既存の記事に統合</span></div>
    <div className="st"><b>{today.excludedCount}</b><span>上限のため見送り</span></div>
    {pendingCount > 0 && <Link className="go" href={pendingHref}>未判定 {pendingCount}件を見る</Link>}
  </section>;
}

function Card({ item, businesses, todayRunIds, tab }: { item: TimelineItem; businesses: BusinessDef[]; todayRunIds: ReadonlySet<string>; tab: TriageParam }) {
  const color = businesses.find((def) => def.key === item.business)?.color ?? "teal";
  const badge = cardBadge(item, todayRunIds);
  const state = getTriageState(item);
  const hidden = state === "rejected" || state === "ai_rejected";
  const summary = pickDisplaySummary(item);
  const tags = toStringArray(item.tags);
  const mergedSources = toMergedSources(item.mergedSources);
  const stale = isStaleArticle(item);
  return <article className={`news-card timeline-card ${hidden ? "out-of-scope" : ""}`}>
    <div className="biz"><i className={color === "teal" ? "" : color} />{businessLabel(businesses, item.business)}
      {badge && <span className={`status-pill ${badge}`}>{badge === "new" ? "NEW" : "更新"}</span>}
      {item.canonical && <span className="status-pill followup">続報</span>}
      <span className={`badge ${item.importance === "HIGH" ? "high" : ""}`}>重要度 {importanceLabels[item.importance]}</span>
    </div>
    {item.canonical && <p className="followup-note"><Link href={`/dashboard/articles/${item.canonical.id}`}>{followUpLabel(item.canonical.reviewedAt, item.canonical.title)}</Link></p>}
    <h3><ForeignTitleBadge title={item.title} />{item.title}</h3>
    <p className="meta"><span className={stale ? "stale" : undefined} title={stale ? "取り込んだ時点で公開から3日以上たっていた記事です" : undefined}>公開 {formatDayWithWeekday(displayDate(item))}</span>　·　{item.sourceName}　·　{item.isPrimarySource ? "一次情報" : "関連記事"}</p>
    <p className="summary">{summary ?? summaryPlaceholder(item.analysisStatus)}</p>
    <UntranslatedSummaryNote summary={summary} />
    {item.implications && <p className="implication"><b>仕事への示唆</b>{item.implications}</p>}
    {mergedSources.length > 0 && <details className="same-topic">
      <summary>同じ話題の記事 {mergedSources.length + 1}件をまとめています</summary>
      <ul>
        <li><a href={item.originalUrl} target="_blank" rel="noreferrer">{item.publisher ?? item.sourceName}</a>（{item.isPrimarySource ? "一次情報" : "関連記事"}・この記事）</li>
        {mergedSources.map((source) => <li key={source.normalizedUrl}><a href={source.url} target="_blank" rel="noreferrer">{source.publisher ?? source.sourceName}</a>（{source.isPrimarySource ? "一次情報" : "転載"}・{formatDateTime(new Date(source.mergedAt))}に統合）</li>)}
      </ul>
      {item.updateReason && <p className="reason">最終更新 {formatDateTime(item.updatedAt)}：{item.updateReason}</p>}
    </details>}
    <ArticleAnalysisBlock item={item} businesses={businesses} triageOnly={tab === "pending"} hideActionsWhenAdopted={tab !== "pending"} triageTab={tab} />
    <div className="news-foot"><div className="tags">{item.targetCompany && <b>{item.targetCompany}</b>}{item.targetProduct && <span>{item.targetProduct}</span>}{tags.map((tag) => <span key={tag}>{tag}</span>)}</div><a href={item.originalUrl} target="_blank" rel="noreferrer">元記事 <ExternalLink className="ic" aria-hidden="true" /></a></div>
  </article>;
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getCurrentUser();
  if (user.status === "unavailable") return <section className="content"><div className="empty-state"><p>認証状態を確認できませんでした。しばらくしてから再読み込みしてください。</p></div></section>;
  if (user.status === "unauthenticated") redirect("/login");
  const params = await searchParams;
  const now = new Date();
  const [businessesRaw, counts, today, lastCollectedAt, overview] = await Promise.all([getBusinesses(), countTriage(), getTodayCollection(now), getLastCollectedAt(), getAnalysisOverview()]);
  const businesses = sortBusinesses(businessesRaw);
  const triage: TriageParam = typeof params.triage === "string" && (TRIAGE_PARAMS as readonly string[]).includes(params.triage) ? (params.triage as TriageParam) : defaultTriageTab(counts.pending);
  const query: Query = {
    triage,
    business: parseBusinessParam(businesses, params.business),
    importance: params.importance === "high" || params.importance === "medium" || params.importance === "reference" ? params.importance : "all",
    keyword: typeof params.keyword === "string" ? params.keyword.trim() : "",
    period: parsePeriodParam(params.period),
  };
  const items = await listTimeline(query, now);
  const days = groupByCollectedDay(items);
  const todayRunIds = new Set(today.runIds);
  const weekOptions = Array.from({ length: -OLDEST_WEEK_OFFSET + 1 }, (_, index) => -index);

  return <section className="content timeline-page">
    <header className="page-header"><div><p className="eyebrow">INDUSTRY NEWS</p><h1>業界ニュース</h1></div><div className="top-actions"><HeaderUserMenu><span>{lastCollectedAt ? `最終更新 ${formatDateTime(lastCollectedAt)}` : "未登録"}</span></HeaderUserMenu></div></header>
    <TodayStrip today={today} pendingCount={counts.pending} pendingHref={buildHref(query, { triage: "pending" })} />
    <AnalysisStatusStrip overview={overview} />
    <nav className="triage-tabs" aria-label="仕分けの状態">{TAB_ORDER.map((tab) => <Link key={tab} className={tab === triage ? "active" : ""} href={buildHref(query, { triage: tab })} aria-current={tab === triage ? "page" : undefined}>{tabLabels[tab]} <b>{counts[tab]}</b></Link>)}</nav>
    <p className="triage-hint">{tabHints[triage]}</p>
    <div className="biz-chips" aria-label="事業区分">
      <Link className={query.business === "all" ? "on" : ""} href={buildHref(query, { business: "all" })}>すべて</Link>
      {businesses.map((def) => { const param = businessParam(def.key); return <Link key={def.key} className={query.business === param ? "on" : ""} href={buildHref(query, { business: param })}><i className={def.color === "teal" ? "" : def.color} />{def.label}</Link>; })}
    </div>
    <form className="filters timeline-filters" method="get">
      <input type="hidden" name="triage" value={triage} />
      {query.business !== "all" && <input type="hidden" name="business" value={query.business} />}
      <label>期間<select name="period" defaultValue={periodParam(query.period)}><option value="recent">直近{RECENT_PERIOD_DAYS}日（取り込んだ日）</option>{weekOptions.map((offset) => <option key={offset} value={`w${offset}`}>{offset === 0 ? "今週" : `${-offset}週前`}（{formatWeekLabel(getWeekRange(offset, now))}・公開日）</option>)}</select></label>
      <label>重要度<select name="importance" defaultValue={query.importance}><option value="all">すべて</option><option value="high">高</option><option value="medium">中</option><option value="reference">参考</option></select></label>
      <label className="keyword">企業・商品<input name="keyword" placeholder="キーワード" defaultValue={query.keyword} /></label>
      <button type="submit">絞り込む</button>
    </form>
    {days.length === 0 ? <div className="no-results">{emptyMessages[triage]}</div> : days.map((day) => <div className="day-group" key={day.key}>
      <div className="day-heading"><h2>{dayHeading(day.date, now)}</h2><span className="pill">{formatDayWithWeekday(day.date)}</span><span className="count">{day.items.length}件</span></div>
      <div className="news-list">{day.items.map((item) => <Card key={item.id} item={item} businesses={businesses} todayRunIds={todayRunIds} tab={triage} />)}</div>
    </div>)}
    {items.length >= TIMELINE_LIMIT && <p className="note">※ 新しい順に{TIMELINE_LIMIT}件まで表示しています。古い記事は期間や絞り込みで探してください。</p>}
    <p className="note">※ 並び順は取り込んだ日（新しい日が上）→ 同じ日の中は公開日の新しい順です。取り込んだ時点で公開から3日以上たっていた記事は公開日を<span className="stale">橙色</span>で示します。週を指定したときは、その週に公開された記事を出します（週報メールの作成用）。</p>
  </section>;
}
