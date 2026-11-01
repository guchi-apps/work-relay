import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { canAcceptReport, classifyFailure, isDuplicateJobError, LEASE_SECONDS, truncateFailureMessage, type FailureSignal, type JobStatusValue } from "@/lib/analysis-job-rules";
import { formatWeekLabel, getWeekRange, type WeekRange } from "@/lib/jst-week";
import { getBusinesses } from "@/lib/businesses";
import { buildWeeklyBriefPrompt, buildWeeklyBriefSchema, parseWeeklyBriefPayload, toWeeklyBriefTopics, type WeeklyBriefArticle, type WeeklyBriefTopic } from "@/lib/weekly-brief-prompt";
import type { WeekBasisParam } from "@/lib/industry-information";

/**
 * 週報メールの「週の総括」ジョブ（#110）。
 *
 * 記事1件ずつの解析（`src/lib/article-analysis.ts`）と**同じポーラー**（VPS常駐の
 * `scripts/codex-analysis-worker.mjs`）が実行する。ポーラーは`jobId`・`prompt`・`outputSchema`
 * しか見ていないため、claimの応答へ総括ジョブを混ぜ、reportをジョブIDで振り分けるだけで、
 * **ポーラーのスクリプトを配り直さずに**新しい種類のジョブを流せる。
 *
 * テーブルを`ArticleAnalysisJob`と分けたのは、あちらの`articleId`がNOT NULLで記事側の
 * `analysisStatus`とも連動しているため。nullableにして相乗りさせると、記事解析側の前提
 * （claim時の状態更新・リース回収・二重実行防止）が広く崩れる。
 */

