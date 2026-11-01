import Link from "next/link";
import { redirect } from "next/navigation";
import HeaderUserMenu from "@/components/HeaderUserMenu";
import NewsMailPanel, { type NewsMailRow } from "@/components/NewsMailPanel";
import { getAnalysisOverview } from "@/lib/article-analysis";
import { getCurrentUser } from "@/lib/auth";
import { businessParam, getBusinesses, parseBusinessParam } from "@/lib/businesses";
import {
  formatWeekLabel,
  getWeekRange,
  listNewsMailArticles,
  parseMailTriageParam,
  parseWeekBasis,
  parseWeekOffset,
  OLDEST_WEEK_OFFSET,
  type BusinessParam,
  type ImportanceParam,
  type MailTriageParam,
  type WeekBasisParam,
} from "@/lib/industry-information";
import { defaultSubjectBody, isCollectedOnly, toNewsMailArticle } from "@/lib/news-mail";
import { toNewsMailArticleDto } from "@/lib/news-mail-articles";
import { getTriageState } from "@/lib/triage";
import { getLatestWeeklyBrief } from "@/lib/weekly-brief";

// 送信直後・解析の完了直後に古い内容を返さないよう、毎リクエストでDBを読む（他の画面と同じ）。
export const dynamic = "force-dynamic";

/** この画面の既定の週は「先週」。週明けに先週ぶんをまとめて送る使い方を想定している（#110）。 */
const DEFAULT_WEEK_OFFSET = -1;

const BASIS_OPTIONS: { value: WeekBasisParam; label: string; note: string | null }[] = [
  { value: "published", label: "公開日がこの週", note: null },
  { value: "collected", label: "この週に取得", note: null },
  { value: "either", label: "どちらか", note: "既定" },
];

