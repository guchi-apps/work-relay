import { businessFromParam } from "@/lib/business-defs";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getWeekRange, type WeekRange } from "@/lib/jst-week";
import type { TriageParam } from "@/lib/triage";

// 週の区切り・日付整形はPrismaに触れない`src/lib/jst-week.ts`が持つ（#110）。週報メールの
// 本文組み立てがブラウザ側と単体テストからも同じ関数を使うため切り出したもので、
// 既存の呼び出し側が変わらないようここから同じ名前で再エクスポートする。
export { buildWeekCalendarMonths, DAY_MS, formatDate, formatDateTime, formatIsoDate, formatWeekLabel, getIsoWeekNumber, getRecencyLabel, getWeekRange, isWithinWeek, jstParts, OLDEST_WEEK_OFFSET, parseWeekOffset } from "@/lib/jst-week";
export type { CalendarDay, CalendarMonth, CalendarWeekRow, RecencyLabel, WeekRange } from "@/lib/jst-week";

/** `all`か事業区分の小文字キー（`exterior`など）。 */
export type BusinessParam = string;
export type SourceParam = "all" | "primary" | "related";
export type ImportanceParam = "all" | "high" | "medium" | "reference";
/** AI解析の絞り込み（#79）。`pending`は未解析・待ち・実行中、`attention`は失敗・認証待ち。 */
export type AnalysisParam = "all" | "pending" | "analyzed" | "attention";

export type IndustryInformationFilters = {
  weekOffset: number;
  business: BusinessParam;
  source: SourceParam;
  importance: ImportanceParam;
  keyword: string;
  analysis: AnalysisParam;
  /** 週報候補から外れた記事（AIが対象外と判定、または人が除外）を隠すかどうか。 */
  hideExcluded: boolean;
};

const IMPORTANCE_BY_PARAM = { high: "HIGH", medium: "MEDIUM", reference: "REFERENCE" } as const;
// キーワードは文字列列だけ部分一致で引く。`keywords`・`tags`はJSON列で、Prismaが出せるのは
// 要素の完全一致（array_contains = JSON_CONTAINS）までのため、部分一致は文字列列に任せる。
const KEYWORD_TEXT_FIELDS = ["title", "summary", "targetCompany", "targetProduct", "sourceName", "publisher"] as const;

// 週の判定は公開日（`publishedAt`）を基準にする。公開日が未設定の記事は、発生日（`occurredAt`）が
// 入っていればそちらで判定する（#52）。公開日未設定の記事を機械的に「登録した日」の週へ出すと、
// 記事の内容と表示週がズレるため（AIDE経由の週報登録では公開日を付けない記事もある）。
// 公開日・発生日がどちらも未設定の場合だけ、登録した収集ラン（`CollectionRun`）の対象期間が
// 重なる週、またはランに紐付いていない記事（#37より前に登録したもの）は収集日で拾う。
//
// 補足（`periodScope`が`PAST_30_DAYS_SUPPLEMENT`）も同じ優先順位で判定する（#59）。以前は
// 補足だけ常に登録した収集ランの週へ出していたが、公開日が入っている記事はその公開日どおりの
// 週に出るのが利用者の期待と一致するため、`periodScope`による分岐はやめた。
function runOrCollectedCondition(range: WeekRange): Prisma.IndustryInformationWhereInput[] {
  return [
    // 期間の重なりで判定する。終端は排他（`targetTo`が翌週の日曜0時ちょうどでも翌週には出さない）。
    { collectionRun: { targetFrom: { lt: range.end }, targetTo: { gt: range.start } } },
    { collectionRunId: null, collectedAt: { gte: range.start, lt: range.end } },
  ];
}

/** 指定した週（JST日曜0時〜翌週日曜0時）に属するかどうかの絞り込み条件。`src/lib/collection.ts`の
 * イベント統合・週あたり上限判定も、表示と同じ週の切り方に揃えるためこれを再利用する。
 *
 * `src/lib/collection.ts`側のイベント統合判定（`findEventMatch()`・`referenceDate`）は、これとは
 * 別の理由で発生日→公開日の優先順位を使う（転載記事は発行元により公開日がバラつくため、同一
 * イベントかどうかの判定には事象そのものが起きた日を優先する方が適切）。表示側であるここは
 * 「読者が見る週」を決める基準（公開日→発生日）で、意図的に優先順位が異なる。 */
