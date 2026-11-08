import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { buildFeeds, getBusinesses, zeroCounts, type BusinessDef } from "@/lib/businesses";
import { decideDailyRunStatus, fitsNormalizedUrlColumn } from "@/lib/collection-rules";
import { getWeekRange, weekCondition, toMergedSources, type MergedSource, type WeekRange } from "@/lib/industry-information";
import { decideWeeklyCap, IMPORTANCE_RANK, type ImportanceValue, type PriorityFields } from "@/lib/triage";

// 収集の上限（#94で「1回10件・事業ごと週5件」から広げた）。無関係な記事は新着記事画面の仕分けで
// 人が不採用にする前提なので、取り込みは多めにし、上限の枠には不採用の記事を数えない
// （`decideWeeklyCap()`）。AIDE経由の週報登録の入力上限（1回10件・各事業5件）はAIDE側との
// 契約なので変えていない（`src/app/api/internal/weekly-report/route.ts`）。
export const COLLECTION_LIMIT = 30;
const BUSINESS_WEEKLY_LIMIT = 15;
// 週あたり上限の置換で隠した記事の`updateReason`（業界ニュース画面の「更新理由」に出る）。
const REPLACED_UPDATE_REASON = "週あたり上限のため、優先度の高い記事に置き換えられました（週報候補から外しています）";
const DAY_MS = 24 * 60 * 60 * 1000;
type Business = string;
type InformationType = "NEW_PRODUCT" | "COMPETITOR" | "INTRODUCTION_CASE" | "POLICY_SUBSIDY" | "MARKET_STATISTICS" | "USER_ISSUE" | "QUALITY_SAFETY" | "OVERSEAS_CASE" | "OTHER";
type Candidate = { business: Business; title: string; url: string; sourceName: string; publisher: string | null; publishedAt: Date; isSupplemental: boolean; informationType: InformationType; importance: "HIGH" | "MEDIUM" | "REFERENCE"; keywords: string[]; tags: string[] };
type InformationTypeValue = "NEW_PRODUCT" | "COMPETITOR" | "INTRODUCTION_CASE" | "RECRUITMENT_PARTNERSHIP" | "POLICY_SUBSIDY" | "MARKET_STATISTICS" | "USER_ISSUE" | "CONSTRUCTION" | "QUALITY_SAFETY" | "PATENT" | "ACADEMIC_RESEARCH" | "VIDEO" | "SOCIAL_TREND" | "OVERSEAS_CASE" | "OTHER";

export type CollectionResult = { runId: string; status: "SUCCEEDED" | "PARTIAL" | "FAILED"; targetFrom: string; targetTo: string; supplementalFrom: string; fetchedCount: number; selectedCount: number; insertedCount: number; duplicateCount: number; mergedCount: number; excludedCount: number; failedCount: number; errors: string[] };

type Feed = ReturnType<typeof buildFeeds>[number];

function field(item: string, name: string): string | null {
  const match = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return match?.[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() ?? null;
}

export function normalizeUrl(value: string): string {
  try {
    const url = new URL(value); url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) url.searchParams.delete(key);
    return url.toString().replace(/\/$/, "");
  } catch { return value.trim().replace(/\/$/, ""); }
}

export type WeeklyReportArticle = {
  business: Business;
  informationType: InformationTypeValue;
  title: string;
  url: string;
  sourceName: string;
  publisher?: string | null;
  isPrimarySource?: boolean;
  publishedAt?: string | null;
  occurredAt?: string | null;
  content?: string | null;
  summary?: string | null;
  extractedMetrics?: Prisma.InputJsonValue | null;
  implications?: string | null;
  importance?: ImportanceValue;
  targetCompany?: string | null;
  targetProduct?: string | null;
  region?: string | null;
  keywords?: string[];
  tags?: string[];
  periodScope?: "IN_SCOPE" | "PAST_30_DAYS_SUPPLEMENT";
};

export type WeeklyReportInput = {
  executedAt: string;
  targetFrom: string;
  targetTo: string;
  articles: WeeklyReportArticle[];
};

export type WeeklyReportImportResult = CollectionResult & {
  // insertedCount+mergedCountの事業別内訳（新規追加・既存への統合更新の両方を含む）
  businessCounts: Record<string, number>;
  duplicateBusinessCounts: Record<string, number>;
};

