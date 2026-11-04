import Link from "next/link";
import { redirect } from "next/navigation";
import AnalysisStatusStrip from "@/components/AnalysisStatusStrip";
import ArticleAnalysisBlock from "@/components/ArticleAnalysisBlock";
import HeaderUserMenu from "@/components/HeaderUserMenu";
import { getCurrentUser } from "@/lib/auth";
import { businessParam, getBusinesses, parseBusinessParam, sortBusinesses, type BusinessDef } from "@/lib/businesses";
import { getAnalysisOverview } from "@/lib/article-analysis";
import SwipeWeekNav from "@/components/SwipeWeekNav";
import WeekCalendarPicker from "@/components/WeekCalendarPicker";
import { countPendingReview, OLDEST_WEEK_OFFSET, buildWeekCalendarMonths, formatDate, formatDateTime, formatMetrics, formatWeekLabel, getIsoWeekNumber, getLastCollectedAt, getLatestCollectionRunId, getWeekRange, listIndustryInformation, parseWeekOffset, toMergedSources, toStringArray, type AnalysisParam, type BusinessParam, type ImportanceParam, type IndustryInformationListItem, type SourceParam } from "@/lib/industry-information";

// 週報の登録はAIDE経由の`POST /api/internal/weekly-report`だけで、この画面は表示専用。
// 1週ぶんは全体6件・各事業3件までのため、絞り込み後の件数はそのまま描画してよい大きさに収まる。
// 登録直後に開いても古い内容を返さないよう、毎リクエストでDBを読む。
export const dynamic = "force-dynamic";

const importanceLabels = { HIGH: "高", MEDIUM: "中", REFERENCE: "参考" } as const;

// 直近の収集ランと比べ、このカードが「新規追加」「内容更新」のどちらかを判定する（#43）。
// collectionRunIdは作成時のランのまま不変（週判定に使うため）、updatedByRunIdはマージのたびに
// 現在のランへ更新される。両方が直近ランと一致しない場合はバッジを出さない。
function cardStatus(item: IndustryInformationListItem, latestRunId: string | null): "new" | "updated" | null {
  if (!latestRunId) return null;
  if (item.collectionRunId === latestRunId) return "new";
  if (item.updatedByRunId === latestRunId) return "updated";
  return null;
}

function Card({ item, latestRunId, businesses }: { item: IndustryInformationListItem; latestRunId: string | null; businesses: BusinessDef[] }) {
  const supplement = item.periodScope === "PAST_30_DAYS_SUPPLEMENT";
  const keywords = toStringArray(item.keywords);
  const tags = toStringArray(item.tags);
  const status = cardStatus(item, latestRunId);
  const mergedSources = toMergedSources(item.mergedSources);
  return <article className={`news-card ${supplement ? "supplement" : ""} ${item.weeklyCandidate ? "" : "out-of-scope"}`}>
    <div className="news-head">
      <div><h3>{item.title}</h3><p className="meta">{formatDate(item.publishedAt ?? item.occurredAt ?? item.collectedAt)}　·　{item.sourceName}　·　{item.isPrimarySource ? "一次情報" : "関連記事"}</p></div>
      <div className="badge-col">
        {status && <span className={`status-pill ${status}`}>{status === "new" ? "NEW" : "更新"}</span>}
        <span className={`badge ${item.importance === "HIGH" ? "high" : ""}`}>{supplement ? "30日以内" : `重要度 ${importanceLabels[item.importance]}`}</span>
      </div>
    </div>
    <p className="summary">{item.summary ?? "要約は登録されていません。"}</p>
    <dl className="details"><div><dt>主な数値・事実</dt><dd>{formatMetrics(item.extractedMetrics) ?? "—"}</dd></div><div><dt>企画・設計への示唆</dt><dd>{item.implications ?? "—"}</dd></div><div><dt>キーワード</dt><dd>{keywords.length ? keywords.join("／") : "—"}</dd></div></dl>
    <ArticleAnalysisBlock item={item} businesses={businesses} />
    <div className="news-foot"><div className="tags">{item.targetCompany && <b>{item.targetCompany}</b>}{item.targetProduct && <span>{item.targetProduct}</span>}{tags.map((tag) => <span key={tag}>{tag}</span>)}</div><a href={item.originalUrl} target="_blank" rel="noreferrer">元記事 ↗</a></div>
    {mergedSources.length > 0 && <details className="merge-info">
      <summary>更新履歴を見る</summary>
      <div className="merge-body">
        <div className="row"><dt>統合元URL（{mergedSources.length + 1}件）</dt><dd>
          <a href={item.originalUrl} target="_blank" rel="noreferrer">{item.originalUrl}（{item.isPrimarySource ? "一次情報" : "転載"}）</a>
          {mergedSources.map((source) => <a key={source.normalizedUrl} href={source.url} target="_blank" rel="noreferrer">{source.url}（{source.isPrimarySource ? "一次情報" : "転載"}）</a>)}
        </dd></div>
        <div className="row"><dt>最終更新日時</dt><dd>{formatDateTime(item.updatedAt)}</dd></div>
        <div className="row"><dt>更新理由</dt><dd>{item.updateReason ?? "—"}</dd></div>
      </div>
    </details>}
  </article>;
}