export default async function NewsMailPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getCurrentUser();
  if (user.status === "unavailable") {
    return (
      <section className="content">
        <div className="empty-state">
          <p>認証状態を確認できませんでした。しばらくしてから再読み込みしてください。</p>
        </div>
      </section>
    );
  }
  if (user.status === "unauthenticated") redirect("/login");

  const params = await searchParams;
  const weekOffset = parseWeekOffset(params.week, DEFAULT_WEEK_OFFSET);
  const basis = parseWeekBasis(params.basis);
  const businesses = await getBusinesses();
  const business: BusinessParam = parseBusinessParam(businesses, params.business);
  const importance: ImportanceParam = params.importance === "high" || params.importance === "medium" || params.importance === "reference" ? params.importance : "all";
  const triage: MailTriageParam = parseMailTriageParam(params.triage);
  const keyword = typeof params.keyword === "string" ? params.keyword.trim() : "";
  // 共有された記事画面の「この記事だけ送る」（#144）。その記事だけにチェックを入れて開く。
  const pick = typeof params.pick === "string" && params.pick ? params.pick : null;

  const range = getWeekRange(weekOffset);
  const [items, brief, overview] = await Promise.all([
    listNewsMailArticles({ weekOffset, basis, business, importance, triage, keyword }),
    getLatestWeeklyBrief(weekOffset),
    getAnalysisOverview(),
  ]);

  const rows: NewsMailRow[] = items.map((item) => ({ article: toNewsMailArticleDto(item), triage: getTriageState(item) }));
  const adoptedCount = rows.filter((row) => row.triage === "adopted").length;
  // 指定された記事がこの週・この絞り込みの一覧に無ければ、いつもどおり採用した記事から始める。
  const pickedArticleId = pick && rows.some((row) => row.article.id === pick) ? pick : null;
  const collectedOnlyCount = rows.filter((row) => isCollectedOnly(toNewsMailArticle(row.article), range)).length;

  const query = (overrides: { week?: number; basis?: WeekBasisParam }) => {
    const search = new URLSearchParams({
      week: String(overrides.week ?? weekOffset),
      basis: overrides.basis ?? basis,
      business,
      importance,
      triage,
    });
    if (keyword) search.set("keyword", keyword);
    return `/dashboard/news-mail?${search.toString()}`;
  };

  return (
    <section className="content">
      <Link className="breadcrumb" href="/dashboard">
        ‹　業界ニュースへ戻る
      </Link>
      <header className="page-header">
        <div>
          <p className="eyebrow">WEEKLY DIGEST MAIL</p>
          <h1>ニュースを社用メールに送る</h1>
          <p className="lead">選んだ週の記事から送るものにチェックを付け、AIのまとめを添えて1通の週報メールにします。宛先は設定済みの社用アドレス固定です。</p>
        </div>
        <div className="top-actions">
          <HeaderUserMenu />
        </div>
      </header>

      <div className="week-nav">
        <a href={query({ week: Math.max(OLDEST_WEEK_OFFSET, weekOffset - 1) })}>‹</a>
        <div>
          <strong>{formatWeekLabel(range)}</strong>
          {weekOffset === -1 && <span className="week-tag">先週</span>}
          {weekOffset === 0 && <span className="week-tag">今週</span>}
        </div>
        <a className={weekOffset === 0 ? "disabled" : ""} href={query({ week: Math.min(0, weekOffset + 1) })}>
          ›
        </a>
      </div>

      <div className="basis-bar">
        <span className="basis-label">対象の取り方</span>
        <div className="segmented">
          {BASIS_OPTIONS.map((option) => (
            <a key={option.value} className={option.value === basis ? "active" : ""} href={query({ basis: option.value })}>
              {option.label}
              {option.note && <small>{option.note}</small>}
            </a>
          ))}
        </div>
        <p className="hint">
          {basis === "published"
            ? "公開日がこの週の記事だけを出しています。先週取得した記事も送るなら「どちらか」にしてください。"
            : collectedOnlyCount > 0
              ? `公開が前の週でも、この週に取得した記事は一覧に残ります（${collectedOnlyCount}件が「取得のみ」で入っています）。`
              : "公開が前の週でも、この週に取得した記事は一覧に残ります。"}
        </p>
      </div>

      <form className="filters" method="get">
        <input type="hidden" name="week" value={weekOffset} />
        <input type="hidden" name="basis" value={basis} />
        <label>
          事業区分
          <select name="business" defaultValue={business}>
            <option value="all">すべて</option>
            {businesses.map((def) => (
              <option key={def.key} value={businessParam(def.key)}>
                {def.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          重要度
          <select name="importance" defaultValue={importance}>
            <option value="all">すべて</option>
            <option value="high">高</option>
            <option value="medium">中</option>
            <option value="reference">参考</option>
          </select>
        </label>
        <label>
          仕分け
          <select name="triage" defaultValue={triage}>
            <option value="adopted_pending">採用・未判定</option>
            <option value="adopted">採用のみ</option>
            <option value="all">すべて</option>
          </select>
        </label>
        <label className="keyword">
          企業・商品
          <input name="keyword" placeholder="キーワード" defaultValue={keyword} />
        </label>
        <button type="submit">絞り込む</button>
      </form>

      <NewsMailPanel
        businesses={businesses}
        rows={rows}
        weekOffset={weekOffset}
        basis={basis}
        weekStartIso={range.start.toISOString()}
        weekEndIso={range.end.toISOString()}
        brief={brief ? { status: brief.status, headline: brief.headline, overview: brief.overview, topics: brief.topics, failureMessage: brief.failureMessage } : null}
        defaultSubjectBody={defaultSubjectBody(range, pickedArticleId ? 1 : adoptedCount || rows.length)}
        analysisQueue={overview.queued + overview.running}
        pickedArticleId={pickedArticleId}
      />

      <p className="note">
        ※ AIの解析・総括はVPS上のCodex CLIが1件ずつ順に実行します。総括は先に積んだ記事の解析が終わってから走るため、記事をまとめて解析に積んだ直後は待ち時間が長くなります（1件あたり数分）。送信はAIDE経由で、宛先・BCCはAIDE側の設定で固定しています。
      </p>
    </section>
  );
}
