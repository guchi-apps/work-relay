import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import AnalysisReviewForm from "@/components/AnalysisReviewForm";
import ArticleAnalysisActions from "@/components/ArticleAnalysisActions";
import ArticleMailButton from "@/components/ArticleMailButton";
import HeaderUserMenu from "@/components/HeaderUserMenu";
import { ANALYSIS_STATUS_CLASS, ANALYSIS_STATUS_LABELS, FAILURE_KIND_LABELS, formatConfidence, formatElapsed, IMPORTANCE_LABELS, relevanceLabel, toDuplicates, toRelatedFindings } from "@/lib/analysis-display";
import { getAnalysisOverview, getArticleDetail } from "@/lib/article-analysis";
import { getCurrentUser } from "@/lib/auth";
import { getBusinesses } from "@/lib/businesses";
import { formatDate, formatDateTime, formatMetrics, toStringArray } from "@/lib/industry-information";
import { toNewsMailArticleDto } from "@/lib/news-mail-articles";
import { getTriageState } from "@/lib/triage";

// 解析の状態は押した直後に変わるため、毎リクエストでDBを読む。
export const dynamic = "force-dynamic";

/**
 * 記事詳細画面（#79）。
 *
 * AI解析の全項目（判定理由・信頼度・要約・全文要約・発表日／地域／主要数値・示唆・重複候補・
 * 関連情報）と、人が事業区分・重要度・週報候補への採否を確定する欄をここに集める。一覧の
 * カードには収まらない量のため画面を分けた。
 */
