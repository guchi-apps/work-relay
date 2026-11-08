import { prisma } from "@/lib/db";
import { tokenColumns, type TokenUsage } from "@/lib/ai-usage";
import { canAcceptReport, classifyFailure, isDuplicateJobError, leaseExpiresAtForSlot, truncateFailureMessage, type FailureKindValue, type FailureSignal, type JobStatusValue } from "@/lib/analysis-job-rules";
import { importWeeklyReport, type WeeklyReportArticle } from "@/lib/collection";
import { getBusinesses, businessKeys } from "@/lib/businesses";
import { buildCollectionSearchPrompt, buildCollectionSearchSchema, COLLECTION_SEARCH_TIMEOUT_SECONDS, parseCollectionSearchPayload, type CollectionSearchPolicyContext } from "@/lib/collection-search-prompt";
import { formatIsoDate } from "@/lib/jst-week";
import { getWeekRange } from "@/lib/jst-week";
import { weekCondition } from "@/lib/industry-information";
import { getCollectionSearchPolicies, saveCollectionSearchPolicy } from "@/lib/collection-search-settings";
import { notifyNewCandidates } from "@/lib/aide-bot-notice";

/**
 * 業界ニュースの「収集ジョブ」（Codex CLIのWeb検索）。
 *
 * ChatGPTの定期タスクが担っていた「検索・選定・要約・示唆付与」を、記事解析（#79）・週の総括
 * （#110）と**同じポーラー**（VPS常駐の`scripts/codex-analysis-worker.mjs`）で実行する。
 * claimの応答へこのジョブを混ぜ、reportをジョブIDで振り分けるだけで動く。
 *
 * 結果は`importWeeklyReport()`（AIDE経由の週報登録と同じ取り込み口）へ渡す。URL一致の冪等性・
 * 同一イベントの統合・週あたり上限は、その先の`upsertIndustryInformationEvent()`が持つ。
 *
 * ChatGPT定期タスクとは**併用して品質を見比べる**前提のため、重複の除外や既登録記事の
 * 受け渡しはしていない（`buildCollectionSearchPrompt()`の注記）。テーブルを分けた理由は
 * `ArticleAnalysisJob`と同じ。
 */

// --- ジョブの投入 ---------------------------------------------------------------------

export type EnqueueCollectionSearchResult = { ok: true; jobId: string } | { ok: false; reason: "already_queued" };

/**
 * 収集ジョブを積む。同じ日（JST）の収集が待ち・実行中の間は積まない。
 *
 * 判定はアプリ側の事前チェックではなく`activeKey`のUNIQUE制約で行う（日次のcronと画面からの
 * 手動実行が重なっても、DBが1本に絞る）。終了時に`activeKey`をnullへ戻すので、完了後の
 * 手動の再実行は積める。
 */
export async function enqueueCollectionSearch(requestedBy: string | null, now = new Date()): Promise<EnqueueCollectionSearchResult> {
  try {
    const job = await prisma.collectionSearchJob.create({ data: { activeKey: formatIsoDate(now), requestedBy }, select: { id: true } });
    return { ok: true, jobId: job.id };
  } catch (error) {
    if (isDuplicateJobError(error)) return { ok: false, reason: "already_queued" };
    throw error;
  }
}

// --- ジョブの取得（ポーラー向け）-------------------------------------------------------

export type ClaimedCollectionSearchJob = {
  jobId: string;
  label: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
  leaseExpiresAt: string;
  /** ポーラーがこのジョブに使う実行上限（秒）。既定の記事1件ぶんより長い。 */
  timeoutSeconds: number;
};

/**
 * 期限切れのRUNNINGをQUEUEDへ戻す（記事解析の`releaseExpiredLeases()`と同じ扱い）。
 * `claimAnalysisJobs()`は取得の枠が残っていなくてもこれを呼ぶ。
 */
export async function releaseExpiredCollectionSearchLeases(now: Date): Promise<void> {
  await prisma.collectionSearchJob.updateMany({
    where: { status: "RUNNING", leaseExpiresAt: { lt: now } },
    data: { status: "QUEUED", startedAt: null, leaseExpiresAt: null, workerHost: null },
  });
}

