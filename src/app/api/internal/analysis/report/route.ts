import { FAILURE_MESSAGE_LIMIT, reportAnalysisResult, type ReportInput } from "@/lib/article-analysis";
import { parseTokenUsage } from "@/lib/ai-usage";
import { json, requireAnalysisWorkerSecret } from "@/lib/internal-auth";

export const runtime = "nodejs";

/**
 * VPS上の常駐ポーラーが解析結果を返す口（#79）。
 *
 * 失敗の分類（ログイン切れ・利用枠到達・出力不正）はサーバー側の`classifyFailure()`が行う。
 * ポーラーは終了コードと標準エラーの末尾だけを送り、判定条件を持たない。
 */
export async function POST(request: Request) {
  const denied = requireAnalysisWorkerSecret(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (typeof body !== "object" || body === null) return json({ error: "invalid_body" }, 400);

  const input = body as Record<string, unknown>;
  const jobId = typeof input.jobId === "string" ? input.jobId : null;
  const host = typeof input.host === "string" && input.host.trim() !== "" ? input.host.trim().slice(0, 64) : null;
  if (!jobId || !host) return json({ error: "job_and_host_required" }, 400);

  const codexAuthMode = typeof input.codexAuthMode === "string" ? input.codexAuthMode.slice(0, 32) : null;
  const durationMs = typeof input.durationMs === "number" && Number.isFinite(input.durationMs) ? Math.max(0, Math.round(input.durationMs)) : null;

  let report: ReportInput;
  if (input.status === "completed") {
    report = { jobId, host, status: "completed", result: input.result, model: typeof input.model === "string" ? input.model.slice(0, 64) : null, codexAuthMode, durationMs, usage: parseTokenUsage(input.usage), note: typeof input.note === "string" && input.note.trim() !== "" ? input.note : null };
  } else if (input.status === "failed") {
    report = {
      jobId,
      host,
      status: "failed",
      exitCode: typeof input.exitCode === "number" ? input.exitCode : null,
      // 実行ログをそのまま溜め込まない。分類に足りる末尾だけを受け取る。
      stderrTail: typeof input.stderrTail === "string" ? input.stderrTail.slice(-FAILURE_MESSAGE_LIMIT) : null,
      timedOut: input.timedOut === true,
      codexAuthMode,
      durationMs,
    };
  } else {
    return json({ error: "invalid_status" }, 400);
  }

  const result = await reportAnalysisResult(report);
  if (!result.ok) return json({ error: result.reason }, result.reason === "not_found" ? 404 : 409);
  return json({ status: result.status }, 200);
}
