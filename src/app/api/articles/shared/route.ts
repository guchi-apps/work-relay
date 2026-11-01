import { getCurrentUser } from "@/lib/auth";
import { normalizeUrl } from "@/lib/collection";
import { getBusinesses, normalizeBusinessKey } from "@/lib/businesses";
import { fitsNormalizedUrlColumn } from "@/lib/collection-rules";
import { json } from "@/lib/internal-auth";
import { buildNewsMailPickPath, isHttpUrl, SHARE_TITLE_MAX_LENGTH } from "@/lib/share-inbox";
import { createSharedArticle, type SharedArticleBusiness } from "@/lib/shared-article";

export const runtime = "nodejs";

const MAX_TEXT_LENGTH = 5000;

/**
 * 共有された記事を新着記事に登録する（#144）。本文は`{ url, title, text, business }`。
 * 登録済みのURLなら何も変えずに、その記事を返す（`outcome: "duplicate"`）。
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (user.status === "unavailable") return json({ error: "auth_unavailable", message: "認証状態を確認できませんでした" }, 503);
  if (user.status === "unauthenticated") return json({ error: "unauthorized", message: "ログインし直してください" }, 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json", message: "リクエストを解析できませんでした" }, 400);
  }
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const url = typeof input.url === "string" ? input.url.trim() : "";
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const text = typeof input.text === "string" ? input.text.trim().slice(0, MAX_TEXT_LENGTH) : "";
  const business: SharedArticleBusiness | null = normalizeBusinessKey(await getBusinesses(), input.business);

  if (!url || !isHttpUrl(url)) return json({ error: "invalid_url", message: "記事のURLを確認してください" }, 400);
  if (!fitsNormalizedUrlColumn(normalizeUrl(url))) return json({ error: "url_too_long", message: "URLが長すぎるため登録できません" }, 400);
  if (!title) return json({ error: "invalid_title", message: "タイトルを入力してください" }, 400);
  if (title.length > SHARE_TITLE_MAX_LENGTH) return json({ error: "invalid_title", message: `タイトルは${SHARE_TITLE_MAX_LENGTH}文字までです` }, 400);
  if (!business) return json({ error: "invalid_business", message: "事業を選んでください" }, 400);

  const result = await createSharedArticle({ url, title, text, business, reviewedBy: user.user.email });
  const { article } = result;
  return json(
    {
      ok: true,
      outcome: result.outcome,
      article: { id: article.id, title: article.title, sourceName: article.sourceName, collectedAt: article.collectedAt.toISOString(), analysisStatus: article.analysisStatus, triage: article.triage },
      pickPath: buildNewsMailPickPath(article.id, article.publishedAt ?? article.collectedAt, new Date()),
    },
    result.outcome === "created" ? 201 : 200,
  );
}