/**
 * QUEUEDの収集ジョブを取り、プロンプトと出力スキーマを付けて返す。
 *
 * `updateMany`の条件に`status: "QUEUED"`を残しているため、同じジョブを2つのポーラーが同時に
 * 取ろうとしても更新できた側だけが実行する。
 */
export async function claimCollectionSearchJobs(host: string, take: number, now = new Date(), slotOffset = 0): Promise<ClaimedCollectionSearchJob[]> {
  if (take <= 0) return [];

  const candidates = await prisma.collectionSearchJob.findMany({ where: { status: "QUEUED" }, orderBy: { queuedAt: "asc" }, take, select: { id: true } });
  const claimed: ClaimedCollectionSearchJob[] = [];

  for (const candidate of candidates) {
    // 記事解析で先に取ったぶんも含め、実行が始まる順番でリースの期限を決める。
    const leaseExpiresAt = leaseExpiresAtForSlot(now, slotOffset + claimed.length);
    const updated = await prisma.collectionSearchJob.updateMany({ where: { id: candidate.id, status: "QUEUED" }, data: { status: "RUNNING", startedAt: now, leaseExpiresAt, workerHost: host } });
    if (updated.count === 0) continue;
    const policies = await getCollectionSearchPolicies();
    const range = getWeekRange(0, now);
    const businesses = await getBusinesses();
    const context: CollectionSearchPolicyContext = {};
    for (const def of businesses) {
      const [rejected, existing] = await Promise.all([
        prisma.industryInformation.findMany({ where: { business: def.key, reviewedAt: { not: null }, weeklyCandidate: false }, orderBy: { reviewedAt: "desc" }, take: 10, select: { title: true, reviewNote: true } }),
        prisma.industryInformation.findMany({ where: { AND: [{ business: def.key }, weekCondition(range)] }, orderBy: { collectedAt: "desc" }, take: 30, select: { title: true, summary: true, normalizedUrl: true } }),
      ]);
      context[def.key] = {
        policy: policies[def.key].policy,
        instruction: policies[def.key].pendingInstruction,
        rejectedArticles: rejected.map((item) => ({ title: item.title, reason: item.reviewNote })),
        existingArticles: existing.map((item) => ({ title: item.title, summary: item.summary, url: item.normalizedUrl })),
      };
    }
    claimed.push({
      jobId: candidate.id,
      label: `${formatIsoDate(now)} の業界ニュース収集`,
      prompt: buildCollectionSearchPrompt(now, context, businesses),
      outputSchema: buildCollectionSearchSchema(businesses),
      leaseExpiresAt: leaseExpiresAt.toISOString(),
      timeoutSeconds: COLLECTION_SEARCH_TIMEOUT_SECONDS,
    });
  }
  return claimed;
}

// --- 結果の返却（ポーラー向け） ---------------------------------------------------------

export type ReportCollectionSearchInput =
  | { jobId: string; host: string; status: "completed"; result: unknown; model: string | null; codexAuthMode: string | null; durationMs: number | null; usage?: TokenUsage | null }
  | ({ jobId: string; host: string; status: "failed"; codexAuthMode: string | null; durationMs: number | null } & Omit<FailureSignal, "codexAuthMode">);

export type ReportCollectionSearchResult = { ok: true; status: JobStatusValue } | { ok: false; reason: "not_found" | "not_running" };

type FailureFields = { failureKind: FailureKindValue; failureMessage: string };

async function finishFailed(jobId: string, status: "FAILED" | "AUTH_REQUIRED", now: Date, failure: FailureFields, extra: { codexAuthMode?: string | null; durationMs?: number | null } = {}): Promise<void> {
  await prisma.collectionSearchJob.update({ where: { id: jobId }, data: { status, finishedAt: now, activeKey: null, leaseExpiresAt: null, ...failure, ...extra } });
}

