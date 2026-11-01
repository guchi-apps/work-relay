import Link from "next/link";
import { redirect } from "next/navigation";
import AnalysisStatusStrip from "@/components/AnalysisStatusStrip";
import AutoRefresh from "@/components/AutoRefresh";
import { ANALYSIS_STATUS_CLASS, ANALYSIS_STATUS_LABELS, FAILURE_KIND_LABELS, formatElapsed, isWorkerStale, relevanceLabel, WORKER_STALE_MINUTES } from "@/lib/analysis-display";
import { ATTENTION_LIMIT, AUTO_REFRESH_SECONDS, formatClock, formatDuration, formatLeaseRemaining, formatSnapshotTime, leaseProgress, orderQueue, RECENT_COMPLETED_LIMIT, startOfJstDay } from "@/lib/analysis-queue-view";
import { getAnalysisOverview, getAnalysisQueueDetail, MAX_CLAIM_JOBS, type QueueItem } from "@/lib/article-analysis";
import { getCurrentUser } from "@/lib/auth";
import { getBusinesses, normalizeBusinessKey, type BusinessDef } from "@/lib/businesses";
import { listRecentCollectionSearchJobs } from "@/lib/collection-search";
import { formatDateTime } from "@/lib/jst-week";

// 「自動収集」欄に出す直近の収集ジョブの数。1日1本が基本なので、数日ぶんが見えれば足りる。
const COLLECTION_JOB_LIMIT = 5;

// 自動更新（router.refresh）のたびに最新の状態を読む。
export const dynamic = "force-dynamic";

function ItemTitle({ item }: { item: QueueItem }) {
  return item.article ? <Link className="q-title" href={`/dashboard/articles/${item.article.id}`}>{item.label}</Link> : <span className="q-title">{item.label}</span>;
}

function ItemMeta({ item, businesses, children }: { item: QueueItem; businesses: BusinessDef[]; children?: React.ReactNode }) {
  return (
    <div className="q-meta">
      {item.article ? <><span>記事</span><span>{relevanceLabel(businesses, item.article.business)}</span></> : <><span className="chip kind">週の総括</span><span>対象 {item.articleCount}件</span></>}
      {children}
      {item.attempt !== null && item.attempt > 1 && <span>試行 {item.attempt}回目</span>}
    </div>
  );
}

/**
 * 解析状況画面（#137）。
 *
 * 画面上部の「ChatGPT 解析」の帯から開く。いま何を解析していて、何が順番を待っていて、
 * 何が失敗・認証待ちで止まっているかを、ポーラーが取る順のまま並べる。
 */
