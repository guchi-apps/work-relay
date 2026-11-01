import { createHash } from "node:crypto";
import { importWeeklyReport, type WeeklyReportInput } from "@/lib/collection";
import { getBusinesses, businessKeys, normalizeBusinessKey, type BusinessDef } from "@/lib/businesses";
import { json, requireInternalApiKey } from "@/lib/internal-auth";

export const runtime = "nodejs";

// 呼び出し元はAIDEのMCPツール1本だけで、その先はChatGPTの週次定期タスク。ここを通る要求は
// 1週間に数回しか無いため、上限は「暴走した再試行を止める」ためだけの値にしてある。
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 20;
const rateLimit = new Map<string, { startedAt: number; count: number }>();

const ARTICLE_LIMIT = 15;
const ARTICLE_LIMIT_PER_BUSINESS = 5;
// AIDE側（30項目・JSONにして2000文字まで）と同等の上限で受ける（#47）。
const EXTRACTED_METRICS_MAX_KEYS = 30;
const EXTRACTED_METRICS_MAX_JSON_LENGTH = 2000;
const INFORMATION_TYPES = ["NEW_PRODUCT", "COMPETITOR", "INTRODUCTION_CASE", "RECRUITMENT_PARTNERSHIP", "POLICY_SUBSIDY", "MARKET_STATISTICS", "USER_ISSUE", "CONSTRUCTION", "QUALITY_SAFETY", "PATENT", "ACADEMIC_RESEARCH", "VIDEO", "SOCIAL_TREND", "OVERSEAS_CASE", "OTHER"];

// プロセス内カウンタのため、複数プロセスで動かす場合はリバースプロキシ側の制限も併用する。
function allowedByRateLimit(request: Request): boolean {
  const key = createHash("sha256").update(request.headers.get("authorization") ?? "internal-client").digest("hex");
  const now = Date.now();
  const current = rateLimit.get(key);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    rateLimit.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count++;
  return current.count <= MAX_REQUESTS;
}

// 例外のメッセージはそのままAIDE（→ChatGPT）へ返す。どこを直せば通るかが分かる文面にし、
// 入力本文そのものは含めない。
function validateInput(value: unknown, businesses: BusinessDef[]): WeeklyReportInput {
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
    for (const field of ["title", "sourceName"]) if ((item[field] as string).length > 500) throw new Error(`articles[${index}].${field}が長すぎます`);
    if ((item.url as string).length > 2048) throw new Error(`articles[${index}].urlが長すぎます`);
    try { new URL(item.url as string); } catch { throw new Error(`articles[${index}].urlが不正です`); }
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

/**
 * AIDE（`aide_research_desk_import_weekly_report`）から週報を登録する
 * サーバー間連携API（#31）。
 *
 * ChatGPTはAIDEまでしか繋がらず、ここのシークレットはAIDEのサーバー環境変数
 * （`AIDE_RESEARCH_DESK_TOKEN`）にだけ置く。#27の独立MCP（`/api/mcp`）はこのAPIへ
 * 置き換えたため残していない。
 *
 * 冪等性は`normalizedUrl`の一意制約に任せる。異なるURLでも発表主体・対象製品・発表日等から
 * 同一イベントと判定した記事は新規作成せず既存記事へ統合・上書き更新する
 * （`src/lib/collection.ts`の`upsertIndustryInformationEvent()`、#43）。
 */
export async function POST(request: Request) {
  const unauthorized = await requireInternalApiKey(request);
  if (unauthorized) return unauthorized;
  if (!allowedByRateLimit(request)) return json({ error: "rate_limited", message: "呼び出し回数の上限を超えました。しばらく待ってから再試行してください" }, 429);

  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "invalid_json", message: "JSONを解析できません" }, 400); }

  let input: WeeklyReportInput;
  try { input = validateInput(body, await getBusinesses()); } catch (error) {
    return json({ error: "invalid_request", message: error instanceof Error ? error.message : "入力が不正です" }, 400);
  }

  try {
    return json(await importWeeklyReport(input), 200);
  } catch (error) {
    // 入力本文は載せない。載せるのは、AIDEが再試行の可否を判断できる分だけ。
    const message = error instanceof Error ? error.message : "週報の登録に失敗しました";
    return json({ error: "import_failed", message: message.slice(0, 200) }, 500);
  }
}
