import { createHash } from "node:crypto";
import { importWeeklyReport, type WeeklyReportInput } from "@/lib/collection";
import { getBusinesses } from "@/lib/businesses";
import { validateWeeklyReportInput } from "@/lib/weekly-report-validation";
import { json, requireInternalApiKey } from "@/lib/internal-auth";

export const runtime = "nodejs";

// 呼び出し元はAIDEのMCPツール1本だけで、その先はChatGPTの週次定期タスク。ここを通る要求は
// 1週間に数回しか無いため、上限は「暴走した再試行を止める」ためだけの値にしてある。
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 20;
const rateLimit = new Map<string, { startedAt: number; count: number }>();

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
  try { input = validateWeeklyReportInput(body, await getBusinesses()); } catch (error) {
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
