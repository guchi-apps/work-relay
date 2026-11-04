import Link from "next/link";
import { redirect } from "next/navigation";
import ArticleAnalysisBlock from "@/components/ArticleAnalysisBlock";
import { ForeignTitleBadge, UntranslatedSummaryNote } from "@/components/ArticleLanguageMarks";
import HeaderUserMenu from "@/components/HeaderUserMenu";
import TriageInbox from "@/components/TriageInbox";
import { getCurrentUser } from "@/lib/auth";
import { businessLabel, getBusinesses, type BusinessDef } from "@/lib/businesses";
import { countTriage, formatDate, getRecencyLabel, listRecentIndustryInformation, toStringArray, type IndustryInformationListItem, type RecencyLabel } from "@/lib/industry-information";
import { getTriageState, parseTriageParam, TRIAGE_PARAMS, type TriageParam } from "@/lib/triage";

// 新着記事は日次収集・AIDE経由の週報登録で登録され次第この画面に出る。
// 仕分け（採用／不採用）を押した直後に古い内容を返さないよう、毎リクエストでDBを読む。
export const dynamic = "force-dynamic";

const importanceLabels = { HIGH: "高", MEDIUM: "中", REFERENCE: "参考" } as const;
const dayHeadings: Record<RecencyLabel, string> = { today: "今日", yesterday: "昨日", earlier: "それ以前" };
const tabLabels: Record<TriageParam, string> = { pending: "未判定", adopted: "採用", rejected: "不採用", all: "すべて" };
const tabHints: Record<TriageParam, string> = {
  pending: "未判定の記事は業界ニュース画面にも出ます。不採用にすると隠れ、「不採用」タブから戻せます。",
  adopted: "採用した記事です。押し直せば不採用に変えられます。",
  rejected: "不採用にした記事です。削除はしていないので、「採用」を押せば戻せます。",
  all: "収集したすべての記事です。仕分けの状態は各カードの札で分かります。",
};
const emptyMessages: Record<TriageParam, string> = {
  pending: "未判定の記事はありません。収集・週報登録が行われるとここに表示されます。",
  adopted: "採用した記事はまだありません。",
  rejected: "不採用にした記事はありません。",
  all: "記事はまだありません。収集・週報登録が行われるとここに表示されます。",
};

/**
 * 新着記事のカード（#94で仕分け用に変更）。左のチェックはまとめて仕分けるバー（`TriageInbox`）が
 * 数え、右下のボタンは1件ずつ採用／不採用にする。AIが対象外と判定した記事は破線のカードで
 * 判定理由まで出し、人はその判定を確認するだけで済むようにする。
 *
 * AI解析の状態表示・「AI解析」ボタンは業界ニュース画面（`/dashboard`）と共通の
 * `ArticleAnalysisBlock`をそのまま使う（#136。手書きで二重管理しない）。
 */
function RecentCard({ item, businesses }: { item: IndustryInformationListItem; businesses: BusinessDef[] }) {
  const tags = toStringArray(item.tags);
  const color = businesses.find((def) => def.key === item.business)?.color ?? "teal";
  const state = getTriageState(item);
  const hidden = state === "rejected" || state === "ai_rejected";
  return <article className={`news-card triage ${hidden ? "out-of-scope" : ""}`}>
    <label className="pick"><input type="checkbox" name="ids" value={item.id} aria-label={`「${item.title}」を選択`} /></label>
    <div className="card-body">
      <div className="biz"><i className={color === "teal" ? "" : color} />{businessLabel(businesses, item.business)}</div>
      <div className="news-head"><div><h3><ForeignTitleBadge title={item.title} />{item.title}</h3><p className="meta">{formatDate(item.publishedAt ?? item.occurredAt ?? item.collectedAt)}　·　{item.sourceName}　·　{item.isPrimarySource ? "一次情報" : "関連記事"}</p></div><span className={`badge ${item.importance === "HIGH" ? "high" : ""}`}>重要度 {importanceLabels[item.importance]}</span></div>
      <p className="summary">{item.summary ?? "要約は登録されていません。"}</p>
      <UntranslatedSummaryNote summary={item.summary} />
      <ArticleAnalysisBlock item={item} businesses={businesses} />
      <div className="news-foot"><div className="tags">{item.targetCompany && <b>{item.targetCompany}</b>}{tags.map((tag) => <span key={tag}>{tag}</span>)}</div><a href={item.originalUrl} target="_blank" rel="noreferrer">元記事 ↗</a></div>
    </div>
  </article>;
}

function DayGroup({ label, items, businesses }: { label: RecencyLabel; items: IndustryInformationListItem[]; businesses: BusinessDef[] }) {
  if (items.length === 0) return null;
  return <div className="day-group"><div className="day-heading"><h2>{dayHeadings[label]}</h2><span className="pill">{formatDate(items[0].collectedAt)}</span><span className="count">{items.length}件</span></div><div className="news-list">{items.map((item) => <RecentCard key={item.id} item={item} businesses={businesses} />)}</div></div>;
}

export default async function InboxPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getCurrentUser();
  if (user.status === "unavailable") return <section className="content"><div className="empty-state"><p>認証状態を確認できませんでした。しばらくしてから再読み込みしてください。</p></div></section>;
  if (user.status === "unauthenticated") redirect("/login");
  const triage = parseTriageParam((await searchParams).triage);
  const [recent, counts, businesses] = await Promise.all([listRecentIndustryInformation(triage), countTriage(), getBusinesses()]);
  const groups: Record<RecencyLabel, IndustryInformationListItem[]> = { today: [], yesterday: [], earlier: [] };
  for (const item of recent) groups[getRecencyLabel(item.collectedAt)].push(item);
  return <section className="content triage-page">
    <a className="breadcrumb" href="/dashboard">‹　業界ニュースへ戻る</a>
    <header className="page-header"><div><p className="eyebrow">LATEST UPDATES</p><h1>新着記事</h1><p className="lead">直近で収集した記事を新しい順に表示しています。関係ない記事は「不採用」で隠し、週報に載せたい記事は「採用」にします。</p></div><div className="top-actions"><HeaderUserMenu /></div></header>
    <nav className="triage-tabs" aria-label="仕分けの状態">{TRIAGE_PARAMS.map((param) => <Link key={param} className={param === triage ? "active" : ""} href={param === "pending" ? "/dashboard/inbox" : `/dashboard/inbox?triage=${param}`} aria-current={param === triage ? "page" : undefined}>{tabLabels[param]} <b>{counts[param]}</b></Link>)}</nav>
    <p className="triage-hint">{tabHints[triage]}</p>
    {recent.length === 0 ? <div className="no-results">{emptyMessages[triage]}</div> : <TriageInbox total={recent.length}>
      {(["today", "yesterday", "earlier"] as const).map((label) => <DayGroup key={label} label={label} items={groups[label]} businesses={businesses} />)}
      <p className="bottom-link"><a href="/dashboard">すべての業界ニュースを見る　▦</a></p>
    </TriageInbox>}
  </section>;
}