function parseDate(value: string | null | undefined, fieldName: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${fieldName}は有効なISO 8601日時で指定してください`);
  return date;
}

// --- 同一イベント判定・統合更新・週あたり上限（#43） ---------------------------------------

/** イベント統合・週報登録の両経路が共通で扱う入力の形。日時はDateへ変換済みのものを渡す。 */
export type EventArticleInput = {
  business: Business;
  informationType: InformationTypeValue;
  title: string;
  url: string;
  sourceName: string;
  publisher?: string | null;
  isPrimarySource?: boolean;
  publishedAt?: Date | null;
  occurredAt?: Date | null;
  content?: string | null;
  summary?: string | null;
  extractedMetrics?: Prisma.InputJsonValue | null;
  implications?: string | null;
  importance?: ImportanceValue;
  targetCompany?: string | null;
  targetProduct?: string | null;
  region?: string | null;
  keywords?: string[];
  tags?: string[];
  periodScope?: "IN_SCOPE" | "PAST_30_DAYS_SUPPLEMENT";
};

export type UpsertOutcome = "duplicate" | "inserted" | "merged" | "excluded";
export type ExcludedArticle = { business: Business; title: string; url: string; reason: "REPLACED" | "CAPACITY_EXCEEDED"; replacedArticleId?: string; replacedArticleTitle?: string; occurredAt: string };
export type UpsertResult = { outcome: UpsertOutcome; excluded?: ExcludedArticle };

/** タイトルの単語一致率による類似判定。`threshold`を下げるほど緩く同一とみなす
 * （RSS内の重複除去は0.8＝厳格、イベント統合の下地は0.6＝緩め、で使い分ける）。 */
function similarTitle(left: string, right: string, threshold = 0.8): boolean {
  const words = (value: string) => new Set(value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1));
  const leftWords = words(left); const rightWords = words(right);
  if (!leftWords.size || !rightWords.size) return left === right;
  return [...leftWords].filter((word) => rightWords.has(word)).length / Math.min(leftWords.size, rightWords.size) >= threshold;
}

function normalizeKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[\s　,、･・]/g, "");
}

type MatchableFields = {
  business: Business;
  informationType: InformationTypeValue;
  title: string;
  publisher?: string | null;
  sourceName: string;
  targetCompany?: string | null;
  targetProduct?: string | null;
  occurredAt?: Date | null;
  publishedAt?: Date | null;
};

/** 発表主体キー。対象企業→発行元→情報源の優先順で、表記の空白・記号の揺れを丸めて比較する。 */
function announcerKey(item: Pick<MatchableFields, "targetCompany" | "publisher" | "sourceName">): string {
  return normalizeKey(item.targetCompany || item.publisher || item.sourceName);
}

function withinDays(a: Date | null | undefined, b: Date | null | undefined, days: number): boolean {
  return Boolean(a && b && Math.abs(a.getTime() - b.getTime()) <= days * DAY_MS);
}

/**
 * 同一イベント判定（#43）。発表主体が一致し、かつ「対象製品/サービスが一致」または
 * 「タイトルが緩く類似し、発表日が近い（5日以内）か情報区分が一致」する場合に同一とみなす。
 * 呼び出し側は同じ週・同じ事業のレコードだけを`weekPeers`として渡すこと。
 */
export function findEventMatch<T extends MatchableFields & { id: string }>(candidate: MatchableFields, weekPeers: T[]): T | null {
  const candidateAnnouncer = announcerKey(candidate);
  if (!candidateAnnouncer) return null;
  const candidateDate = candidate.occurredAt ?? candidate.publishedAt;
  const candidateProduct = normalizeKey(candidate.targetProduct);
  for (const peer of weekPeers) {
    if (peer.business !== candidate.business || announcerKey(peer) !== candidateAnnouncer) continue;
    const sameProduct = candidateProduct !== "" && candidateProduct === normalizeKey(peer.targetProduct);
    const titleAlike = similarTitle(candidate.title, peer.title, 0.6);
    const closeDate = withinDays(candidateDate, peer.occurredAt ?? peer.publishedAt, 5);
    const sameType = candidate.informationType === peer.informationType;
    if (sameProduct || (titleAlike && (closeDate || sameType))) return peer;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, Prisma.JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 主要数値の統合。両方がオブジェクトなら項目単位でマージ（新しい値で上書き）、そうでなければ丸ごと置き換える。 */
function mergeMetrics(existing: Prisma.JsonValue | null | undefined, incoming: Prisma.InputJsonValue | null | undefined): Prisma.InputJsonValue | undefined {
  if (incoming === null || incoming === undefined) return undefined;
  if (isPlainObject(existing) && isPlainObject(incoming as object)) return { ...existing, ...(incoming as Record<string, Prisma.JsonValue>) };
  return incoming;
}

const CHANGE_LABELS: Partial<Record<keyof EventArticleInput, string>> = {
  extractedMetrics: "主要数値",
  targetProduct: "対象製品・対象地域",
  region: "対象地域",
  targetCompany: "対象企業",
  summary: "要約",
  content: "本文",
  implications: "示唆",
  importance: "重要度",
  publishedAt: "公開日",
  occurredAt: "発生日",
};

type WeekPeer = {
  id: string;
  business: Business;
  informationType: InformationTypeValue;
  title: string;
  publisher: string | null;
  sourceName: string;
  targetCompany: string | null;
  targetProduct: string | null;
  region: string | null;
  occurredAt: Date | null;
  publishedAt: Date | null;
  importance: ImportanceValue;
  isPrimarySource: boolean;
  extractedMetrics: Prisma.JsonValue | null;
  summary: string | null;
  implications: string | null;
  content: string | null;
  mergedSources: Prisma.JsonValue | null;
  normalizedUrl: string;
  // 仕分けの状態（#94）。週あたり上限に数えるか・置き換えてよいかの判定に使う。
  weeklyCandidate: boolean;
  reviewedAt: Date | null;
};

const WEEK_PEER_SELECT = {
  id: true, business: true, informationType: true, title: true, publisher: true, sourceName: true,
  targetCompany: true, targetProduct: true, region: true, occurredAt: true, publishedAt: true, importance: true,
  isPrimarySource: true, extractedMetrics: true, summary: true, implications: true, content: true,
  mergedSources: true, normalizedUrl: true, weeklyCandidate: true, reviewedAt: true,
} satisfies Prisma.IndustryInformationSelect;

/** 既存記事へ統合・上書き更新する。完全に既知の内容（統合元URLが既出かつ変更なし）なら
 * `updateReason`・バッジを動かさず`duplicate`として扱う（同一URLの冪等性と同じ考え方）。 */
async function mergeIntoExisting(existing: WeekPeer, article: EventArticleInput, runId: string, normalizedUrl: string, range: WeekRange): Promise<UpsertOutcome> {
  const data: Record<string, unknown> = {};
  const changed: (keyof EventArticleInput)[] = [];

  const metrics = mergeMetrics(existing.extractedMetrics, article.extractedMetrics);
  if (metrics !== undefined) { data.extractedMetrics = metrics; changed.push("extractedMetrics"); }

  for (const key of ["targetProduct", "targetCompany", "region", "implications", "summary", "content"] as const) {
    const incoming = article[key];
    if (incoming && incoming !== existing[key]) { data[key] = incoming; changed.push(key); }
  }

  if (article.importance && IMPORTANCE_RANK[article.importance] > IMPORTANCE_RANK[existing.importance]) {
    data.importance = article.importance;
    changed.push("importance");
  }

  // occurredAt/publishedAtは、マッチ判定に使った週range内に収まる値だけ反映する。範囲外の日付で
  // 上書きすると記事の表示週が想定外に移動し、既存の週報表示が壊れるため。
  for (const key of ["occurredAt", "publishedAt"] as const) {
    const incoming = article[key];
    if (incoming && incoming >= range.start && incoming < range.end && (!existing[key] || incoming > existing[key]!)) {
      data[key] = incoming;
      changed.push(key);
    }
  }

  const mergedSources = toMergedSources(existing.mergedSources);
  const alreadyKnown = existing.normalizedUrl === normalizedUrl || mergedSources.some((source) => source.normalizedUrl === normalizedUrl);
  if (alreadyKnown && changed.length === 0) return "duplicate";

  const nextMergedSources: MergedSource[] = alreadyKnown ? mergedSources : [...mergedSources, {
    url: article.url, normalizedUrl, sourceName: article.sourceName, publisher: article.publisher ?? null,
    isPrimarySource: article.isPrimarySource ?? false, mergedAt: new Date().toISOString(), collectionRunId: runId,
  }];

  const reason = changed.length
    ? `${[...new Set(changed.map((key) => CHANGE_LABELS[key] ?? key))].join("・")}を更新しました`
    : "同一発表の転載を統合しました（内容に変更はありません）";

  await prisma.industryInformation.update({
    where: { id: existing.id },
    data: {
      ...data,
      mergedSources: nextMergedSources as Prisma.InputJsonValue,
      updateReason: reason,
      updatedByRunId: runId,
      isPrimarySource: existing.isPrimarySource || Boolean(article.isPrimarySource),
    },
  });
  return "merged";
}

function toCreateData(article: EventArticleInput, runId: string, normalizedUrl: string): Prisma.IndustryInformationUncheckedCreateInput {
  return {
    business: article.business,
    informationType: article.informationType,
    title: article.title,
    originalUrl: article.url,
    normalizedUrl,
    urlHash: createHash("sha256").update(normalizedUrl).digest("hex"),
    sourceName: article.sourceName,
    publisher: article.publisher ?? null,
    isPrimarySource: article.isPrimarySource ?? false,
    publishedAt: article.publishedAt ?? null,
    occurredAt: article.occurredAt ?? null,
    content: article.content ?? null,
    summary: article.summary ?? null,
    extractedMetrics: article.extractedMetrics ?? undefined,
    implications: article.implications ?? null,
    importance: article.importance ?? "REFERENCE",
    targetCompany: article.targetCompany ?? null,
    targetProduct: article.targetProduct ?? null,
    region: article.region ?? null,
    keywords: article.keywords ?? [],
    tags: article.tags ?? [],
    periodScope: article.periodScope ?? "IN_SCOPE",
    collectionRunId: runId,
    updatedByRunId: runId,
  };
}

/**
 * 業界情報1件を取り込む（#43）。AIDE経由の週報登録・自動収集の両方がこれ1本を呼ぶ。
 * 1. 完全URL一致は従来どおり冪等（`duplicate`、何も更新しない）
 * 2. 同じ週・同じ事業のレコードから同一イベントを判定し、マッチすれば新規行を作らず統合更新する
 * 3. マッチしなければ新規イベントとして扱い、週あたり上限（事業ごと`BUSINESS_WEEKLY_LIMIT`件）を
 *    適用する（優先度が上回れば最弱の既存記事を週報候補から外して置換、そうでなければ新規候補を除外）。
 *    置換は行を削除しない（AI解析結果と`normalizedUrl`の一意制約を残す。#171）。
 *    上限には不採用の記事を数えず、人が採用した記事は置換で外さない（#94。`decideWeeklyCap()`）。
 *    同一イベント判定（2.）は不採用の記事も含めて行うため、不採用にした発表の転載は不採用の
 *    記事へ統合されたまま隠れ、新しい未判定の記事として出直してこない
 */
export async function upsertIndustryInformationEvent(article: EventArticleInput, runId: string): Promise<UpsertResult> {
  const normalizedUrl = normalizeUrl(article.url);

  const exact = await prisma.industryInformation.findUnique({ where: { normalizedUrl }, select: { id: true } });
  if (exact) return { outcome: "duplicate" };

  const referenceDate = article.occurredAt ?? article.publishedAt ?? new Date();
  const range = getWeekRange(0, referenceDate);
  const weekPeers = await prisma.industryInformation.findMany({
    where: { AND: [{ business: article.business }, weekCondition(range)] },
    select: WEEK_PEER_SELECT,
  });

  const matched = findEventMatch(article, weekPeers);
  if (matched) {
    try {
      const outcome = await mergeIntoExisting(matched, article, runId, normalizedUrl, range);
      return { outcome };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { outcome: "duplicate" };
      throw error;
    }
  }

  let excluded: ExcludedArticle | undefined;
  const candidatePriority: PriorityFields = { importance: article.importance ?? "REFERENCE", isPrimarySource: article.isPrimarySource ?? false, publishedAt: article.publishedAt ?? null };
  const decision = decideWeeklyCap(weekPeers, candidatePriority, BUSINESS_WEEKLY_LIMIT);
  if (decision.action === "replace") {
    const weakest = decision.target;
    excluded = { business: article.business, title: weakest.title, url: weakest.normalizedUrl, reason: "REPLACED", replacedArticleId: weakest.id, replacedArticleTitle: weakest.title, occurredAt: new Date().toISOString() };
    // 削除せず週報候補から外して隠す（#171）。行を消すと`ArticleAnalysis`・`ArticleAnalysisJob`が
    // カスケードで消え（実行中ならポーラーの報告が404になる）、`normalizedUrl`の一意制約も消えて、
    // 翌日のRSSに同じ記事が残っていれば未判定として登録し直される。`reviewedAt`は立てないので
    // 「AIが対象外と判定」（`ai_rejected`）と同じ扱いで、人が「採用」で戻せる
    await prisma.industryInformation.update({
      where: { id: weakest.id },
      data: { weeklyCandidate: false, updateReason: REPLACED_UPDATE_REASON, updatedByRunId: runId },
    });
  } else if (decision.action === "exclude") {
    excluded = { business: article.business, title: article.title, url: normalizedUrl, reason: "CAPACITY_EXCEEDED", occurredAt: new Date().toISOString() };
    return { outcome: "excluded", excluded };
  }

  try {
    await prisma.industryInformation.create({ data: toCreateData(article, runId, normalizedUrl) });
    return { outcome: "inserted", excluded };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { outcome: "duplicate", excluded };
    throw error;
  }
}

// --- AIDE経由の週報登録 -----------------------------------------------------------------

export async function importWeeklyReport(input: WeeklyReportInput): Promise<WeeklyReportImportResult> {
  const targetFrom = parseDate(input.targetFrom, "targetFrom");
  const targetTo = parseDate(input.targetTo, "targetTo");
  if (!targetFrom || !targetTo || targetFrom > targetTo) throw new Error("対象期間が不正です");
  const executedAt = parseDate(input.executedAt, "executedAt");
  if (!executedAt) throw new Error("executedAtは必須です");
  const supplementalFrom = new Date(targetTo.getTime() - 30 * DAY_MS);
  const run = await prisma.collectionRun.create({ data: { startedAt: executedAt, targetFrom, targetTo, supplementalFrom } });
  const errors: string[] = [];
  let insertedCount = 0;
  let duplicateCount = 0;
  let mergedCount = 0;
  let excludedCount = 0;
  const businesses = await getBusinesses();
  const businessCounts = zeroCounts(businesses);
  const duplicateBusinessCounts = zeroCounts(businesses);
  const excludedArticles: ExcludedArticle[] = [];
  const seen = new Set<string>();

  for (const [index, article] of input.articles.entries()) {
    const normalizedUrl = normalizeUrl(article.url);
    if (seen.has(normalizedUrl)) {
      duplicateCount++;
      duplicateBusinessCounts[article.business]++;
      continue;
    }
    seen.add(normalizedUrl);
    try {
      const { outcome, excluded } = await upsertIndustryInformationEvent({
        business: article.business,
        informationType: article.informationType,
        title: article.title,
        url: article.url,
        sourceName: article.sourceName,
        publisher: article.publisher ?? null,
        isPrimarySource: article.isPrimarySource ?? false,
        publishedAt: parseDate(article.publishedAt, `articles[${index}].publishedAt`),
        occurredAt: parseDate(article.occurredAt, `articles[${index}].occurredAt`),
        content: article.content ?? null,
        summary: article.summary ?? null,
        extractedMetrics: article.extractedMetrics ?? undefined,
        implications: article.implications ?? null,
        importance: article.importance ?? "REFERENCE",
        targetCompany: article.targetCompany ?? null,
        targetProduct: article.targetProduct ?? null,
        region: article.region ?? null,
        keywords: article.keywords ?? [],
        tags: article.tags ?? [],
        periodScope: article.periodScope ?? "IN_SCOPE",
      }, run.id);

      if (excluded) { excludedArticles.push(excluded); excludedCount++; }
      if (outcome === "duplicate") { duplicateCount++; duplicateBusinessCounts[article.business]++; }
      else if (outcome === "merged") { mergedCount++; businessCounts[article.business]++; }
      else if (outcome === "inserted") { insertedCount++; businessCounts[article.business]++; }
    } catch (error) {
      errors.push(`ARTICLE_INSERT_FAILED: 記事${index + 1}件目の登録に失敗しました`);
      console.error(`週報登録: 記事の登録に失敗しました（run=${run.id}, index=${index + 1}, url=${article.url}）`, error);
    }
  }
  const status = errors.length > 0 ? (insertedCount + mergedCount > 0 ? "PARTIAL" : "FAILED") : "SUCCEEDED";
  const result = { runId: run.id, status, targetFrom: targetFrom.toISOString(), targetTo: targetTo.toISOString(), supplementalFrom: supplementalFrom.toISOString(), fetchedCount: input.articles.length, selectedCount: input.articles.length, insertedCount, duplicateCount, mergedCount, excludedCount, failedCount: errors.length, errors, businessCounts, duplicateBusinessCounts } as WeeklyReportImportResult;
  await prisma.collectionRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), status, fetchedCount: result.fetchedCount, selectedCount: result.selectedCount, insertedCount, duplicateCount, mergedCount, excludedCount, failedCount: errors.length, errors, excludedArticles: excludedArticles.length ? (excludedArticles as unknown as Prisma.InputJsonValue) : undefined } });
  return result;
}

// --- 自動収集（Google News RSS、日次） ---------------------------------------------------

function classify(title: string, business: BusinessDef): Pick<Candidate, "informationType" | "importance" | "keywords" | "tags"> {
  const text = title.toLowerCase(); const tags = [business.label];
  if (/新商品|発売|新製品|発表/.test(text)) tags.push("新商品");
  if (/導入|採用|提携|設置/.test(text)) tags.push("導入事例");
  if (/補助金|制度|行政/.test(text)) tags.push("制度・補助金");
  const informationType: InformationType = /導入|採用|設置|提携/.test(text) ? "INTRODUCTION_CASE" : /補助金|制度|行政/.test(text) ? "POLICY_SUBSIDY" : /市場|統計|調査/.test(text) ? "MARKET_STATISTICS" : /レビュー|課題|トラブル/.test(text) ? "USER_ISSUE" : /新商品|発売|新製品/.test(text) ? "NEW_PRODUCT" : /parcel locker|locker|pudo|smari/i.test(text) ? "OVERSEAS_CASE" : "COMPETITOR";
  const importance = /発表|導入|採用|提携|補助金/.test(text) ? "HIGH" : /新商品|発売|市場|統計/.test(text) ? "MEDIUM" : "REFERENCE";
  const subjects = ["LIXIL", "YKK AP", "ナスタ", "三協アルミ", "ユニソン", "パナソニック", "PUDO", "SMARI", "Amazon Hub", "SPACER", "マルチエキューブ"];
  return { informationType, importance, keywords: subjects.filter((subject) => title.includes(subject)), tags };
}

function parseFeed(xml: string, feed: Feed, business: BusinessDef, targetFrom: Date, targetTo: Date, supplementalFrom: Date): Candidate[] {
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map((match) => match[1]).map((item) => {
    const title = field(item, "title"); const url = field(item, "link"); const dateText = field(item, "pubDate"); const publishedAt = dateText ? new Date(dateText) : null;
    if (!title || !url || !publishedAt || Number.isNaN(publishedAt.getTime()) || publishedAt < supplementalFrom || publishedAt > targetTo) return null;
    // `normalizedUrl`列（VarChar(512)）に収まらないURLは、登録で例外になる前にここで落とす（#170）。
    const normalizedUrl = normalizeUrl(url);
    if (!fitsNormalizedUrlColumn(normalizedUrl)) return null;
    return { business: feed.business, title, url: normalizedUrl, sourceName: feed.name, publisher: field(item, "source"), publishedAt, isSupplemental: publishedAt < targetFrom, ...classify(title, business) };
  }).filter((item): item is Candidate => item !== null);
}

function selectCandidates(candidates: Candidate[]): Candidate[] {
  const selected: Candidate[] = [];
  for (const candidate of candidates.sort((a, b) => Number(a.isSupplemental) - Number(b.isSupplemental) || b.publishedAt.getTime() - a.publishedAt.getTime())) {
    if (selected.length >= COLLECTION_LIMIT || selected.some((item) => item.url === candidate.url || similarTitle(item.title, candidate.title))) continue;
    if (selected.filter((item) => item.business === candidate.business).length >= BUSINESS_WEEKLY_LIMIT) continue;
    selected.push(candidate);
  }
  return selected;
}

/**
 * 事業区分（エクステリア・ロッカー・AI関連）の業界情報の日次収集（#43。従来は週次のみだった`runWeeklyCollection`を改名）。
 * `targetFrom`は「今週（JST日曜0時始まり）の開始」に固定する。ローリング7日窓のままだと
 * 日次実行のたびに週境界をまたぐランが発生し、週内へ集約する前提が崩れるため。
 */
export async function runDailyCollection(now = new Date()): Promise<CollectionResult> {
  const { start: targetFrom } = getWeekRange(0, now);
  const targetTo = new Date(now);
  const supplementalFrom = new Date(now.getTime() - 30 * DAY_MS);
  const run = await prisma.collectionRun.create({ data: { targetFrom, targetTo, supplementalFrom } });
  const errors: string[] = [];
  let feedFailures = 0;
  let articleFailures = 0;
  const candidates: Candidate[] = [];
  const businesses = await getBusinesses();
  const feeds = buildFeeds(businesses);
  for (const feed of feeds) try {
    const response = await fetch(feed.url, { headers: { "user-agent": "research-desk/0.1 (+public-rss-collector)" }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    candidates.push(...parseFeed(await response.text(), feed, businesses.find((item) => item.key === feed.business)!, targetFrom, targetTo, supplementalFrom));
  } catch (error) { feedFailures++; errors.push(`${feed.name}: ${error instanceof Error ? error.message : "取得に失敗しました"}`); }
  const selected = selectCandidates(candidates);
  let insertedCount = 0;
  let duplicateCount = 0;
  let mergedCount = 0;
  let excludedCount = 0;
  const excludedArticles: ExcludedArticle[] = [];
  // 記事単位で握る（#170）。1件の登録失敗で残りの候補・`CollectionRun`の更新・新着通知まで
  // 止まると、実行記録が`RUNNING`のまま残る。エラー文（Prismaの生の文）は記録・応答へ載せず、ログへ出す。
  for (const [index, item] of selected.entries()) {
    try {
      const { outcome, excluded } = await upsertIndustryInformationEvent({
        business: item.business,
        informationType: item.informationType,
        title: item.title,
        url: item.url,
        sourceName: item.sourceName,
        publisher: item.publisher,
        isPrimarySource: false,
        publishedAt: item.publishedAt,
        importance: item.importance,
        keywords: item.keywords,
        tags: item.tags,
        periodScope: item.isSupplemental ? "PAST_30_DAYS_SUPPLEMENT" : "IN_SCOPE",
      }, run.id);
      if (excluded) { excludedArticles.push(excluded); excludedCount++; }
      if (outcome === "duplicate") duplicateCount++;
      else if (outcome === "merged") mergedCount++;
      else if (outcome === "inserted") insertedCount++;
    } catch (error) {
      articleFailures++;
      errors.push(`ARTICLE_INSERT_FAILED: 記事${index + 1}件目の登録に失敗しました`);
      console.error(`日次収集: 記事の登録に失敗しました（run=${run.id}, url=${item.url}）`, error);
    }
  }
  const status = decideDailyRunStatus({ feedCount: feeds.length, feedFailures, selectedCount: selected.length, articleFailures });
  await prisma.collectionRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), status, fetchedCount: candidates.length, selectedCount: selected.length, insertedCount, duplicateCount, mergedCount, excludedCount, failedCount: errors.length, errors, excludedArticles: excludedArticles.length ? (excludedArticles as unknown as Prisma.InputJsonValue) : undefined } });
  return { runId: run.id, status, targetFrom: targetFrom.toISOString(), targetTo: targetTo.toISOString(), supplementalFrom: supplementalFrom.toISOString(), fetchedCount: candidates.length, selectedCount: selected.length, insertedCount, duplicateCount, mergedCount, excludedCount, failedCount: errors.length, errors };
}
