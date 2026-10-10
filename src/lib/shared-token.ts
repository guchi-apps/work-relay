/**
 * issue-deckの共有トークンAPI（guchi-apps/issue-deck の docs/shared-token-api.md）から、
 * アプリ間の認証値を実行時に読む（#255）。1Passwordから値を複製せず、issue-deckを唯一の正にする。
 * 参考実装はops-dashboardの`src/lib/shared-token.ts`（キャッシュ10分・タイムアウト5秒・失敗時は直前の値）。
 *
 * 取得できない（`SHARED_TOKEN_API_SECRET`・`ISSUE_DECK_URL`が未設定、通信失敗、未登録）ときは
 * 同名の環境変数へ倒す。**フォールバックに黙って落ちていないかは、issue-deckの設定画面で
 * 共有トークンの利用元に`research-desk`が出ているかで確かめる。**
 *
 * トークン値とBearerの値はログ・例外メッセージに出さない。Prismaをimportしないため単体テストできる。
 */

export const SHARED_TOKEN_CONSUMER = "research-desk";

const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 5_000;

export interface SharedTokenCacheEntry {
  value: string;
  fetchedAtMs: number;
}

export interface SharedTokenOptions {
  now?: number;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  secret?: string;
}

/**
 * 共有トークンを1つ取得する。優先順位は
 * 1. キャッシュが新しければそれ　2. issue-deckから取得できた値
 * 3. 取得に失敗したときは古くても直前の値　4. 無ければ null
 * `previous`と戻り値の`cache`を呼び出し元が持つことで副作用を関数の外へ出している。
 */
export async function resolveSharedToken(
  name: string,
  previous: SharedTokenCacheEntry | null,
  options: SharedTokenOptions = {},
): Promise<{ value: string | null; cache: SharedTokenCacheEntry | null }> {
  const now = options.now ?? Date.now();
  if (previous && now - previous.fetchedAtMs < CACHE_MS) {
    return { value: previous.value, cache: previous };
  }

  const baseUrl = (options.baseUrl ?? process.env.ISSUE_DECK_URL ?? "").trim();
  const secret = (options.secret ?? process.env.SHARED_TOKEN_API_SECRET ?? "").trim();
  if (!baseUrl || !secret) {
    return { value: previous?.value ?? null, cache: previous };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/api/shared-tokens?name=${encodeURIComponent(name)}`;
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers: {
        authorization: `Bearer ${secret}`,
        "x-shared-token-consumer": SHARED_TOKEN_CONSUMER,
        accept: "application/json",
      },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const payload: unknown = await response.json();
    const value = typeof payload === "object" && payload !== null ? (payload as { value?: unknown }).value : undefined;
    if (typeof value !== "string" || !value) throw new Error("unexpected payload");

    return { value, cache: { value, fetchedAtMs: now } };
  } catch (error) {
    // 例外にはURL・ヘッダーが載りうるため、種別だけを出す（Bearerの値を残さない）。
    const reason = error instanceof Error && /^HTTP \d+$|^unexpected payload$/.test(error.message) ? error.message : "request failed";
    console.error(`共有トークンの取得に失敗しました(${name}): ${reason}`);
    return { value: previous?.value ?? null, cache: previous };
  } finally {
    clearTimeout(timeout);
  }
}

const cache = new Map<string, SharedTokenCacheEntry>();

/**
 * 共有トークン`name`の値を返す。取得できなければ環境変数`fallbackEnv`、それも無ければ undefined。
 */
export async function getSharedToken(name: string, fallbackEnv: string): Promise<string | undefined> {
  const result = await resolveSharedToken(name, cache.get(name) ?? null);
  if (result.cache) cache.set(name, result.cache);
  return result.value ?? (process.env[fallbackEnv] || undefined);
}

/** 1つの名前のキャッシュだけ捨てる。再発行で失効した値を握り続けないために、認証の401で呼ぶ。 */
export function forgetSharedToken(name: string): void {
  cache.delete(name);
}