export function weekCondition(range: WeekRange): Prisma.IndustryInformationWhereInput {
  const byRunOrCollected = runOrCollectedCondition(range);
  return {
    OR: [
      { publishedAt: { gte: range.start, lt: range.end } },
      { publishedAt: null, occurredAt: { gte: range.start, lt: range.end } },
      { publishedAt: null, occurredAt: null, OR: byRunOrCollected },
    ],
  };
}

function keywordCondition(keyword: string): Prisma.IndustryInformationWhereInput {
  return {
    OR: [
      ...KEYWORD_TEXT_FIELDS.map((field) => ({ [field]: { contains: keyword } }) as Prisma.IndustryInformationWhereInput),
      { keywords: { array_contains: keyword } },
      { tags: { array_contains: keyword } },
    ],
  };
}

/** 記事と一緒に「最新の解析結果」「最新のジョブ」を1件ずつ引く（#79）。 */
export const ARTICLE_ANALYSIS_INCLUDE = {
  analyses: { orderBy: { createdAt: "desc" }, take: 1 },
  analysisJobs: { orderBy: { queuedAt: "desc" }, take: 1 },
} satisfies Prisma.IndustryInformationInclude;

export type IndustryInformationListItem = Prisma.IndustryInformationGetPayload<{ include: typeof ARTICLE_ANALYSIS_INCLUDE }>;

/** AI解析の絞り込み条件。未解析は`analysisStatus`がnullのため、`in`だけでは拾えない。 */
function analysisCondition(analysis: AnalysisParam): Prisma.IndustryInformationWhereInput | null {
  if (analysis === "pending") return { OR: [{ analysisStatus: null }, { analysisStatus: { in: ["QUEUED", "RUNNING"] } }] };
  if (analysis === "analyzed") return { analysisStatus: "COMPLETED" };
  if (analysis === "attention") return { analysisStatus: { in: ["FAILED", "AUTH_REQUIRED"] } };
  return null;
}

/** 業界ニュース画面が表示する1週ぶんの業界情報を、絞り込み条件つきで取得する。 */
export async function listIndustryInformation(filters: IndustryInformationFilters, now = new Date()): Promise<IndustryInformationListItem[]> {
  const conditions: Prisma.IndustryInformationWhereInput[] = [weekCondition(getWeekRange(filters.weekOffset, now))];
  if (filters.business !== "all") conditions.push({ business: businessFromParam(filters.business) });
  if (filters.source !== "all") conditions.push({ isPrimarySource: filters.source === "primary" });
  if (filters.importance !== "all") conditions.push({ importance: IMPORTANCE_BY_PARAM[filters.importance] });
  if (filters.keyword) conditions.push(keywordCondition(filters.keyword));
  const analysis = analysisCondition(filters.analysis);
  if (analysis) conditions.push(analysis);
  if (filters.hideExcluded) conditions.push({ weeklyCandidate: true });

  // MySQL/MariaDBのENUMは定義順で並ぶ（`prisma/migrations/.../migration.sql`）。
  // `periodScope`はIN_SCOPE→補足、`importance`はHIGH→MEDIUM→REFERENCEの順で、
  // そのまま「補足は後ろ・重要度順」になる。
  return prisma.industryInformation.findMany({
    where: { AND: conditions },
    include: ARTICLE_ANALYSIS_INCLUDE,
    orderBy: [{ periodScope: "asc" }, { importance: "asc" }, { publishedAt: "desc" }, { collectedAt: "desc" }],
  });
}

/** ヘッダーの「最終更新」に出す、登録済み業界情報のうち最も新しい収集日時。 */
export async function getLastCollectedAt(): Promise<Date | null> {
  const result = await prisma.industryInformation.aggregate({ _max: { collectedAt: true } });
  return result._max.collectedAt ?? null;
}

/** 「NEW／更新」バッジ判定用の、直近の収集ランID。`collectionRunId`（作成時のラン）と
 * `updatedByRunId`（最後に更新したラン）をこれと比較し、一致する記事だけにバッジを出す。 */
export async function getLatestCollectionRunId(): Promise<string | null> {
  const run = await prisma.collectionRun.findFirst({ orderBy: { startedAt: "desc" }, select: { id: true } });
  return run?.id ?? null;
}

