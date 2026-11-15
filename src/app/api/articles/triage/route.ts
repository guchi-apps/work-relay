import { NextResponse } from "next/server";
import { setTriageDecision } from "@/lib/article-analysis";
import { getCurrentUser } from "@/lib/auth";
import { parseTriageRequest } from "@/lib/triage";

export const runtime = "nodejs";

/**
 * 記事をまとめて採用／不採用にする（#94）。
 *
 * 各画面のカードのボタン（1件ずつ。まとめて仕分けるバーは#449で削除した）が
 * ここを呼ぶ。本文は`{ articleIds: string[], decision: "adopt" | "reject", note?: string }`。
 * `note`は不採用理由等のメモ（任意）で、記事詳細画面の「メモ」欄（`reviewNote`）と共用する。
 * 認証はブラウザ→サーバー方向なのでSupabaseセッション（`getCurrentUser()`）。
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (user.status === "unavailable") return NextResponse.json({ error: "auth_unavailable" }, { status: 503 });
  if (user.status === "unauthenticated") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const input = parseTriageRequest(body);
  if (!input) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const updated = await setTriageDecision(input.articleIds, input.decision === "adopt", user.user.email, input.note);
  if (updated === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, updated }, { headers: { "Cache-Control": "no-store" } });
}
