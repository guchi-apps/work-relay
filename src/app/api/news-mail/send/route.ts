import { getCurrentUser } from "@/lib/auth";
import { listIndustryInformationByIds } from "@/lib/industry-information";
import { json } from "@/lib/internal-auth";
import { getSharedToken } from "@/lib/shared-token";
import { getBusinesses } from "@/lib/businesses";
import { buildNewsMail, parseNewsMailRequest, toNewsMailArticle } from "@/lib/news-mail";
import { toNewsMailArticleDto } from "@/lib/news-mail-articles";

export const runtime = "nodejs";

const REQUEST_TIMEOUT_MS = 30_000;

interface AideNewsMailConfig {
  url: string;
  token: string;
}

// research-desk→AIDE方向。画像メール（`src/app/api/image-mail/send/route.ts`）と同じ流儀で、
// 持つのは「AIDEのベースURL・トークン」だけにし、パス（/api/news-mail/send）はコード側が足す。
async function readAideNewsMailConfig(): Promise<AideNewsMailConfig | null> {
  const url = (process.env.AIDE_NEWS_MAIL_URL ?? "").trim().replace(/\/$/, "");
  const token = ((await getSharedToken("AIDE_NEWS_MAIL_TOKEN", "AIDE_NEWS_MAIL_TOKEN")) ?? "").trim();
  if (!url || !token) return null;
  return { url, token };
}

/**
 * 業界ニュースの記事1件を、ひとことを添えてメールにしてAIDEへ中継する（#385。元は#110の週報メール）。
 *
 * **本文はここで組み立てる。** ブラウザから受け取るのは「どの記事を送るか」・件名・ひとことだけで、
 * 記事の中身はIDでDBを引き直す。画面のプレビューと同じ`buildNewsMail()`を使うため、
 * 見えている内容と送る内容は一致する（ブラウザから任意のHTMLを送れる口は作らない）。
 *
 * 認証はSupabaseのセッション（`/api/image-mail/send`と同じで、ブラウザ→サーバー方向のため
 * `/api/internal/*`の共有シークレットではない）。Gmail送信・宛先固定・二重送信の防止は
 * AIDE側が担う。AIDEへ渡す項目は週報メールのときと同じ（`articleCount`は常に1）。
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (user.status === "unavailable") return json({ error: "auth_unavailable" }, 503);
  if (user.status !== "authenticated") return json({ error: "unauthorized" }, 401);

  const config = await readAideNewsMailConfig();
  if (!config) return json({ error: "aide_not_configured", message: "AIDEとの連携が未設定です" }, 503);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json", message: "リクエストを解析できませんでした" }, 400);
  }

  const input = parseNewsMailRequest(body);
  if (!input) return json({ error: "invalid_request", message: "送る記事と件名を確認してください" }, 400);

  const [item] = await listIndustryInformationByIds([input.articleId]);
  if (!item) return json({ error: "no_articles", message: "送る記事が見つかりませんでした" }, 404);

  const mail = buildNewsMail({
    article: toNewsMailArticle(toNewsMailArticleDto(item)),
    subjectBody: input.subjectBody,
    note: input.note,
    businesses: await getBusinesses(),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.url}/api/news-mail/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: input.idempotencyKey,
        subject: mail.subject,
        bodyText: mail.text,
        bodyHtml: mail.html,
        articleCount: 1,
      }),
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string" ? payload.message : `AIDEへの送信に失敗しました（HTTP ${response.status}）`;
      return json({ error: "send_failed", message }, 502);
    }
    return json({ ok: true, ...(payload && typeof payload === "object" ? payload : {}) }, 200);
  } catch {
    return json({ error: "send_failed", message: "AIDEへの送信に失敗しました。しばらくしてから再試行してください" }, 502);
  } finally {
    clearTimeout(timeout);
  }
}
