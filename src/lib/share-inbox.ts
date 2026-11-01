/**
 * 共有された写真の一時置き場と、共有内容の振り分け（#144）。
 *
 * iPhoneのホーム画面アプリはWeb Share Targetに対応していないため、ショートカットが写真を
 * `POST /api/share/inbox`へ送り、Safariで「画像を送る」を開く。開いた画面が写真を受け取るまでの
 * 間だけ、**このプロセスのメモリに置く**（ディスク・DBには書かない。#64の方針）。
 * 画面が一度受け取るか`SHARE_INBOX_TTL_MS`を過ぎた時点で消す。再起動でも消える。
 *
 * 本番はPM2のforkモード1プロセス（`deploy/ecosystem.config.js`）なので、受け取ったプロセスと
 * 読み出すプロセスが同じになる。複数プロセスにする場合はこの置き場ごと見直すこと。
 *
 * Prismaをimportしないため`node --test`から直接読める。
 */

export const SHARE_INBOX_TTL_MS = 10 * 60 * 1000;
export const SHARE_INBOX_MAX_FILES = 20;
/** 1件あたりの合計。本番のNodeはヒープ128MB・320MBで再起動なので、置けるのは数件ぶんまで。 */
export const SHARE_INBOX_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
/**
 * 1回のリクエストとして受け付ける本文の上限。写真の合計上限に、フォームの余白（multipartの
 * 境界・ファイルごとのヘッダー・`title`/`text`/`url`/`batch`欄）ぶんを足した値。
 */
export const SHARE_INBOX_MAX_REQUEST_BYTES = SHARE_INBOX_MAX_TOTAL_BYTES + 1024 * 1024;
/** 同時に置いておく件数。超えたら古いものから捨てる。 */
export const SHARE_INBOX_MAX_ENTRIES = 3;
export const SHARE_TITLE_MAX_LENGTH = 200;

export type SharedFile = { name: string; type: string; data: Uint8Array };
/** `batch`は、同じ共有としてまとめる写真に共通のID（#163）。まとめない共有（Androidなど）はnull。 */
/**
 * `key`は再送を見分ける冪等キー（iOSアプリは`PendingShare.id`）。`owner`は置いた利用者のメール
 * （ショートカットなど利用者を持たない呼び出し元はnull）。どちらも無い共有は従来どおり。
 */
export type ShareInboxEntry = { id: string; title: string; files: SharedFile[]; createdAt: number; batch: string | null; key: string | null; owner: string | null };

type Store = Map<string, ShareInboxEntry>;

// 開発サーバーのHMRでモジュールが読み直されても置き場が消えないよう、globalThisに持つ。
const globalStore = globalThis as unknown as { __shareInbox?: Store };

export function getShareInboxStore(): Store {
  globalStore.__shareInbox ??= new Map();
  return globalStore.__shareInbox;
}

export function pruneExpired(store: Store, now: number): void {
  for (const [id, entry] of store) {
    if (now - entry.createdAt > SHARE_INBOX_TTL_MS) store.delete(id);
  }
}

export type PutResult = { ok: true; id: string; count: number } | { ok: false; reason: "no_files" | "too_many_files" | "too_large" | "not_image" };

export function validateSharedFiles(files: SharedFile[]): Exclude<PutResult, { ok: true }> | null {
  if (files.length === 0) return { ok: false, reason: "no_files" };
  if (files.length > SHARE_INBOX_MAX_FILES) return { ok: false, reason: "too_many_files" };
  if (files.some((file) => !file.type.startsWith("image/"))) return { ok: false, reason: "not_image" };
  const total = files.reduce((sum, file) => sum + file.data.byteLength, 0);
  if (total > SHARE_INBOX_MAX_TOTAL_BYTES) return { ok: false, reason: "too_large" };
  return null;
}

/**
 * `Content-Length`の値から、本文を読む前に断ってよい大きさかを判定する（#172）。
 * `request.formData()`は本文を全部メモリへ読み込むため、上限は読み込む前に見る必要がある。
 * ヘッダーが無い（チャンク転送）・数値でない場合は判定できないので`false`を返し、読み込んだ後の
 * `validateSharedFiles()`に任せる。
 */