export type MergedSource = { url: string; normalizedUrl: string; sourceName: string; publisher: string | null; isPrimarySource: boolean; mergedAt: string; collectionRunId: string };

/** `mergedSources`（統合元URLのJSON配列）を表示用の配列にする。壊れた値は無視する。 */
export function toMergedSources(value: Prisma.JsonValue | null): MergedSource[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is MergedSource => typeof item === "object" && item !== null && typeof (item as MergedSource).url === "string" && typeof (item as MergedSource).normalizedUrl === "string");
}

/** トップ画面の新着記事一覧が1つのタブで表示する件数の上限。日次収集が1回30件まで取り込む
 * ようになった（#94）ため、未判定が数日ぶん溜まっても仕分けし切れる大きさにしてある。 */
export const RECENT_LIMIT = 60;

/** 仕分けの状態（#94）で絞る条件。`pending`は人がまだ判断していない記事（AIが対象外と判定した
 * ものも含む）で、`src/lib/triage.ts`の`getTriageState()`と同じ読み方をDBの`where`で表したもの。 */
function triageCondition(triage: TriageParam): Prisma.IndustryInformationWhereInput {
  if (triage === "pending") return { reviewedAt: null };
  if (triage === "adopted") return { reviewedAt: { not: null }, weeklyCandidate: true };
  if (triage === "rejected") return { reviewedAt: { not: null }, weeklyCandidate: false };
  return {};
}

/** トップ画面向けに、仕分けの状態で絞った業界情報を収集日時（`collectedAt`）が新しい順で取得する。 */
export async function listRecentIndustryInformation(triage: TriageParam): Promise<IndustryInformationListItem[]> {
  return prisma.industryInformation.findMany({ where: triageCondition(triage), include: ARTICLE_ANALYSIS_INCLUDE, orderBy: { collectedAt: "desc" }, take: RECENT_LIMIT });
}

/**
 * 業界ニュース画面の強調バナー（#124）用。`countTriage()`の`pending`は`{reviewedAt: null}`
 * 全部で、AIが対象外と判定した記事（`ai_rejected`。人の確認待ちだが業界ニュース画面には出ない）
 * も含んでしまう。バナーが指す「新着」は、既に業界ニュース画面に出ている・人がまだ仕分けていない
 * 記事だけを指したいため、`weeklyCandidate: true`も条件に加えた狭い件数を別に持つ
 * （`src/lib/triage.ts`の`getTriageState()`の`"pending"`と同じ条件）。
 */
export async function countPendingReview(): Promise<number> {
  return prisma.industryInformation.count({ where: { reviewedAt: null, weeklyCandidate: true } });
}

export type TriageCounts = Record<TriageParam, number>;

/** タブに添える件数。`all`は3つの合計（状態は互いに排他なので、全件数と一致する）。 */
export async function countTriage(): Promise<TriageCounts> {
  const [pending, adopted, rejected] = await Promise.all([
    prisma.industryInformation.count({ where: triageCondition("pending") }),
    prisma.industryInformation.count({ where: triageCondition("adopted") }),
    prisma.industryInformation.count({ where: triageCondition("rejected") }),
  ]);
  return { pending, adopted, rejected, all: pending + adopted + rejected };
}

/** JSON列（`keywords`・`tags`）を表示用の文字列配列にする。 */
export function toStringArray(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** `extractedMetrics`（項目が増える前提のJSON）を「主な数値・事実」の1行にまとめる。 */
export function formatMetrics(value: Prisma.JsonValue | null): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => String(item)).join(" ／ ") || null;
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== null && item !== undefined);
    return entries.length ? entries.map(([key, item]) => `${key}: ${String(item)}`).join(" ／ ") : null;
  }
  return String(value);
}

/** 記事メールの送信時に、画面から渡された記事IDでDBを引き直す。本文はブラウザの値ではなくこれで組み立てる。 */
export async function listIndustryInformationByIds(articleIds: string[]): Promise<IndustryInformationListItem[]> {
  if (articleIds.length === 0) return [];
  return prisma.industryInformation.findMany({
    where: { id: { in: articleIds } },
    include: ARTICLE_ANALYSIS_INCLUDE,
    orderBy: [{ businessDef: { sortOrder: "asc" } }, { importance: "asc" }, { publishedAt: "desc" }, { collectedAt: "desc" }],
  });
}
