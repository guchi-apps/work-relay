import { getCurrentUser } from "@/lib/auth";
import { json } from "@/lib/internal-auth";
import { getSharedToken } from "@/lib/shared-token";
import { buildTextMail, parseTextMailRequest } from "@/lib/text-mail";

export const runtime = "nodejs";

const REQUEST_TIMEOUT_MS = 30_000;

interface AideTextMailConfig {
  url: string;
  token: string;
}

// research-desk→AIDE方向。画像メール・週報メールと同じ流儀で、持つのは「AIDEのベースURL・
// トークン」だけにし、パス（/api/text-mail/send）はコード側が足す。トークンはissue-deckの共有トークン
// `AIDE_TEXT_MAIL_TOKEN`を優先し、取得できないときだけ同名の環境変数へ倒す（#305）。
async function readAideTextMailConfig(): Promise<AideTextMailConfig | null> {
  const url = (process.env.AIDE_TEXT_MAIL_URL ?? "").trim().replace(/\/$/, "");
  const token = ((await getSharedToken("AIDE_TEXT_MAIL_TOKEN", "AIDE_TEXT_MAIL_TOKEN")) ?? "").trim();
  if (!url || !token) return null;
  return { url, token };
}

/**
 * 共有された文章（メモ等）を1通のメールにしてAIDEへ中継する（#149）。
 *
 * 記事メールと違い、送る文章はDBに保存されていない——`/dashboard/share`のクエリを通っただけの
 * 値を、ブラウザから受け取ってそのまま使う（画像メールの`title`と同じ扱い）。件名・本文の
 * 組み立ては画面のプレビューと同じ`buildTextMail()`を使うため、見えている内容と送る内容は一致する。
 *
 * 認証はSupabaseのセッション（`/api/image-mail/send`・`/api/news-mail/send`と同じ）。
 * Gmail送信・宛先固定・二重送信の防止はAIDE側が担う。AIDE側の受け口は別Issueで実装するため、
 * それまでは502が返る。
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (user.status === "unavailable") return json({ error: "auth_unavailable" }, 503);
  if (user.status !== "authenticated") return json({ error: "unauthorized" }, 401);

  const config = await readAideTextMailConfig();
  if (!config) return json({ error: "aide_not_configured", message: "AIDEとの連携が未設定です" }, 503);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json", message: "リクエストを解析できませんでした" }, 400);
  }

  const input = parseTextMailRequest(body);
  if (!input) return json({ error: "invalid_request", message: "文章と件名を確認してください" }, 400);

  const mail = buildTextMail(input);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.url}/api/text-mail/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: input.idempotencyKey, subject: mail.subject, bodyText: mail.text, bodyHtml: mail.html }),
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
