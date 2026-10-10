import type { User } from "@supabase/supabase-js";
import { forgetSharedToken, getSharedToken } from "@/lib/shared-token";
import {
  createAccessClient,
  parseAccessResponse,
  type AccessDecision,
  type AccessFetcher,
  type AccessSubject,
} from "@/lib/access/decision";

const TIMEOUT_MS = 5_000;

const TOKEN_NAME = "RESEARCH_DESK_ACCESS_APP_TOKEN";
/** StatusHubの本番オリジン。`ACCESS_API_URL`は開発などで別の宛先へ向けるときだけ使う。 */
const DEFAULT_ACCESS_API_URL = "https://admin.gucchii.com";

/**
 * StatusHubの判定APIを呼ぶ。アプリ別トークンは管理画面の「トークン発行」がissue-deckの共有トークン
 * `RESEARCH_DESK_ACCESS_APP_TOKEN`へ書き込んだもので、無ければ通信せず失敗として扱う
 * （＝一度も判定できないので全員拒否になる。未設定が「誰でも通す」に化けない）。
 * 再発行で古いトークンは即失効するため、401ならキャッシュを捨てて読み直し、1回だけ再試行する。
 * トークンの値はログへ出さない。旧`ALLOWED_GOOGLE_EMAILS`はフォールバックにしない。
 */
async function post(baseUrl: string, token: string, body: Parameters<AccessFetcher>[0]): Promise<Response> {
  return fetch(`${baseUrl.replace(/\/+$/, "")}/api/access/v1/decision`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

const fetcher: AccessFetcher = async (body) => {
  const baseUrl = process.env.ACCESS_API_URL || DEFAULT_ACCESS_API_URL;
  const token = await getSharedToken(TOKEN_NAME, "ACCESS_APP_TOKEN");
  if (!token) throw new Error(`${TOKEN_NAME}が未設定`);

  let response = await post(baseUrl, token, body);
  if (response.status === 401) {
    forgetSharedToken(TOKEN_NAME);
    const renewed = await getSharedToken(TOKEN_NAME, "ACCESS_APP_TOKEN");
    if (renewed && renewed !== token) response = await post(baseUrl, renewed, body);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseAccessResponse(await response.json(), body.subject !== undefined);
};

// 開発サーバーの再読み込みで状態が消えないよう globalThis に置く（instrumentationとルートが同じ状態を見る）。
const globalForAccess = globalThis as unknown as { __researchDeskAccess?: ReturnType<typeof createAccessClient> };

function client() {
  globalForAccess.__researchDeskAccess ??= createAccessClient(fetcher, undefined, Date.now, (error) => {
    console.error("[research-desk] アクセス判定の取得に失敗:", error instanceof Error ? error.message : error);
  });
  return globalForAccess.__researchDeskAccess;
}

/**
 * Supabaseが検証したユーザーから、判定APIへ送る主体を作る。メールが確認済みかはSupabaseの確認時刻・
 * Googleのemail_verifiedから決める（ブラウザの申告ではなく、サーバーが検証したセッションの値だけを使う）。
 */
export function toAccessSubject(user: Pick<User, "id" | "email" | "email_confirmed_at" | "user_metadata">): AccessSubject {
  const verified = user.user_metadata?.email_verified === true || Boolean(user.email_confirmed_at);
  return { sub: user.id, email: user.email ?? "", emailVerified: verified };
}

export async function decideAccess(subject: AccessSubject): Promise<AccessDecision> {
  return client().decide(subject);
}

export async function sendAccessHeartbeat(): Promise<boolean> {
  return client().heartbeat();
}