export default async function AnalysisStatusPage() {
  const user = await getCurrentUser();
  if (user.status === "unavailable") return <section className="content"><div className="empty-state"><p>認証状態を確認できませんでした。しばらくしてから再読み込みしてください。</p></div></section>;
  if (user.status === "unauthenticated") redirect("/login");

  const now = new Date();
  const businesses = await getBusinesses();
  const [overview, detail, collectionJobs] = await Promise.all([getAnalysisOverview(), getAnalysisQueueDetail({ recentLimit: RECENT_COMPLETED_LIMIT, attentionLimit: ATTENTION_LIMIT, todayStart: startOfJstDay(now) }), listRecentCollectionSearchJobs(COLLECTION_JOB_LIMIT)]);
  const queued = orderQueue(detail.queued);
  const worker = overview.worker;
  const stale = isWorkerStale(worker, now);

  return <section className="content">
    <AutoRefresh seconds={AUTO_REFRESH_SECONDS} />
    <Link className="breadcrumb" href="/dashboard">‹　業界ニュースへ戻る</Link>
    <header className="page-header">
      <div><p className="eyebrow">CHATGPT ANALYSIS</p><h1>解析状況</h1></div>
      <span className="q-refresh"><i />{AUTO_REFRESH_SECONDS}秒ごとに自動更新 · {formatSnapshotTime(now)} 時点</span>
    </header>
    <AnalysisStatusStrip overview={overview} now={now} linked={false} />

    <div className="q-grid">
      <div className="q-col">
        <section className="q-panel">
          <div className="q-head"><h2>解析中 <span className="q-count">{detail.running.length}</span></h2><small>1回の取得で最大{MAX_CLAIM_JOBS}件まで同時に実行</small></div>
          {detail.running.length === 0 ? <p className="q-empty">いま解析している記事はありません。</p> : <ol className="q-rows">
            {detail.running.map((item) => <li className="q-row" key={item.id}>
              <span className="chip running q-mark" aria-label="解析中"><i className="dot" /></span>
              <div><ItemTitle item={item} /><ItemMeta item={item} businesses={businesses}>{item.startedAt && <span>開始 {formatClock(item.startedAt)}</span>}</ItemMeta></div>
              <div className="q-side"><b>{item.startedAt ? formatDuration(now.getTime() - item.startedAt.getTime()) : "—"}</b><span>{formatLeaseRemaining(item.leaseExpiresAt, now)}</span></div>
              <div className="q-bar"><b style={{ width: `${Math.round(leaseProgress(item.startedAt, item.leaseExpiresAt, now) * 100)}%` }} /></div>
            </li>)}
          </ol>}
        </section>

        <section className="q-panel">
          <div className="q-head"><h2>待ち <span className="q-count">{queued.length}</span></h2><small>上から順に解析します</small></div>
          {queued.length === 0 ? <p className="q-empty">順番を待っている記事はありません。</p> : <ol className="q-rows">
            {queued.map((item, index) => <li className="q-row" key={item.id}>
              <span className={`q-pos ${index === 0 ? "next" : ""}`}>{index + 1}</span>
              <div><ItemTitle item={item} /><ItemMeta item={item} businesses={businesses}><span>積んだ時刻 {formatClock(item.queuedAt)}</span></ItemMeta></div>
              <div className="q-side">
                {index === 0 && <span className="chip queued">次に解析</span>}
                <span>{item.kind === "weekly_brief" && queued.some((other) => other.kind === "article") ? "記事のあとに実行" : `待ち ${formatDuration(now.getTime() - item.queuedAt.getTime())}`}</span>
              </div>
            </li>)}
          </ol>}
          {queued.some((item) => item.kind === "weekly_brief") && <p className="q-hint">週の総括は時間がかかるため、待っている記事の解析が片付いてから実行されます。</p>}
        </section>

        <section className="q-panel">
          <div className="q-head"><h2>要対応 <span className={`q-count ${detail.attention.length > 0 ? "warn" : ""}`}>{detail.attention.length}</span></h2><small>失敗・認証待ちのまま止まっている記事</small></div>
          {detail.attention.length === 0 ? <p className="q-empty">止まっている記事はありません。</p> : <ol className="q-rows">
            {detail.attention.map((item) => <li className="q-row" key={item.jobId}>
              <span className={`chip ${ANALYSIS_STATUS_CLASS[item.status]} q-mark`} aria-hidden="true"><i className="dot" /></span>
              <div>
                <Link className="q-title" href={`/dashboard/articles/${item.article.id}`}>{item.article.title}</Link>
                <div className="q-meta"><span>記事</span><span>{relevanceLabel(businesses, item.article.business)}</span>{item.finishedAt && <span>終了 {formatClock(item.finishedAt)}</span>}{item.attempt > 1 && <span>試行 {item.attempt}回目</span>}</div>
              </div>
              <div className="q-side"><span className={`chip ${ANALYSIS_STATUS_CLASS[item.status]}`}>{ANALYSIS_STATUS_LABELS[item.status]}</span></div>
              <p className="q-fail">{item.failureKind ? FAILURE_KIND_LABELS[item.failureKind] : (item.failureMessage ?? "理由は記録されていません")} — {item.status === "AUTH_REQUIRED" ? "VPSでChatGPTに再ログインしてから、記事を開いて「再解析」を押してください" : "記事を開いて「再解析」を押すと積み直せます"}</p>
            </li>)}
          </ol>}
        </section>

        <section className="q-panel">
          <div className="q-head"><h2>最近完了</h2><small>直近{RECENT_COMPLETED_LIMIT}件</small></div>
          {detail.recentCompleted.length === 0 ? <p className="q-empty">まだ解析を終えた記事はありません。</p> : <ol className="q-rows">
            {detail.recentCompleted.map((item) => <li className="q-row" key={item.jobId}>
              <span className="chip done q-mark" aria-hidden="true"><i className="dot" /></span>
              <div>
                <Link className="q-title" href={`/dashboard/articles/${item.article.id}`}>{item.article.title}</Link>
                <div className="q-meta"><span>記事</span><span>{item.relevance === "OUT_OF_SCOPE" ? "対象外と判定" : relevanceLabel(businesses, item.relevance ?? item.article.business)}</span>{item.finishedAt && <span>終了 {formatClock(item.finishedAt)}</span>}</div>
              </div>
              <div className="q-side"><span className="chip done">完了</span>{item.durationMs !== null && <span>所要 {formatDuration(item.durationMs)}</span>}</div>
            </li>)}
          </ol>}
        </section>
      </div>

      <aside className="q-col">
        <section className="q-panel">
          <div className="q-head"><h2>実行環境</h2></div>
          <dl className="q-kv">
            <div><dt>実行ホスト</dt><dd>{worker?.host ?? "未接続"}</dd></div>
            <div><dt>状態</dt><dd className={stale ? "q-bad" : "q-ok"}>{worker ? (stale ? "停止中" : "稼働中") : "未接続"}</dd></div>
            <div><dt>認証方式</dt><dd className={worker && worker.codexAuthMode !== "chatgpt" ? "q-bad" : ""}>{worker ? (worker.codexAuthMode === "chatgpt" ? "ChatGPTアカウント" : (worker.codexAuthMode ?? "不明")) : "—"}</dd></div>
            <div><dt>Codex</dt><dd>{worker?.codexVersion ?? "—"}</dd></div>
            <div><dt>最終応答</dt><dd>{worker ? `${formatElapsed(worker.lastSeenAt, now)}（${formatClock(worker.lastSeenAt)}）` : "—"}</dd></div>
            <div><dt>直近のエラー</dt><dd className={worker?.lastError ? "q-bad" : ""}>{worker?.lastError ?? "なし"}</dd></div>
          </dl>
          <p className="q-hint">最終応答から{WORKER_STALE_MINUTES}分以上たつと「停止中」と表示します。</p>
        </section>
        <section className="q-panel">
          <div className="q-head"><h2>今日の実績</h2></div>
          <dl className="q-kv">
            <div><dt>完了</dt><dd>{detail.today.completed}件</dd></div>
            <div><dt>失敗・認証待ち</dt><dd>{detail.today.failed}件</dd></div>
            <div><dt>平均所要時間</dt><dd>{detail.today.averageDurationMs !== null ? formatDuration(detail.today.averageDurationMs) : "—"}</dd></div>
          </dl>
        </section>
        <section className="q-panel">
          <div className="q-head"><h2>自動収集</h2><small>Web検索で集めるニュース。直近{COLLECTION_JOB_LIMIT}回</small></div>
          {collectionJobs.length === 0 ? <p className="q-empty">まだ実行されていません。日次収集のあとに積まれます。</p> : collectionJobs.map((job) => <div className="cs-job" key={job.id}>
            <div className="q-meta">
              <span className={`chip ${ANALYSIS_STATUS_CLASS[job.status]}`}>{ANALYSIS_STATUS_LABELS[job.status]}</span>
              <span>{formatDateTime(job.queuedAt)}</span>
              {job.durationMs !== null && <span>所要 {formatDuration(job.durationMs)}</span>}
            </div>
            {job.counts && <p className="q-hint">Codexが返した{job.counts.found}件 → 新規 {job.counts.inserted}・統合更新 {job.counts.merged}・既存と重複 {job.counts.duplicate}・上限で除外 {job.counts.excluded}{job.counts.dropped > 0 && `・読めず除外 ${job.counts.dropped}`}</p>}
            {job.searchReport && <div className="q-hint">
              <p>確認地域: {job.searchReport.checkedRegions.join("・") || "記録なし"} ／ 情報源: {job.searchReport.checkedSources.join("・") || "記録なし"}</p>
              <p>検索テーマ: {job.searchReport.checkedThemes.join("・") || "記録なし"}</p>
              <p>{businesses.map((def) => `${def.shortLabel} ${job.searchReport!.businessCounts.filter((item) => normalizeBusinessKey(businesses, item.business) === def.key).reduce((sum, item) => sum + item.count, 0)}件`).join("・")}・海外 {job.searchReport.overseasCount}件・SNS {job.searchReport.snsCount}件</p>
              <p>種別: {job.searchReport.informationTypeCounts.map((item) => `${item.informationType} ${item.count}件`).join("・") || "なし"}</p>
            </div>}
            {(job.status === "FAILED" || job.status === "AUTH_REQUIRED") && <p className="q-fail">{job.failureKind ? FAILURE_KIND_LABELS[job.failureKind] : (job.failureMessage ?? "理由は記録されていません")}{job.status === "AUTH_REQUIRED" && " — VPSでChatGPTに再ログインしてください"}</p>}
          </div>)}
          <p className="q-hint">0件でも完了記録を残します。収集件数は採用・不採用を判断するための目安で、関連性の低い情報で埋めません。</p>
        </section>
      </aside>
    </div>
  </section>;
}
