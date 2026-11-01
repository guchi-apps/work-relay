import { json, requireOpsApiToken } from "@/lib/internal-auth";
import { LAST_7D_MS, summarizeFeature, type UsageFeature, type UsageRecord } from "@/lib/ai-usage";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

/**
 * ops-dashboardの「アプリ別のAI利用」向けに、Codex CLIの呼出回数を返す（#243）。
 *
 * 数えるのは**成功したものだけ**。記事解析は解析結果（`ArticleAnalysis`）が出来た時刻、
 * 週の総括・ニュース収集は`COMPLETED`になったジョブの`finishedAt`。失敗ジョブは`model`が
 * 入らないことが多く、呼出回数として意味が薄いため含めない。
 */
export async function GET(request: Request) {
  const denied = await requireOpsApiToken(request);
  if (denied) return denied;

  const now = new Date();
  const since = new Date(now.getTime() - LAST_7D_MS);
  const completed = { status: "COMPLETED" as const, finishedAt: { gte: since } };

  const [analyses, searches] = await Promise.all([
    prisma.articleAnalysis.findMany({ where: { createdAt: { gte: since } }, select: { model: true, createdAt: true } }),
    prisma.collectionSearchJob.findMany({ where: completed, select: { model: true, finishedAt: true } }),
  ]);

  const toRecords = (rows: { model: string | null; finishedAt: Date | null }[]): UsageRecord[] =>
    rows.flatMap((row) => (row.finishedAt ? [{ model: row.model, at: row.finishedAt }] : []));

  const features: UsageFeature[] = [
    ...summarizeFeature("記事のAI解析", analyses.map((row) => ({ model: row.model, at: row.createdAt })), now),
    ...summarizeFeature("ニュース収集", toRecords(searches), now),
  ];

  return json({ features }, 200);
}