/**
 * ポーラーからの収集結果を保存し、取り込む。記事解析の`reportAnalysisResult()`と同じ流れ。
 *
 * **取り込んでからジョブを完了にする。** 取り込みの途中でプロセスが落ちても、ジョブは
 * `RUNNING`のまま残ってリース切れで積み直され、再取り込みはURL一致の冪等性で二重登録にならない。
 */
export async function reportCollectionSearchResult(input: ReportCollectionSearchInput, now = new Date()): Promise<ReportCollectionSearchResult> {
  const job = await prisma.collectionSearchJob.findUnique({ where: { id: input.jobId }, select: { id: true, status: true, startedAt: true, workerHost: true } });
  if (!job) return { ok: false, reason: "not_found" };
  // 期限切れで一度QUEUEDへ戻ったジョブへ、遅れて届いた結果は捨てる（次の実行が正になる）。
  if (!canAcceptReport(job.status, job.workerHost, input.host)) return { ok: false, reason: "not_running" };

  if (input.status === "failed") {
    const classification = classifyFailure({ exitCode: input.exitCode, stderrTail: input.stderrTail, codexAuthMode: input.codexAuthMode, timedOut: input.timedOut });
    await finishFailed(job.id, classification.status, now, { failureKind: classification.failureKind, failureMessage: classification.message }, { codexAuthMode: input.codexAuthMode, durationMs: input.durationMs });
    await prisma.analysisWorker.updateMany({ where: { host: input.host }, data: { lastSeenAt: now, lastError: classification.message } });
    return { ok: true, status: classification.status };
  }

  const businesses = await getBusinesses();
  const parsed = parseCollectionSearchPayload(input.result, businesses);
  if (!parsed.ok) {
    await finishFailed(job.id, "FAILED", now, { failureKind: "INVALID_OUTPUT", failureMessage: truncateFailureMessage(`収集の結果を読み取れませんでした: ${parsed.error}`) }, { codexAuthMode: input.codexAuthMode, durationMs: input.durationMs });
    return { ok: true, status: "FAILED" };
  }

  for (const [business, policy] of Object.entries(parsed.nextPolicies)) await saveCollectionSearchPolicy(business, policy);

  let imported;
  try {
    imported = await importWeeklyReport({
      executedAt: (job.startedAt ?? now).toISOString(),
      targetFrom: getWeekRange(0, now).start.toISOString(),
      targetTo: now.toISOString(),
      articles: parsed.articles satisfies WeeklyReportArticle[],
    });
  } catch (error) {
    // Prismaの生のエラー文は保存・応答へ載せず、サーバーログへ出す（#170）。
    console.error(`収集ジョブの取り込みに失敗しました（job=${job.id}）`, error);
    await finishFailed(job.id, "FAILED", now, { failureKind: "EXECUTION_FAILED", failureMessage: "取り込みに失敗しました（サーバーログを確認してください）" }, { codexAuthMode: input.codexAuthMode, durationMs: input.durationMs });
    return { ok: true, status: "FAILED" };
  }

  await prisma.collectionSearchJob.update({
    where: { id: job.id },
    data: {
      status: "COMPLETED",
      finishedAt: now,
      activeKey: null,
      leaseExpiresAt: null,
      failureKind: null,
      failureMessage: null,
      collectionRunId: imported.runId,
      foundCount: parsed.found,
      droppedCount: parsed.dropped,
      insertedCount: imported.insertedCount,
      mergedCount: imported.mergedCount,
      duplicateCount: imported.duplicateCount,
      excludedCount: imported.excludedCount,
      model: input.model,
      codexAuthMode: input.codexAuthMode,
      durationMs: input.durationMs,
      ...tokenColumns(input.usage),
      searchReport: {
        checkedRegions: parsed.searchReport.checkedRegions,
        checkedSources: parsed.searchReport.checkedSources,
        checkedThemes: parsed.searchReport.checkedThemes,
        businessCounts: businessKeys(businesses).map((business) => ({ business, count: parsed.articles.filter((article) => article.business === business).length })),
        informationTypeCounts: [...new Set(parsed.articles.map((article) => article.informationType))].map((informationType) => ({ informationType, count: parsed.articles.filter((article) => article.informationType === informationType).length })),
        overseasCount: parsed.articles.filter((article) => article.informationType === "OVERSEAS_CASE" || article.region !== null && article.region !== "日本").length,
        snsCount: parsed.articles.filter((article) => article.informationType === "SOCIAL_TREND").length,
      },
    },
  });
  // cron起点のRSS通知と同じ週のdedupeKeyで上書きする。Codexの検索・統合結果を確定値として
  // 0件の場合もAIDE Botへ残すため、通知失敗はこの完了記録へ影響させない。
  await notifyNewCandidates(imported, "https://research-desk.gucchii.com/dashboard/analysis");
  await prisma.analysisWorker.updateMany({ where: { host: input.host }, data: { lastSeenAt: now, lastError: null } });
  return { ok: true, status: "COMPLETED" };
}