function Section({ def, businesses, items, latestRunId }: { def: BusinessDef; businesses: BusinessDef[]; items: IndustryInformationListItem[]; latestRunId: string | null }) {
  return <section className="news-section"><div className="section-heading section-line"><div className="section-title"><i className={def.color === "teal" ? "" : def.color} /><h2>{def.label}</h2><span>{items.length}件</span></div><p>{def.hint}</p></div><div className="news-list">{items.map((item) => <Card key={item.id} item={item} latestRunId={latestRunId} businesses={businesses} />)}</div></section>;
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getCurrentUser();
  if (user.status === "unavailable") return <section className="content"><div className="empty-state"><p>認証状態を確認できませんでした。しばらくしてから再読み込みしてください。</p></div></section>;
  if (user.status === "unauthenticated") redirect("/login");
  const params = await searchParams;
  const businesses = sortBusinesses(await getBusinesses());
  const business: BusinessParam = parseBusinessParam(businesses, params.business);
  const source: SourceParam = params.source === "primary" || params.source === "related" ? params.source : "all";
  const importance: ImportanceParam = params.importance === "high" || params.importance === "medium" || params.importance === "reference" ? params.importance : "all";
  const analysis: AnalysisParam = params.analysis === "pending" || params.analysis === "analyzed" || params.analysis === "attention" ? params.analysis : "all";
  // 不採用（人が外した・AIが対象外と判定した）記事は既定で隠す。`?excluded=show`のときだけ混ぜて
  // 表示する（誤判定を戻す操作をこの画面から行えるようにするため、完全に見えなくはしない）。
  // 未判定の記事はそのまま出す——仕分けが終わるまで週報の材料が見えないと困るため（#94）。
  const hideExcluded = params.excluded !== "show";
  const weekOffset = parseWeekOffset(params.week);
  const keyword = typeof params.keyword === "string" ? params.keyword.trim() : "";
  const [visible, lastCollectedAt, latestRunId, overview, pendingReviewCount] = await Promise.all([listIndustryInformation({ weekOffset, business, source, importance, keyword, analysis, hideExcluded }), getLastCollectedAt(), getLatestCollectionRunId(), getAnalysisOverview(), countPendingReview()]);
  const query = (newWeek: number) => `/dashboard?week=${newWeek}&business=${business}&source=${source}&importance=${importance}&analysis=${analysis}${hideExcluded ? "" : "&excluded=show"}${keyword ? `&keyword=${encodeURIComponent(keyword)}` : ""}`;
  const prevHref = weekOffset > OLDEST_WEEK_OFFSET ? query(weekOffset - 1) : null;
  const nextHref = weekOffset < 0 ? query(weekOffset + 1) : null;
  // カレンダーピッカー用（#125）。日付グリッドと週番号はサーバー側で計算し、クライアント
  // コンポーネントには開閉・ホバー状態だけを持たせる。
  const currentWeekRange = getWeekRange(weekOffset);
  const calendarMonths = buildWeekCalendarMonths();
  const weekHrefs = Object.fromEntries(Array.from({ length: -OLDEST_WEEK_OFFSET + 1 }, (_, index) => OLDEST_WEEK_OFFSET + index).map((offset) => [offset, query(offset)]));
  return <section className="content"><SwipeWeekNav prevHref={prevHref} nextHref={nextHref} /><header className="page-header"><div><p className="eyebrow">WEEKLY INDUSTRY BRIEF</p><h1>業界ニュース</h1></div><div className="top-actions"><HeaderUserMenu><span>{lastCollectedAt ? `最終更新 ${formatDateTime(lastCollectedAt)}` : "未登録"}</span></HeaderUserMenu></div></header>{pendingReviewCount > 0 && <Link className="new-banner" href="/dashboard/inbox"><span className="dot">📥</span><span className="body"><p className="headline">新着記事が{pendingReviewCount}件あります</p><p className="sub">仕分け待ちの記事があります。採用・不採用を決めると週報の候補に反映されます。</p></span><span className="go">確認する →</span></Link>}<AnalysisStatusStrip overview={overview} /><div className="week-nav"><a href={query(Math.max(OLDEST_WEEK_OFFSET, weekOffset - 1))}>‹</a><WeekCalendarPicker months={calendarMonths} currentWeekOffset={weekOffset} currentLabel={formatWeekLabel(currentWeekRange)} currentWeekNumber={getIsoWeekNumber(currentWeekRange.start)} weekHrefs={weekHrefs} /><a className={weekOffset === 0 ? "disabled" : ""} href={query(Math.min(0, weekOffset + 1))}>›</a></div><form className="filters" method="get"><input type="hidden" name="week" value={weekOffset} /><label>事業区分<select name="business" defaultValue={business}><option value="all">すべて</option>{businesses.map((def) => <option key={def.key} value={businessParam(def.key)}>{def.label}</option>)}</select></label><label>情報区分<select name="source" defaultValue={source}><option value="all">すべて</option><option value="primary">一次情報</option><option value="related">関連記事</option></select></label><label>重要度<select name="importance" defaultValue={importance}><option value="all">すべて</option><option value="high">高</option><option value="medium">中</option><option value="reference">参考</option></select></label><label>AI解析<select name="analysis" defaultValue={analysis}><option value="all">すべて</option><option value="pending">未解析・待ち</option><option value="analyzed">解析済み</option><option value="attention">失敗・認証待ち</option></select></label><label className="toggle"><input type="checkbox" name="excluded" value="show" defaultChecked={!hideExcluded} /><span>不採用・対象外も表示</span></label><label className="keyword">企業・商品<input name="keyword" placeholder="キーワード" defaultValue={keyword} /></label><button type="submit">絞り込む</button></form>{businesses.map((def) => <Section key={def.key} def={def} businesses={businesses} items={visible.filter((item) => item.business === def.key)} latestRunId={latestRunId} />)}{visible.length === 0 && <div className="no-results">条件に一致する情報はありません。期間や絞り込み条件を変えてお試しください。</div>}<p className="note">※ 要約は保存済みの調査結果を表示しています。転載記事は同一発表にまとめ、一次情報と関連記事を区別しています。</p></section>;
}