/** DBのJSON列から読んだ`articleIds`を配列に戻す。壊れた値は無視する。 */
function toArticleIds(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export type WeeklyBriefBasisValue = "PUBLISHED" | "COLLECTED" | "EITHER";

const BASIS_BY_PARAM: Record<WeekBasisParam, WeeklyBriefBasisValue> = { published: "PUBLISHED", collected: "COLLECTED", either: "EITHER" };

/** 画面向けの総括1件。結果が未完了の間は`headline`・`overview`がnullのまま状態だけを返す。 */
export type WeeklyBriefView = {
  id: string;
  status: JobStatusValue;
  headline: string | null;
  overview: string | null;
  topics: WeeklyBriefTopic[];
  articleIds: string[];
  failureMessage: string | null;
  queuedAt: Date;
  finishedAt: Date | null;
};

function toView(job: {
  id: string;
  status: JobStatusValue;
  headline: string | null;
  overview: string | null;
  topics: Prisma.JsonValue | null;
  articleIds: Prisma.JsonValue;
  failureMessage: string | null;
  queuedAt: Date;
  finishedAt: Date | null;
}): WeeklyBriefView {
  return {
    id: job.id,
    status: job.status,
    headline: job.headline,
    overview: job.overview,
    topics: toWeeklyBriefTopics(job.topics),
    articleIds: toArticleIds(job.articleIds),
    failureMessage: job.failureMessage,
    queuedAt: job.queuedAt,
    finishedAt: job.finishedAt,
  };
}

// --- ジョブの投入 ---------------------------------------------------------------------

export type EnqueueBriefResult = { ok: true; jobId: string } | { ok: false; reason: "already_queued" | "no_articles" };

/** 総括の対象記事の上限。プロンプトが長くなり過ぎないよう、メール1通の上限と同じ数で切る。 */
export const MAX_BRIEF_ARTICLES = 60;

/**
 * 週の総括ジョブを積む。
 *
 * 同じ週の総括が走っている間は積まない。判定はアプリ側の事前チェックではなく`activeKey`の
 * UNIQUE制約で行う（PM2の複数プロセスから同時に押されても、DBが1本に絞る）。
 */
export async function enqueueWeeklyBrief(input: { weekOffset: number; basis: WeekBasisParam; articleIds: string[]; requestedBy: string | null }, now = new Date()): Promise<EnqueueBriefResult> {
  const articleIds = [...new Set(input.articleIds)].slice(0, MAX_BRIEF_ARTICLES);
  if (articleIds.length === 0) return { ok: false, reason: "no_articles" };

  const range = getWeekRange(input.weekOffset, now);
  try {
    const job = await prisma.weeklyBriefJob.create({
      data: {
        weekStart: range.start,
        weekEnd: range.end,
        basis: BASIS_BY_PARAM[input.basis],
        articleIds,
        // 同じ週の総括は同時に1本。基準（`basis`）は含めない——同じ週で基準だけ違う総括を
        // 並行して走らせても、画面が使うのは最新の1件だけなので枠を食い合うだけになる。
        activeKey: range.start.toISOString(),
        requestedBy: input.requestedBy,
      },
      select: { id: true },
    });
    return { ok: true, jobId: job.id };
  } catch (error) {
    if (isDuplicateJobError(error)) return { ok: false, reason: "already_queued" };
    throw error;
  }
}

/** その週の最新の総括（実行中のものも含む）。画面はこれ1件だけを見る。 */
export async function getLatestWeeklyBrief(weekOffset: number, now = new Date()): Promise<WeeklyBriefView | null> {
  const range = getWeekRange(weekOffset, now);
  const job = await prisma.weeklyBriefJob.findFirst({
    where: { weekStart: range.start },
    orderBy: { queuedAt: "desc" },
    select: { id: true, status: true, headline: true, overview: true, topics: true, articleIds: true, failureMessage: true, queuedAt: true, finishedAt: true },
  });
  return job ? toView(job) : null;
}

/** 解析状況画面（#137）に出す、待ち・実行中の総括1件。 */
export type ActiveWeeklyBriefJob = { id: string; status: "QUEUED" | "RUNNING"; label: string; articleCount: number; queuedAt: Date; startedAt: Date | null; leaseExpiresAt: Date | null; workerHost: string | null };

/** 待ち・実行中の総括。同じ週は同時に1本なので件数は多くならない。 */
export async function listActiveWeeklyBriefJobs(): Promise<ActiveWeeklyBriefJob[]> {
  const jobs = await prisma.weeklyBriefJob.findMany({
    where: { status: { in: ["QUEUED", "RUNNING"] } },
    orderBy: { queuedAt: "asc" },
    select: { id: true, status: true, weekStart: true, weekEnd: true, articleIds: true, queuedAt: true, startedAt: true, leaseExpiresAt: true, workerHost: true },
  });
  return jobs.map((job) => ({
    id: job.id,
    status: job.status === "RUNNING" ? "RUNNING" : "QUEUED",
    label: `${formatWeekLabel({ start: job.weekStart, end: job.weekEnd })} の週の総括`,
    articleCount: toArticleIds(job.articleIds).length,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    leaseExpiresAt: job.leaseExpiresAt,
    workerHost: job.workerHost,
  }));
}

// --- ジョブの取得（ポーラー向け）-------------------------------------------------------

export type ClaimedBriefJob = { jobId: string; label: string; prompt: string; outputSchema: Record<string, unknown>; leaseExpiresAt: string };

/**
 * 期限切れのRUNNINGをQUEUEDへ戻す（記事解析の`releaseExpiredLeases()`と同じ扱い）。
 *
 * **`claimAnalysisJobs()`は取得の枠が残っていなくてもこれを呼ぶ。** 記事の解析だけで枠が
 * 埋まっている間に総括ジョブの回収が止まると、ポーラーの停止・VPSの再起動で落ちた総括が
 * `RUNNING`のまま残り、`activeKey`のUNIQUEで積み直すこともできなくなる（画面には「生成中」が
 * 出続け、人が直す手段が無い）。
 */
export async function releaseExpiredWeeklyBriefLeases(now: Date): Promise<void> {
  await prisma.weeklyBriefJob.updateMany({
    where: { status: "RUNNING", leaseExpiresAt: { lt: now } },
    data: { status: "QUEUED", startedAt: null, leaseExpiresAt: null, workerHost: null },
  });
}

/**
 * QUEUEDの総括ジョブを取り、プロンプトと出力スキーマを付けて返す。
 *
 * `updateMany`の条件に`status: "QUEUED"`を残しているため、同じジョブを2つのポーラーが同時に
 * 取ろうとしても更新できた側だけが実行する。
 */
export async function claimWeeklyBriefJobs(host: string, take: number, now = new Date()): Promise<ClaimedBriefJob[]> {
  if (take <= 0) return [];

  const candidates = await prisma.weeklyBriefJob.findMany({ where: { status: "QUEUED" }, orderBy: { queuedAt: "asc" }, take, select: { id: true } });
  const leaseExpiresAt = new Date(now.getTime() + LEASE_SECONDS * 1000);
  const claimed: ClaimedBriefJob[] = [];

  for (const candidate of candidates) {
    const updated = await prisma.weeklyBriefJob.updateMany({ where: { id: candidate.id, status: "QUEUED" }, data: { status: "RUNNING", startedAt: now, leaseExpiresAt, workerHost: host } });
    if (updated.count === 0) continue;

    const job = await prisma.weeklyBriefJob.findUnique({ where: { id: candidate.id }, select: { weekStart: true, weekEnd: true, articleIds: true } });
    if (!job) continue;

    const range: WeekRange = { start: job.weekStart, end: job.weekEnd };
    claimed.push({
      jobId: candidate.id,
      label: `${formatWeekLabel(range)} の週報総括`,
      prompt: buildWeeklyBriefPrompt(range, await loadBriefArticles(toArticleIds(job.articleIds)), await getBusinesses()),
      outputSchema: buildWeeklyBriefSchema(),
      leaseExpiresAt: leaseExpiresAt.toISOString(),
    });
  }
  return claimed;
}

/**
 * 総括の対象記事を読む。AI解析が済んでいれば**その要約・示唆**を優先して渡す——
 * 登録時の要約より内容が濃く、総括の材料として適しているため。
 */
async function loadBriefArticles(articleIds: string[]): Promise<WeeklyBriefArticle[]> {
  if (articleIds.length === 0) return [];
  const articles = await prisma.industryInformation.findMany({
    where: { id: { in: articleIds } },
    orderBy: [{ business: "asc" }, { importance: "asc" }, { publishedAt: "desc" }],
    select: {
      title: true,
      business: true,
      sourceName: true,
      isPrimarySource: true,
      importance: true,
      publishedAt: true,
      collectedAt: true,
      summary: true,
      implications: true,
      analyses: { orderBy: { createdAt: "desc" }, take: 1, select: { summary: true, implications: true } },
    },
  });
  return articles.map((article) => ({
    title: article.title,
    business: article.business,
    sourceName: article.sourceName,
    isPrimarySource: article.isPrimarySource,
    importance: article.importance,
    publishedAt: article.publishedAt,
    collectedAt: article.collectedAt,
    summary: article.analyses[0]?.summary ?? article.summary,
    implications: article.analyses[0]?.implications ?? article.implications,
  }));
}

// --- 結果の返却（ポーラー向け） ---------------------------------------------------------

export type ReportBriefInput =
  | { jobId: string; host: string; status: "completed"; result: unknown; model: string | null; codexAuthMode: string | null; durationMs: number | null }
  | ({ jobId: string; host: string; status: "failed"; codexAuthMode: string | null; durationMs: number | null } & Omit<FailureSignal, "codexAuthMode">);

export type ReportBriefResult = { ok: true; status: JobStatusValue } | { ok: false; reason: "not_found" | "not_running" };

/** ポーラーからの総括の結果を保存する。記事解析の`reportAnalysisResult()`と同じ流れ。 */
export async function reportWeeklyBriefResult(input: ReportBriefInput, now = new Date()): Promise<ReportBriefResult> {
  const job = await prisma.weeklyBriefJob.findUnique({ where: { id: input.jobId }, select: { id: true, status: true } });
  if (!job) return { ok: false, reason: "not_found" };
  if (!canAcceptReport(job.status)) return { ok: false, reason: "not_running" };

  if (input.status === "failed") {
    const classification = classifyFailure({ exitCode: input.exitCode, stderrTail: input.stderrTail, codexAuthMode: input.codexAuthMode, timedOut: input.timedOut });
    await finishBriefJob(job.id, classification.status, now, { failureKind: classification.failureKind, failureMessage: classification.message });
    await prisma.analysisWorker.updateMany({ where: { host: input.host }, data: { lastSeenAt: now, lastError: classification.message } });
    return { ok: true, status: classification.status };
  }

  const parsed = parseWeeklyBriefPayload(input.result);
  if (!parsed.ok) {
    const message = truncateFailureMessage(`総括の結果を読み取れませんでした: ${parsed.error}`);
    await finishBriefJob(job.id, "FAILED", now, { failureKind: "INVALID_OUTPUT", failureMessage: message });
    return { ok: true, status: "FAILED" };
  }

  await prisma.weeklyBriefJob.update({
    where: { id: job.id },
    data: {
      status: "COMPLETED",
      finishedAt: now,
      activeKey: null,
      leaseExpiresAt: null,
      failureKind: null,
      failureMessage: null,
      headline: parsed.value.headline,
      overview: parsed.value.overview,
      topics: parsed.value.topics as unknown as Prisma.InputJsonValue,
      model: input.model,
      codexAuthMode: input.codexAuthMode,
      durationMs: input.durationMs,
    },
  });
  await prisma.analysisWorker.updateMany({ where: { host: input.host }, data: { lastSeenAt: now, lastError: null } });
  return { ok: true, status: "COMPLETED" };
}

async function finishBriefJob(jobId: string, status: "FAILED" | "AUTH_REQUIRED", now: Date, failure: { failureKind: "AUTH_REQUIRED" | "RATE_LIMITED" | "INVALID_OUTPUT" | "EXECUTION_FAILED" | "TIMEOUT"; failureMessage: string }): Promise<void> {
  await prisma.weeklyBriefJob.update({ where: { id: jobId }, data: { status, finishedAt: now, activeKey: null, leaseExpiresAt: null, ...failure } });
}