// --- 解析状況画面向けの一覧 -------------------------------------------------------------

/** 解析状況画面（#137）の「自動収集」欄に出す、収集ジョブ1件。 */
export type CollectionSearchJobView = {
  id: string;
  status: JobStatusValue;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  leaseExpiresAt: Date | null;
  workerHost: string | null;
  failureKind: FailureKindValue | null;
  failureMessage: string | null;
  /** 完了したときだけ入る。Codexが返した件数・読めずに落とした件数・取り込みの内訳。 */
  counts: { found: number; dropped: number; inserted: number; merged: number; duplicate: number; excluded: number } | null;
  durationMs: number | null;
  searchReport: { checkedRegions: string[]; checkedSources: string[]; checkedThemes: string[]; businessCounts: { business: string; count: number }[]; informationTypeCounts: { informationType: string; count: number }[]; overseasCount: number; snsCount: number } | null;
};

/** 直近の収集ジョブ（待ち・実行中も含む）。1日1本が基本なので少数で足りる。 */
export async function listRecentCollectionSearchJobs(limit: number): Promise<CollectionSearchJobView[]> {
  const jobs = await prisma.collectionSearchJob.findMany({
    orderBy: { queuedAt: "desc" },
    take: limit,
    select: {
      id: true,
      status: true,
      queuedAt: true,
      startedAt: true,
      finishedAt: true,
      leaseExpiresAt: true,
      workerHost: true,
      failureKind: true,
      failureMessage: true,
      foundCount: true,
      droppedCount: true,
      insertedCount: true,
      mergedCount: true,
      duplicateCount: true,
      excludedCount: true,
      durationMs: true,
      searchReport: true,
    },
  });
  return jobs.map((job) => ({
    id: job.id,
    status: job.status,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    leaseExpiresAt: job.leaseExpiresAt,
    workerHost: job.workerHost,
    failureKind: job.failureKind,
    failureMessage: job.failureMessage,
    counts:
      job.status === "COMPLETED"
        ? { found: job.foundCount ?? 0, dropped: job.droppedCount ?? 0, inserted: job.insertedCount ?? 0, merged: job.mergedCount ?? 0, duplicate: job.duplicateCount ?? 0, excluded: job.excludedCount ?? 0 }
        : null,
    durationMs: job.durationMs,
    searchReport: isSearchReport(job.searchReport),
  }));
}

function isSearchReport(value: unknown): CollectionSearchJobView["searchReport"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const strings = (item: unknown) => Array.isArray(item) ? item.filter((entry): entry is string => typeof entry === "string") : [];
  const counts = (item: unknown, key: string) => Array.isArray(item) ? item.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>)[key] === "string" && typeof (entry as Record<string, unknown>).count === "number").map((entry) => ({ [key]: entry[key] as string, count: entry.count as number })) : [];
  return {
    checkedRegions: strings(record.checkedRegions), checkedSources: strings(record.checkedSources), checkedThemes: strings(record.checkedThemes),
    businessCounts: counts(record.businessCounts, "business") as { business: string; count: number }[],
    informationTypeCounts: counts(record.informationTypeCounts, "informationType") as { informationType: string; count: number }[],
    overseasCount: typeof record.overseasCount === "number" ? record.overseasCount : 0,
    snsCount: typeof record.snsCount === "number" ? record.snsCount : 0,
  };
}