export default async function ArticleDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getCurrentUser();
  if (user.status === "unavailable") return <section className="content"><div className="empty-state"><p>認証状態を確認できませんでした。しばらくしてから再読み込みしてください。</p></div></section>;
  if (user.status === "unauthenticated") redirect("/login");

  const { id } = await params;
  // 共有した記事の登録後（`?mail=1`）は、メール送信シートを開いた状態で始める（#385）。
  const openMail = (await searchParams).mail === "1";
  const [article, overview, businesses] = await Promise.all([getArticleDetail(id), getAnalysisOverview(), getBusinesses()]);
  if (!article) notFound();

  const analysis = article.analyses[0] ?? null;
  const job = article.analysisJobs[0] ?? null;
  const status = article.analysisStatus;
  const reviewed = article.reviewedAt !== null;
  const regions = toStringArray(analysis?.regions ?? null);
  const duplicates = toDuplicates(analysis?.duplicates ?? null);
  const relatedFindings = toRelatedFindings(analysis?.relatedFindings ?? null);
  // 確定欄の初期値は「いまの実効値」。週報候補から外れている記事は対象外として開く。
  // 人が採用・不採用を決めた記事は、操作ボタンを上に置かず「人による確定」の上側（右列）へ移す。
  const triage = getTriageState(article);
  const decided = triage === "adopted" || triage === "rejected";
  const actions = <ArticleAnalysisActions articleId={article.id} status={status} triage={triage} showDetailLink={false} />;
  const currentRelevance = article.weeklyCandidate ? article.business : "OUT_OF_SCOPE";

  return <section className="content">
    <Link className="breadcrumb" href="/dashboard">‹　業界ニュースへ戻る</Link>
    <header className="page-header">
      <div>
        <p className="eyebrow">ARTICLE</p>
        <h1>{article.title}</h1>
        <p className="lead">{formatDate(article.publishedAt ?? article.occurredAt ?? article.collectedAt)}　·　{article.sourceName}　·　{article.isPrimarySource ? "一次情報" : "関連記事"}　·　<a href={article.originalUrl} target="_blank" rel="noreferrer">元記事 ↗</a></p>
      </div>
      <div className="top-actions"><ArticleMailButton article={toNewsMailArticleDto(article)} businesses={businesses} defaultOpen={openMail} /><HeaderUserMenu /></div>
    </header>

    <div className="detail-grid">
      <div className="detail-main">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>AI解析結果</h2>
              <p className="sub">
                ChatGPT（VPS上の Codex CLI）
                {analysis ? `　·　${formatDateTime(analysis.createdAt)} 完了` : ""}
                {analysis?.durationMs ? `　·　所要 ${Math.round(analysis.durationMs / 1000)}秒` : ""}
                {job ? `　·　実行 ${job.attempt}回目` : ""}
              </p>
            </div>
            <span className={`chip ${status ? ANALYSIS_STATUS_CLASS[status] : "queued"}`}>{status ? ANALYSIS_STATUS_LABELS[status] : "未解析"}</span>
          </div>

          {!decided && actions}

          {job && (status === "FAILED" || status === "AUTH_REQUIRED") && <p className={`ai-hint ${status === "FAILED" ? "fail" : ""}`}>
            {job.failureKind ? FAILURE_KIND_LABELS[job.failureKind] : "解析に失敗しました"}
            {job.failureMessage ? `　${job.failureMessage}` : ""}
            {status === "AUTH_REQUIRED" && <>　VPSで <code>codex login status</code> を確認し、<code>codex login</code> でログインし直してから再実行してください。記事データは失われていません。</>}
          </p>}

          {job && status === "COMPLETED" && job.failureMessage && <p className="ai-hint">{job.failureMessage}</p>}

          {!analysis ? (
            <p className="body-text">まだ解析されていません。「AI解析」を押すとVPS上のCodex CLIがChatGPTアカウントで解析します。</p>
          ) : <>
            <div className={`verdict-box ${analysis.relevance === "OUT_OF_SCOPE" ? "out" : ""}`}>
              <div className="verdict-line">
                <strong>{relevanceLabel(businesses, analysis.relevance)}</strong>
                <span className={`by ${reviewed ? "human" : "ai"}`}>{reviewed ? "人が確定済み" : "AI判定"}</span>
                <span className="conf">信頼度 {formatConfidence(analysis.confidence)}</span>
                <span className="conf-bar"><i style={{ width: `${Math.round(analysis.confidence * 100)}%` }} /></span>
              </div>
              <p className="ai-reason">{analysis.reason}</p>
              {analysis.noiseReason && <p className="ai-reason">ノイズ・誤分類の指摘: {analysis.noiseReason}</p>}
            </div>

            <dl className="kv">
              <dt>発表日</dt><dd>{analysis.announcedOn ? formatDate(analysis.announcedOn) : "—"}</dd>
              <dt>対象地域・国</dt><dd>{regions.length ? regions.join("／") : "—"}</dd>
              <dt>主要数値</dt><dd>{formatMetrics(analysis.metrics) ?? "—"}</dd>
              <dt>AI重要度</dt><dd>{IMPORTANCE_LABELS[analysis.importance]}</dd>
            </dl>

            <div className="stack">
              <p className="sub-head">記事要約</p>
              <p className="body-text">{analysis.summary}</p>
            </div>

            <div className="stack">
              <p className="sub-head">全文要約（本文を取得できた範囲）</p>
              <p className="body-text">{analysis.fullSummary ?? "本文が取得できなかったため、全文要約はありません。"}</p>
            </div>

            <div className="stack">
              <p className="sub-head">商品企画・全体設計への示唆</p>
              <p className="body-text">{analysis.implications ?? "—"}</p>
            </div>

            <div className="stack">
              <p className="sub-head">実質的な重複候補（{duplicates.length}件）</p>
              {duplicates.length === 0 ? <p className="body-text">重複候補はありません。</p> : duplicates.map((duplicate, index) => <div className="dup-item" key={index}>
                <p className="t">{duplicate.url ? <a href={duplicate.url} target="_blank" rel="noreferrer">{duplicate.title}</a> : duplicate.title}</p>
                <p className="r">統合理由: {duplicate.reason}</p>
              </div>)}
            </div>

            <div className="stack">
              <p className="sub-head">関連情報の追加調査（{relatedFindings.length}件）</p>
              {relatedFindings.length === 0 ? <p className="body-text">追加で確認できた関連情報はありません。</p> : relatedFindings.map((finding) => <div className="rel-item" key={finding.url}>
                {finding.isPrimarySource && <span className="primary-tag">一次情報</span>}
                <p className="t">{finding.title}{finding.publishedOn ? `（${finding.publishedOn}）` : ""}</p>
                {finding.summary && <p className="r">要約: {finding.summary}</p>}
                {finding.reason && <p className="r">関連理由: {finding.reason}</p>}
                <a href={finding.url} target="_blank" rel="noreferrer">{finding.url}</a>
              </div>)}
            </div>
          </>}
        </section>

        <section className="panel">
          <div className="panel-head"><h2>解析履歴</h2><span className="conf">{article.analysisJobs.length}件</span></div>
          {article.analysisJobs.length === 0 ? <p className="body-text">まだ実行されていません。</p> : <ul className="history">
            {article.analysisJobs.map((entry) => <li key={entry.id}>
              <time>{formatDateTime(entry.finishedAt ?? entry.startedAt ?? entry.queuedAt)}</time>
              <span>
                {ANALYSIS_STATUS_LABELS[entry.status]}
                {entry.failureKind ? `　·　${FAILURE_KIND_LABELS[entry.failureKind]}` : ""}
                {entry.requestedBy ? `　·　要求 ${entry.requestedBy}` : ""}
              </span>
            </li>)}
          </ul>}
        </section>
      </div>

      <aside className="detail-side">
        {decided && <section className="side-panel">{actions}</section>}
        <details className="side-panel accordion">
          <summary><h2>人による確定</h2></summary>
          <AnalysisReviewForm articleId={article.id} businesses={businesses} relevance={currentRelevance} importance={article.importance} weeklyCandidate={article.weeklyCandidate} note={article.reviewNote} />
          {reviewed && <div className="diff">
            <p><b>人が確定した内容</b></p>
            事業区分　{relevanceLabel(businesses, currentRelevance)}{analysis && analysis.relevance !== currentRelevance ? `（AIの判定は ${relevanceLabel(businesses, analysis.relevance)}）` : ""}<br />
            重要度　{IMPORTANCE_LABELS[article.importance]}{analysis && analysis.importance !== article.importance ? `（AIの判定は ${IMPORTANCE_LABELS[analysis.importance]}）` : ""}<br />
            仕分け　{article.weeklyCandidate ? "採用（週報の候補に含める）" : "不採用"}<br />
            {article.reviewedBy ?? "不明"} · {article.reviewedAt ? formatDateTime(article.reviewedAt) : ""}
          </div>}
        </details>

        <details className="side-panel accordion">
          <summary><h2>実行環境</h2></summary>
          <dl className="kv narrow">
            <dt>実行役</dt><dd>{overview.worker ? `${overview.worker.host} の Codex CLI` : "未接続"}</dd>
            <dt>認証方式</dt><dd>{overview.worker?.codexAuthMode === "chatgpt" ? "ChatGPTアカウント" : (overview.worker?.codexAuthMode ?? "不明")}<br /><span className="conf">APIキー認証は使いません</span></dd>
            <dt>最終応答</dt><dd>{overview.worker ? formatElapsed(overview.worker.lastSeenAt) : "—"}</dd>
          </dl>
        </details>
      </aside>
    </div>
  </section>;
}