export function isRequestBodyTooLarge(contentLength: string | null | undefined): boolean {
  const trimmed = (contentLength ?? "").trim();
  if (!/^\d+$/.test(trimmed)) return false;
  return Number(trimmed) > SHARE_INBOX_MAX_REQUEST_BYTES;
}

/** `Accept`がJSONを求めているか。iOSアプリの共有取り込み（#318）が、リダイレクトではなくJSONを受けるために付ける。 */
export function acceptsJson(accept: string | null | undefined): boolean {
  return (accept ?? "").split(",").some((part) => part.split(";")[0].trim().toLowerCase() === "application/json");
}

const BATCH_ID_PATTERN =/^[A-Za-z0-9._:-]{1,64}$/;

/**
 * まとめ用IDを整える。空なら`null`（まとめない）。使える文字・長さを外れていれば`"invalid"`。
 * ショートカットが日時から作る値（`20260919103015`など）を受けられればよいので、文字は絞っておく。
 */
export function normalizeBatchId(value: string | null | undefined): string | null | "invalid" {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  return BATCH_ID_PATTERN.test(trimmed) ? trimmed : "invalid";
}

/**
 * 写真を置き場へ置く。`batch`が同じ置き場が既にあれば、そこへ追記する（#163）。
 * iPhoneのショートカットのフォームは「ファイル」フィールドに先頭の1枚しか載せないため、
 * 「繰り返す」で1枚ずつ送っても同じ共有としてまとめられるようにしている。
 *
 * 枚数・合計サイズの上限と10分の有効期限は、まとめた単位で守る（期限は最初の1枚を置いた時点から）。
 * 追記が上限を超えるときは断り、それまでに置いた写真は残す。
 */
