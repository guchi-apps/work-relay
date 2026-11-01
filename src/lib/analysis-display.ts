/**
 * AI解析（#79）の表示用のラベル。サーバーコンポーネントとクライアントコンポーネントの
 * 両方から読むため、Prisma・DBに触れない純粋な定義だけを置く。
 */

import type { Prisma } from "@prisma/client";
import { businessLabel, type BusinessDef } from "@/lib/business-defs";
import type { AnalysisDuplicate, AnalysisImportanceValue, AnalysisRelatedFinding } from "@/lib/analysis-prompt";
import type { FailureKindValue, JobStatusValue } from "@/lib/article-analysis";

/** カードのチップに出す文言。未解析（ジョブが1度も無い状態）はnullで表す。 */
export const ANALYSIS_STATUS_LABELS: Record<JobStatusValue, string> = {
  QUEUED: "解析待ち",
  RUNNING: "解析中",
  COMPLETED: "完了",
  FAILED: "失敗",
  AUTH_REQUIRED: "認証待ち",
};

/** チップの見た目。`globals.css`の`.chip.*`に対応する。 */
export const ANALYSIS_STATUS_CLASS: Record<JobStatusValue, string> = {
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "done",
  FAILED: "failed",
  AUTH_REQUIRED: "auth",
};

/** 判定結果（事業区分のキー／対象外）の表示名。区分名はマスタ（`BusinessDef[]`）から引く。 */
export function relevanceLabel(businesses: readonly BusinessDef[], relevance: string): string {
  return relevance === "OUT_OF_SCOPE" ? "対象外" : businessLabel(businesses, relevance);
}

export const IMPORTANCE_LABELS: Record<AnalysisImportanceValue, string> = { HIGH: "高", MEDIUM: "中", REFERENCE: "参考" };

/** 失敗の理由を、利用者が次に何をすればよいか分かる一行にする。 */
export const FAILURE_KIND_LABELS: Record<FailureKindValue, string> = {
  AUTH_REQUIRED: "ChatGPTのログインが切れています",
  RATE_LIMITED: "ChatGPTの利用枠に達しました",
  INVALID_OUTPUT: "解析結果を読み取れませんでした",
  EXECUTION_FAILED: "Codexの実行に失敗しました",
  TIMEOUT: "解析が時間内に終わりませんでした",
};

/** 信頼度（0〜1）を画面表示用の小数2桁にする。 */
export function formatConfidence(value: number): string {
  return value.toFixed(2);
}

// JSON列（`duplicates`・`relatedFindings`）は保存時に検証済みだが、過去に壊れた値が入っていても
// 画面が落ちないよう、表示側でも形を確かめてから使う（`toMergedSources()`と同じ方針）。

export function toDuplicates(value: Prisma.JsonValue | null): AnalysisDuplicate[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is AnalysisDuplicate => typeof item === "object" && item !== null && typeof (item as AnalysisDuplicate).title === "string" && typeof (item as AnalysisDuplicate).reason === "string");
}

export function toRelatedFindings(value: Prisma.JsonValue | null): AnalysisRelatedFinding[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is AnalysisRelatedFinding => typeof item === "object" && item !== null && typeof (item as AnalysisRelatedFinding).title === "string" && typeof (item as AnalysisRelatedFinding).url === "string");
}

/** ポーラーの「最終応答 ◯分前」。分単位までで十分なので秒は出さない。 */
export function formatElapsed(date: Date, now = new Date()): string {
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}

/** ポーラーが生きているとみなす猶予。これを過ぎたら画面で「停止中」と出す。 */
export const WORKER_STALE_MINUTES = 15;

/** ポーラーが止まっているか（未接続も含む）。帯と解析状況画面（#137）で同じ判定を使う。 */
export function isWorkerStale(worker: { lastSeenAt: Date } | null, now = new Date()): boolean {
  return !worker || now.getTime() - worker.lastSeenAt.getTime() > WORKER_STALE_MINUTES * 60_000;
}

/** `QUEUED`・`RUNNING`の間は二重実行を防ぐため「AI解析」を押せなくする。 */
export function isAnalysisInFlight(status: JobStatusValue | null): boolean {
  return status === "QUEUED" || status === "RUNNING";
}
