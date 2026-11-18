/**
 * 新着記事のPush通知（#231）のうち、DB・`web-push`に触れない判定だけを置く。
 * `pnpm test`（`node --test`）から読めるよう、Prismaをimportしない。
 */

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/** 通知タップで開く画面（業界ニュースの未判定タブ。#476で新着記事画面を統合） */
export const NEW_ARTICLES_URL = "/dashboard?triage=pending";

const MAX_ENDPOINT_LENGTH = 768;
const MAX_KEY_LENGTH = 255;

/** ブラウザの`PushSubscription.toJSON()`の形から、保存できる購読を取り出す。不正ならnull */
export function parseSubscriptionBody(body: unknown): PushSubscriptionInput | null {
  if (typeof body !== "object" || body === null) return null;
  const { endpoint, keys } = body as { endpoint?: unknown; keys?: unknown };
  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > MAX_ENDPOINT_LENGTH) return null;
  // Push serviceはHTTPSのみ。任意URLへのサーバー側リクエストにならないよう、ここで絞る
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (typeof keys !== "object" || keys === null) return null;
  const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };
  if (typeof p256dh !== "string" || typeof auth !== "string") return null;
  if (!p256dh || !auth || p256dh.length > MAX_KEY_LENGTH || auth.length > MAX_KEY_LENGTH) return null;
  return { endpoint, p256dh, auth };
}

/** 新規記事が1件以上あった日だけ通知する（0件の日は鳴らさない） */
export function shouldNotifyNewArticles(insertedCount: number): boolean {
  return Number.isInteger(insertedCount) && insertedCount > 0;
}

export function buildNewArticlesPayload(insertedCount: number): PushPayload {
  return {
    title: "新着記事があります",
    body: `今日の新着記事が${insertedCount}件あります。`,
    url: NEW_ARTICLES_URL,
    // 同じ通知が重なったときに端末側で1件へまとめる
    tag: "research-desk-new-articles",
  };
}

/** 購読が失効している（Push serviceが「もう無い」と返した）ときだけtrue。一時的な失敗では消さない */
export function isSubscriptionGone(statusCode: unknown): boolean {
  return statusCode === 404 || statusCode === 410;
}
