import { getCurrentUser } from "@/lib/auth";
import { formatPartSuffix } from "@/lib/image-mail-split";
import { buildImageMailZipFileName } from "@/lib/image-mail-zip-filename";
import { json } from "@/lib/internal-auth";
import { getSharedToken } from "@/lib/shared-token";

export const runtime = "nodejs";

const MAX_TITLE_LENGTH = 200;
const MAX_ZIP_SIZE_BYTES = 2 * 1024 * 1024;
const MAX_PART_TOTAL = 30;
const ALLOWED_WIDTHS = [1200, 900, 600];
const REQUEST_TIMEOUT_MS = 30_000;

interface AideImageMailConfig {
  url: string;
  token: string;
}

// research-desk→AIDE方向。aide-botへの通知（src/lib/aide-bot-notice.ts）と同じく、
// research-desk側が持つのは「AIDEのベースURL・トークン」だけの薄いクライアント。
// パス（/api/image-mail/send）はAIDE_BOT_URLと同じ流儀でコード側が足す（#102）。
async function readAideImageMailConfig(): Promise<AideImageMailConfig | null> {
  const url = (process.env.AIDE_IMAGE_MAIL_URL ?? "").trim().replace(/\/$/, "");
  const token = ((await getSharedToken("AIDE_IMAGE_MAIL_TOKEN", "AIDE_IMAGE_MAIL_TOKEN")) ?? "").trim();
  if (!url || !token) return null;
  return { url, token };
}

/**
 * ブラウザで圧縮・ZIP化した画像をAIDEへ中継するサーバー間連携API（#64）。
 *
 * AIDEのURL・トークンはこのサーバー環境変数にのみ置き、ブラウザには渡さない。ZIPは
 * ここでもディスク・DBへ書かず、受け取ったFormDataをそのままAIDEへ転送するだけに留める。
 * AIDE側（宛先固定・件名固定・Gmail送信・idempotency処理）は別リポジトリ・別Issueで実装する。
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (user.status !== "authenticated") return json({ error: "unauthorized" }, 401);

  const config = await readAideImageMailConfig();
  if (!config) return json({ error: "aide_not_configured", message: "AIDEとの連携が未設定です" }, 503);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "invalid_form", message: "リクエストを解析できませんでした" }, 400);
  }

  const title = form.get("title");
  const idempotencyKey = form.get("idempotencyKey");
  const imageCount = Number(form.get("imageCount"));
  const width = Number(form.get("width"));
  const zip = form.get("zip");
  // 2MBを超えて複数通に分けて送るとき（#332）。無ければ1通だけの送信として扱う。
  const partIndex = form.has("partIndex") ? Number(form.get("partIndex")) : 1;
  const partTotal = form.has("partTotal") ? Number(form.get("partTotal")) : 1;

  if (typeof title !== "string" || !title.trim()) return json({ error: "invalid_request", message: "写真タイトルを入力してください" }, 400);
  if (title.length > MAX_TITLE_LENGTH) return json({ error: "invalid_request", message: `写真タイトルは${MAX_TITLE_LENGTH}文字までです` }, 400);
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) return json({ error: "invalid_request", message: "idempotencyKeyが必要です" }, 400);
  if (!Number.isInteger(imageCount) || imageCount < 1) return json({ error: "invalid_request", message: "imageCountが不正です" }, 400);
  if (!ALLOWED_WIDTHS.includes(width)) return json({ error: "invalid_request", message: "widthは1200・900・600のいずれかで指定してください" }, 400);
  if (!Number.isInteger(partTotal) || partTotal < 1 || partTotal > MAX_PART_TOTAL || !Number.isInteger(partIndex) || partIndex < 1 || partIndex > partTotal) {
    return json({ error: "invalid_request", message: "partIndex・partTotalが不正です" }, 400);
  }
  if (!(zip instanceof Blob) || zip.size === 0) return json({ error: "invalid_request", message: "zipファイルが必要です" }, 400);
  if (zip.size > MAX_ZIP_SIZE_BYTES) return json({ error: "zip_too_large", message: "ZIPサイズが上限（2MB）を超えています" }, 400);

  // 件名はAIDE側でタイトルの前に「[画像] 」が付くため、連番はタイトルの末尾に足す。
  const sentTitle = `${title.trim()}${formatPartSuffix(partIndex, partTotal)}`;
  const forwardForm = new FormData();
  forwardForm.set("title", sentTitle);
  forwardForm.set("imageCount", String(imageCount));
  forwardForm.set("width", String(width));
  forwardForm.set("idempotencyKey", idempotencyKey.trim());
  forwardForm.set("zip", zip, buildImageMailZipFileName(sentTitle, new Date()));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.url}/api/image-mail/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}` },
      body: forwardForm,
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : `AIDEへの送信に失敗しました（HTTP ${response.status}）`;
      return json({ error: "send_failed", message }, 502);
    }
    return json(body ?? { ok: true }, 200);
  } catch {
    return json({ error: "send_failed", message: "AIDEへの送信に失敗しました。しばらくしてから再試行してください" }, 502);
  } finally {
    clearTimeout(timeout);
  }
}
