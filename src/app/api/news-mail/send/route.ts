import { getCurrentUser } from "@/lib/auth";
import { listIndustryInformationByIds } from "@/lib/industry-information";
import { json } from "@/lib/internal-auth";
import { getSharedToken } from "@/lib/shared-token";
import { getWeekRange } from "@/lib/jst-week";
import { getBusinesses } from "@/lib/businesses";
import { buildNewsMail, parseNewsMailRequest, toNewsMailArticle, type NewsMailBrief } from "@/lib/news-mail";
import { toNewsMailArticleDto } from "@/lib/news-mail-articles";
import { getLatestWeeklyBrief } from "@/lib/weekly-brief";

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
 * 選んだ業界ニュースを1通の週報メールにしてAIDEへ中継する（#110）。
 *
 * **本文はここで組み立てる。** ブラウザから受け取るのは「どの記事を送るか」と件名だけで、
 * 記事の中身はIDでDBを引き直す。画面のプレビューと同じ`buildNewsMail()`を使うため、
 * 見えている内容と送る内容は一致する（ブラウザから任意のHTMLを送れる口は作らない）。
 *
 * 認証はSupabaseのセッション（`/api/image-mail/send`と同じで、ブラウザ→サーバー方向のため
 * `/api/internal/*`の共有シークレットではない）。Gmail送信・宛先固定・二重送信の防止は
 * AIDE側が担う。AIDE側の受け口は別Issueで実装するため、それまでは502が返る。
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

  const items = await listIndustryInformationByIds(input.articleIds);
  if (items.length === 0) return json({ error: "no_articles", message: "送る記事が見つかりませんでした" }, 400);

  const range = getWeekRange(input.weekOffset);
  // 総括は完了しているものだけ載せる。生成中・失敗しているときは本文からその節ごと落とす
  // （画面でも「総括が無くても送信できます」と案内している）。
  const latest = await getLatestWeeklyBrief(input.weekOffset);
  const brief: NewsMailBrief | null =
    latest && latest.status === "COMPLETED" && latest.headline && latest.overview
      ? { headline: latest.headline, overview: latest.overview, topics: latest.topics }
      : null;

  const mail = buildNewsMail({
    range,
    subjectBody: input.subjectBody,
    articles: items.map(toNewsMailArticleDto).map(toNewsMailArticle),
    brief,
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
        articleCount: items.length,
      }),
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string" ? payload.message : `AIDEへの送信に失敗しました（HTTP ${response.status}）`;
      return json({ error: "send_failed", message }, 502);
    }
    return json({ ok: true, articleCount: items.length, hasBrief: brief !== null, ...(payload && typeof payload === "object" ? payload : {}) }, 200);
  } catch {
    return json({ error: "send_failed", message: "AIDEへの送信に失敗しました。しばらくしてから再試行してください" }, 502);
  } finally {
    clearTimeout(timeout);
  }
}
