import { NextResponse } from "next/server";
import { applyHumanReview, setWeeklyCandidate } from "@/lib/article-analysis";
import { getCurrentUser } from "@/lib/auth";
import { getBusinesses, normalizeBusinessKey } from "@/lib/businesses";

export const runtime = "nodejs";

const IMPORTANCE_VALUES = ["HIGH", "MEDIUM", "REFERENCE"] as const;
const NOTE_LIMIT = 500;

type Importance = (typeof IMPORTANCE_VALUES)[number];

/**
 * 人が事業区分・重要度・週報候補への採否を確定する（#79）。
 *
 * AIの判定は`ArticleAnalysis`に残したまま、記事側の値だけを確定値へ置き換える。以降のAI判定は
 * 週報候補の採否を書き換えない（`applyHumanReview()`が`reviewedAt`を立てる）。
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
  if (typeof body !== "object" || body === null) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const input = body as Record<string, unknown>;
  const articleId = typeof input.articleId === "string" ? input.articleId : "";
  if (!articleId) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  // 一覧のカードからは「週報候補から外す／戻す」だけを送る。事業区分・重要度を選び直さずに
  // 除外できるようにするため、この形だけを受け付ける分岐を持つ。
  if (input.relevance === undefined && typeof input.weeklyCandidate === "boolean") {
    const toggled = await setWeeklyCandidate(articleId, input.weeklyCandidate, user.user.email);
    if (!toggled) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  }

  const relevance = input.relevance === "OUT_OF_SCOPE" ? "OUT_OF_SCOPE" : normalizeBusinessKey(await getBusinesses(), input.relevance);
  const importance = IMPORTANCE_VALUES.includes(input.importance as Importance) ? (input.importance as Importance) : null;
  if (!relevance || !importance) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const note = typeof input.note === "string" && input.note.trim() !== "" ? input.note.trim().slice(0, NOTE_LIMIT) : null;
  const updated = await applyHumanReview({ articleId, relevance, importance, weeklyCandidate: input.weeklyCandidate !== false, note, reviewedBy: user.user.email });
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