export function putShareEntry(store: Store, input: { title: string; files: SharedFile[]; batch?: string | null; key?: string | null; owner?: string | null }, now: number, id: string = crypto.randomUUID()): PutResult {
  pruneExpired(store, now);
  const title = input.title.trim().slice(0, SHARE_TITLE_MAX_LENGTH);
  const batch = input.batch ?? null;
  const key = input.key ?? null;
  const owner = input.owner ?? null;

  // 応答だけ受け取れずに再送されたPOSTは、最初に置いたものを返して写真を足さない。
  // 利用者が違えば同じキーでも別の共有として扱う（他人の共有を横取りさせない）。
  const duplicate = key ? [...store.values()].find((entry) => entry.key === key && entry.owner === owner) : undefined;
  if (duplicate) return { ok: true, id: duplicate.id, count: duplicate.files.length };

  const invalid = validateSharedFiles(input.files);
  if (invalid) return invalid;

  const existing = batch ? [...store.values()].find((entry) => entry.batch === batch && entry.owner === owner) : undefined;
  if (existing) {
    const merged = [...existing.files, ...input.files];
    const mergedInvalid = validateSharedFiles(merged);
    if (mergedInvalid) return mergedInvalid;
    existing.files = merged;
    if (!existing.title) existing.title = title;
    return { ok: true, id: existing.id, count: merged.length };
  }

  // Mapは挿入順を保つので、先頭が一番古い。
  while (store.size >= SHARE_INBOX_MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  store.set(id, { id, title, files: input.files, createdAt: now, batch, key, owner });
  return { ok: true, id, count: input.files.length };
}

/**
 * 一度だけ取り出す。取り出したら置き場から消す。`id`がnullなら一番新しいもの。
 * `owner`を持つ共有は、同じ利用者にしか渡さない（他人のものは消さずに残す）。
 * 所有者のない共有（ショートカット経由）は、ログイン中の誰でも取り出せる。
 */
export function takeShareEntry(store: Store, id: string | null, now: number, owner: string | null = null): ShareInboxEntry | null {
  pruneExpired(store, now);
  const visible = (candidate: ShareInboxEntry) => candidate.owner === null || candidate.owner === owner;
  let entry: ShareInboxEntry | undefined;
  if (id) {
    const found = store.get(id);
    if (found && visible(found)) entry = found;
  } else {
    for (const candidate of store.values()) if (visible(candidate)) entry = candidate;
  }
  if (!entry) return null;
  store.delete(entry.id);
  return entry;
}

export function hasPendingShare(store: Store, now: number): boolean {
  pruneExpired(store, now);
  return store.size > 0;
}

// --- 共有内容の振り分け ---------------------------------------------------------------

const URL_PATTERN = /https?:\/\/[^\s<>"'「」『』（）()]+/i;

/** 文章の中から最初のURLを取り出す。Androidの共有は`url`を空にして`text`へURLを入れることが多い。 */
export function extractUrl(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(URL_PATTERN);
  if (!match) return null;
  const candidate = match[0].replace(/[.,、。!！?？]+$/, "");
  return isHttpUrl(candidate) ? candidate : null;
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export type SharedText = { title: string; text: string; url: string | null };

/**
 * 共有された`title`・`text`・`url`を整える。URLは`url`を優先し、無ければ`text`から拾う。
 * `text`からURLを拾ったときは、`text`からそのURLを取り除いた残りを文章として扱う。
 *
 * `url`がURL単体でないときは`rawUrl`も文章の可能性がある値として扱う（`text`→`rawUrl`の
 * 順でURLを探し、どちらにも無ければ`rawUrl`をそのまま文章にする）。iPhoneのショートカット
 * 「ワークリレーへ記事」は、共有した内容がURLでなくても`url=`パラメータへ載せて開くため
 * （`docs/share-shortcut.md`）、これを素通しすると`url`も`text`も空になり、文章が失われる（#149）。
 */
export function normalizeSharedText(input: { title?: string | null; text?: string | null; url?: string | null }): SharedText {
  const title = (input.title ?? "").trim();
  let text = (input.text ?? "").trim();
  const rawUrl = (input.url ?? "").trim();
  let url = rawUrl && isHttpUrl(rawUrl) ? rawUrl : null;
  if (!url) {
    url = extractUrl(text) ?? extractUrl(rawUrl);
    if (url) {
      text = (text || rawUrl).replace(url, "").trim();
    } else if (!text && rawUrl) {
      text = rawUrl;
    }
  } else if (text === url) {
    text = "";
  }
  return { title: title.slice(0, SHARE_TITLE_MAX_LENGTH), text, url };
}

/**
 * クエリへ載せる文章の上限。URL長の制約を避けるための切り詰め値で、これを超える文章は
 * ここで欠ける（#149のメール送信では、切り詰められた可能性を画面側で示す）。
 */
export const SHARE_TEXT_QUERY_MAX_LENGTH = 1000;

/** 共有された記事画面のURL。ショートカット「ワークリレーへ記事」からも同じ形で開く。 */
export function buildSharePagePath(shared: SharedText): string {
  const params = new URLSearchParams();
  if (shared.url) params.set("url", shared.url);
  if (shared.title) params.set("title", shared.title);
  if (shared.text) params.set("text", shared.text.slice(0, SHARE_TEXT_QUERY_MAX_LENGTH));
  const query = params.toString();
  return query ? `/dashboard/share?${query}` : "/dashboard/share";
}

/** 記事のタイトルが無いときの代わり。共有された文章の1行目か、URLのホスト名。 */
export function fallbackArticleTitle(shared: SharedText): string {
  if (shared.title) return shared.title;
  const firstLine = shared.text.split(/\r?\n/)[0]?.trim();
  if (firstLine) return firstLine.slice(0, SHARE_TITLE_MAX_LENGTH);
  if (shared.url) return new URL(shared.url).hostname;
  return "";
}

/**
 * 「この記事を送る」の行き先。記事詳細を、メール送信シートを開いた状態で開く（#385）。
 * 週報メール画面（`/dashboard/news-mail`）は廃止したため、週やチェックの指定は要らない。
 */
export function buildArticleMailPath(articleId: string): string {
  return `/dashboard/articles/${encodeURIComponent(articleId)}?mail=1`;
}
