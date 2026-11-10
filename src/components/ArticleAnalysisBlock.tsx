import ArticleAnalysisActions from "@/components/ArticleAnalysisActions";
import ArticleMailButton from "@/components/ArticleMailButton";
import { ANALYSIS_STATUS_CLASS, ANALYSIS_STATUS_LABELS, FAILURE_KIND_LABELS, formatConfidence, relevanceLabel } from "@/lib/analysis-display";
import type { BusinessDef } from "@/lib/business-defs";
import { formatDateTime, type IndustryInformationListItem } from "@/lib/industry-information";
import { toNewsMailArticleDto } from "@/lib/news-mail-articles";
import { getTriageState, TRIAGE_CLASS, TRIAGE_LABELS } from "@/lib/triage";

/**
 * 記事カードに付くAI解析ブロック（#79）。
 *
 * 状態（未解析／解析待ち／解析中／完了／失敗／認証待ち）と、完了していれば判定・信頼度・
 * 判定理由を出す。人が確定済みの記事は「人が確定」と表示し、AIの判定と区別できるようにする。
 * 仕分けの状態（未判定／採用／不採用、#94）の札もここに出す。
 */
export default function ArticleAnalysisBlock({
  item,
  businesses,
  hideActionsWhenAdopted = false,
}: {
  item: IndustryInformationListItem;
  businesses: BusinessDef[];
  /** 採用済みの記事で再解析・採用／不採用ボタンを隠す（#395）。仕分け画面（新着記事）では使わない。 */
  hideActionsWhenAdopted?: boolean;
}) {
  const job = item.analysisJobs[0] ?? null;
  const analysis = item.analyses[0] ?? null;
  const status = item.analysisStatus;
  const reviewed = item.reviewedAt !== null;
  const triage = getTriageState(item);

  return (
    <div className="ai-block">
      <div className="ai-row">
        <span className="ai-label">AI解析</span>
        {status === null ? (
          <span className="chip queued">未解析</span>
        ) : (
          <span className={`chip ${ANALYSIS_STATUS_CLASS[status]}`}>
            <i className="dot" />
            {ANALYSIS_STATUS_LABELS[status]}
            {status === "COMPLETED" && item.analyzedAt ? ` ${formatDateTime(item.analyzedAt)}` : ""}
          </span>
        )}
        {analysis && <span className="verdict">{relevanceLabel(businesses, analysis.relevance)}</span>}
        {analysis && <span className="conf">信頼度 {formatConfidence(analysis.confidence)}</span>}
        {analysis && <span className={`by ${reviewed ? "human" : "ai"}`}>{reviewed ? "人が確定" : "AI判定"}</span>}
        <span className={`chip ${TRIAGE_CLASS[triage]}`}>{TRIAGE_LABELS[triage]}</span>
        <ArticleAnalysisActions articleId={item.id} status={status} triage={triage} hideActions={hideActionsWhenAdopted && triage === "adopted"} />
        <ArticleMailButton article={toNewsMailArticleDto(item)} businesses={businesses} />
      </div>
      {analysis && <p className="ai-reason">判定理由: {analysis.relevance === "OUT_OF_SCOPE" ? (analysis.noiseReason ?? analysis.reason) : analysis.reason}</p>}
      {job && (status === "FAILED" || status === "AUTH_REQUIRED") && (
        <p className={`ai-hint ${status === "FAILED" ? "fail" : ""}`}>
          {job.failureKind ? FAILURE_KIND_LABELS[job.failureKind] : "解析に失敗しました"}
          {job.failureMessage ? `　${job.failureMessage}` : ""}
          {status === "AUTH_REQUIRED" && <>　VPSで <code>codex login status</code> を確認し、<code>codex login</code> でログインし直すと、この記事はそのまま再実行できます。記事データは失われていません。</>}
        </p>
      )}
      {job && status === "COMPLETED" && job.failureMessage && <p className="ai-hint">{job.failureMessage}</p>}
      {status === "RUNNING" && <p className="ai-reason">VPS上で実行中です。完了するまで「AI解析」は押せません（同じ記事の二重実行を防ぐため）。</p>}
    </div>
  );
}
