import type { WeeklyReportInput } from "./collection.ts";
import { businessKeys, normalizeBusinessKey, type BusinessDef } from "./business-defs.ts";
import { fitsNormalizedUrlColumn, MAX_NORMALIZED_URL_LENGTH, MAX_SHORT_TEXT_LENGTH, normalizeUrl } from "./collection-rules.ts";

// 週報登録APIの入力検証。`route.ts`の中にあるとテストから読めず、列幅との食い違いに気付けなかった
// ため、Prismaに依存しないここへ置く（#410）。

const SHORT_TEXT_FIELDS = ["title", "sourceName", "publisher", "targetCompany", "targetProduct", "region"] as const;

// 全体の上限はAIDEのMCP中継（`MAX_ARTICLES`・input schemaの`maxItems`）と同じ10件に揃える。ここだけ
// 先に広げると、AIDEが11件以上を拒否して通常経路では使えない（#369→#379）。広げるときはAIDE側を
// 先に配布し、実稼働のschemaを確かめてからここを上げる。
const ARTICLE_LIMIT = 10;
const ARTICLE_LIMIT_PER_BUSINESS = 5;
// AIDE側（30項目・JSONにして2000文字まで）と同等の上限で受ける（#47）。
const EXTRACTED_METRICS_MAX_KEYS = 30;
const EXTRACTED_METRICS_MAX_JSON_LENGTH = 2000;
const INFORMATION_TYPES = ["NEW_PRODUCT", "COMPETITOR", "INTRODUCTION_CASE", "RECRUITMENT_PARTNERSHIP", "POLICY_SUBSIDY", "MARKET_STATISTICS", "USER_ISSUE", "CONSTRUCTION", "QUALITY_SAFETY", "PATENT", "ACADEMIC_RESEARCH", "VIDEO", "SOCIAL_TREND", "OVERSEAS_CASE", "OTHER"];

// 例外のメッセージはそのままAIDE（→ChatGPT）へ返す。どこを直せば通るかが分かる文面にし、
// 入力本文そのものは含めない。
export function validateWeeklyReportInput(value: unknown, businesses: readonly BusinessDef[]): WeeklyReportInput {
  if (!value || typeof value !== "object") throw new Error("リクエストボディはオブジェクトで指定してください");
  const input = value as Partial<WeeklyReportInput>;
  if (typeof input.executedAt !== "string" || typeof input.targetFrom !== "string" || typeof input.targetTo !== "string") throw new Error("executedAt、targetFrom、targetToは必須です");
  if (!Array.isArray(input.articles) || input.articles.length > ARTICLE_LIMIT) throw new Error(`articlesは1〜${ARTICLE_LIMIT}件で指定してください`);
  if (input.articles.length === 0) throw new Error("articlesを1件以上指定してください");
  const counts: Record<string, number> = {};
  for (const [index, article] of input.articles.entries()) {
    if (!article || typeof article !== "object") throw new Error(`articles[${index}]が不正です`);
    const item = article as Record<string, unknown>;
    const business = normalizeBusinessKey(businesses, item.business);
    if (!business) throw new Error(`articles[${index}].businessは${businessKeys(businesses).join("・")}のいずれかで指定してください`);
    item.business = business;
    counts[business] = (counts[business] ?? 0) + 1;
    if (counts[business] > ARTICLE_LIMIT_PER_BUSINESS) throw new Error(`1事業あたりの記事は${ARTICLE_LIMIT_PER_BUSINESS}件までです`);
    for (const field of ["title", "url", "sourceName"]) if (typeof item[field] !== "string" || !item[field]) throw new Error(`articles[${index}].${field}は必須です`);
    // DBの列幅（VARCHAR(191)）を超える値はINSERTがP2000で落ち、記事ごと黙って捨てられるので入口で断る（#410）。
    for (const field of SHORT_TEXT_FIELDS) {
      const text = item[field];
      if (text === undefined || text === null) continue;
      if (typeof text !== "string") throw new Error(`articles[${index}].${field}が不正です`);
      if (text.length > MAX_SHORT_TEXT_LENGTH) throw new Error(`articles[${index}].${field}は${MAX_SHORT_TEXT_LENGTH}文字までです`);
    }
    try { new URL(item.url as string); } catch { throw new Error(`articles[${index}].urlが不正です`); }
    if (!fitsNormalizedUrlColumn(normalizeUrl(item.url as string))) throw new Error(`articles[${index}].urlが長すぎます（正規化後${MAX_NORMALIZED_URL_LENGTH}文字まで）`);
    if (typeof item.informationType !== "string" || !INFORMATION_TYPES.includes(item.informationType)) throw new Error(`articles[${index}].informationTypeが不正です`);
    if (item.importance !== undefined && !["HIGH", "MEDIUM", "REFERENCE"].includes(item.importance as string)) throw new Error(`articles[${index}].importanceが不正です`);
    if (item.periodScope !== undefined && !["IN_SCOPE", "PAST_30_DAYS_SUPPLEMENT"].includes(item.periodScope as string)) throw new Error(`articles[${index}].periodScopeが不正です`);
    for (const field of ["publishedAt", "occurredAt"]) if (item[field] !== undefined && item[field] !== null && (typeof item[field] !== "string" || Number.isNaN(new Date(item[field] as string).getTime()))) throw new Error(`articles[${index}].${field}が不正です`);
    for (const field of ["keywords", "tags"]) if (item[field] !== undefined && (!Array.isArray(item[field]) || (item[field] as unknown[]).some((value) => typeof value !== "string"))) throw new Error(`articles[${index}].${field}が不正です`);
    if (item.extractedMetrics !== undefined && item.extractedMetrics !== null) {
      const metrics = item.extractedMetrics;
      if (typeof metrics !== "object" || Array.isArray(metrics)) throw new Error(`articles[${index}].extractedMetricsはオブジェクトで指定してください`);
      if (Object.keys(metrics).length > EXTRACTED_METRICS_MAX_KEYS) throw new Error(`articles[${index}].extractedMetricsは${EXTRACTED_METRICS_MAX_KEYS}項目までです`);
      if (JSON.stringify(metrics).length > EXTRACTED_METRICS_MAX_JSON_LENGTH) throw new Error(`articles[${index}].extractedMetricsはJSONにして${EXTRACTED_METRICS_MAX_JSON_LENGTH}文字までです`);
    }
  }
  return input as WeeklyReportInput;
}
