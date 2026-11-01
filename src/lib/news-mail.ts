/**
 * 記事メール（#385。元は#110の週報メール）の件名・本文の組み立てと、送信リクエストの検証。
 *
 * 1通で送るのは**記事1件**。気になった記事に「ひとこと」を添えて社用メールへ送る使い方で、
 * 複数記事を週単位でまとめる形（#110）は#385で廃止した。
 *
 * **Prisma・Reactに触れない純粋な関数だけを置く。** 理由は2つある。
 *
 * 1. `pnpm test`（`node --test`）から直接読めるようにするため（`src/lib/triage.ts`と同じ方針）
 * 2. **同じ関数を画面のプレビューと送信の両方から使うため。** ブラウザ側は表示中の記事から
 *    `buildNewsMailHtml()`を呼んでそのまま差し込み、サーバー側は記事IDでDBを引き直してから
 *    同じ関数を呼ぶ。プレビューと実際に送る本文が別実装になると、片方だけ直して食い違う
 *
 * HTMLはメールクライアント向けに**tableとインラインスタイルだけ**で組む。Gmailは`<style>`の
 * 一部やflex/gridを落とすため、レイアウトはtableで作り、色・余白は各要素へ直接書く。
 */

// `node --test`（型を剥がしてTypeScriptのまま実行する）から読めるよう、依存は相対パス＋拡張子
// つきで書く。`@/`のエイリアスはtsconfigのpathsで、Nodeの実行時解決には効かない。
import { formatIsoDate } from "./jst-week.ts";
import { DEFAULT_BUSINESSES, businessLabel, type BusinessDef } from "./business-defs.ts";

/** 件名の固定接頭辞。画面からは変更できない（画像メールの`[画像]`と同じ扱い）。 */
export const SUBJECT_PREFIX = "[業界ニュース]";

/** 件名のうち利用者が編集できる部分の上限。 */
export const MAX_SUBJECT_BODY_LENGTH = 160;

/** 「ひとこと」の上限。 */
export const MAX_NOTE_LENGTH = 300;

/** 事業区分のキー（エクステリア・ロッカー・AI関連など。マスタが正）。 */
export type MailBusiness = string;
export type MailImportance = "HIGH" | "MEDIUM" | "REFERENCE";

export type NewsMailMetric = { name: string; value: string };

/** メールに載せる記事1件ぶん。画面・サーバーのどちらからも同じ形で渡す。 */
export type NewsMailArticle = {
  id: string;
  title: string;
  originalUrl: string;
  sourceName: string;
  business: MailBusiness;
  isPrimarySource: boolean;
  importance: MailImportance;
  publishedAt: Date | null;
  occurredAt: Date | null;
  collectedAt: Date;
  /** AI解析の要約があればそちら、無ければ登録時の要約。 */
  summary: string | null;
  implications: string | null;
  metrics: NewsMailMetric[];
  /** AI解析が完了しているか。未解析の記事はメール側でもその旨を添える。 */
  analyzed: boolean;
};

export type NewsMailInput = {
  article: NewsMailArticle;
  subjectBody: string;
  /** 「ひとこと」。空なら本文に出さない。 */
  note: string;
  /** 事業区分のマスタ。省略時は初期値。 */
  businesses?: BusinessDef[];
};

export type NewsMailContent = { subject: string; html: string; text: string };

const IMPORTANCE_LABELS: Record<MailImportance, string> = { HIGH: "高", MEDIUM: "中", REFERENCE: "参考" };

const COLORS = {
  navy: "#1d3440",
  teal: "#087f78",
  orange: "#d97735",
  ink: "#182529",
  body: "#33474a",
  muted: "#6c7b7c",
  line: "#dbe5e3",
  paper: "#f7faf8",
  ground: "#eef2f0",
} as const;

// style属性をダブルクォートで囲むため、フォント名の引用にはシングルクォートを使う。
// ダブルのままだと属性がそこで閉じ、以降がHTMLとして壊れる。
const FONT = "-apple-system,BlinkMacSystemFont,'Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif";

/** 件名の編集できる部分の初期値。記事のタイトルを上限までで切る。 */
export function defaultSubjectBody(article: Pick<NewsMailArticle, "title">): string {
  return sanitizeSubjectBody(article.title).slice(0, MAX_SUBJECT_BODY_LENGTH);
}

/**
 * 件名として安全な1行にする。
 *
 * **改行と制御文字を必ず落とす。** この値はAIDE側でメールヘッダー（`Subject:`）へ載るため、
 * 改行が残ると任意のヘッダーを差し込める経路になり得る（現状のAIDE側の実装がどうであれ、
 * 値を作るこちら側で閉じておく）。連続する空白は1つにまとめる。
 */
export function sanitizeSubjectBody(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

/** 件名。接頭辞は常に付き、本文側だけを利用者が編集できる。 */
export function buildNewsMailSubject(subjectBody: string): string {
  const body = sanitizeSubjectBody(subjectBody);
  return body ? `${SUBJECT_PREFIX} ${body}` : SUBJECT_PREFIX;
}

/**
 * 「ひとこと」を本文に載せられる形にする。改行は残し（段落の区切りに使う）、改行以外の制御文字は
 * 落とす。前後の空白は削る。
 */
export function sanitizeNote(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- HTML本文 -------------------------------------------------------------------------

/** HTMLへ差し込む値は必ずここを通す。記事のタイトル・要約は外部サイト由来の文字列のため。 */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** `href`に載せてよいURLだけを通す。`javascript:`等を弾く（収集したURLをそのまま貼るため）。 */
function safeUrl(value: string): string | null {
  return /^https?:\/\//i.test(value.trim()) ? value.trim() : null;
}

function dateLine(article: NewsMailArticle): string {
  const published = article.publishedAt ?? article.occurredAt;
  const parts = [published ? `${formatIsoDate(published)} 公開` : "公開日不明", article.sourceName, article.isPrimarySource ? "一次情報" : "関連記事", `重要度 ${IMPORTANCE_LABELS[article.importance]}`];
  if (!article.analyzed) parts.push("AI解析なし");
  return parts.join(" ／ ");
}

/** 図解つきのHTML本文。画面のプレビューにもこの文字列をそのまま差し込む。 */
export function buildNewsMailHtml(input: NewsMailInput): string {
  const { article } = input;
  const businesses = input.businesses ?? DEFAULT_BUSINESSES;
  const note = sanitizeNote(input.note);
  const url = safeUrl(article.originalUrl);
  const metrics = article.metrics
    .slice(0, 6)
    .map((metric) => `<td style="padding:0 6px 6px 0;"><span style="display:inline-block;padding:3px 8px;border-radius:5px;background:${COLORS.ground};color:#4a6260;font-size:11px;">${escapeHtml(metric.name)} <b style="color:${COLORS.teal};">${escapeHtml(metric.value)}</b></span></td>`)
    .join("");

  return `<div style="margin:0;padding:16px;background:${COLORS.ground};font-family:${FONT};">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;max-width:640px;margin:0 auto;background:#ffffff;border-radius:6px;">
<tr><td style="padding:18px 20px;background:${COLORS.navy};border-radius:6px 6px 0 0;">
<p style="margin:0;font-size:10px;letter-spacing:.16em;color:#7fdfc9;font-weight:bold;">INDUSTRY NEWS　${escapeHtml(businessLabel(businesses, article.business))}</p>
<p style="margin:5px 0 0;font-size:17px;line-height:1.5;font-weight:bold;color:#ffffff;">${escapeHtml(article.title)}</p>
</td></tr>
<tr><td style="padding:18px 20px;">
${note ? `<p style="margin:0 0 14px;padding:10px 12px;background:#fff4e8;border-left:3px solid ${COLORS.orange};border-radius:3px;font-size:13px;line-height:1.8;color:${COLORS.ink};white-space:pre-wrap;"><b>ひとこと</b>　${escapeHtml(note)}</p>` : ""}
<p style="margin:0 0 8px;font-size:11px;color:${COLORS.muted};">${escapeHtml(dateLine(article))}</p>
<p style="margin:0;font-size:13px;line-height:1.8;color:${COLORS.body};">${escapeHtml(article.summary ?? "要約は登録されていません。")}</p>
${article.implications ? `<p style="margin:10px 0 0;padding:8px 10px;border-left:2px solid #8fcfc2;background:${COLORS.paper};font-size:12px;line-height:1.7;color:#3d5a58;">企画への示唆: ${escapeHtml(article.implications)}</p>` : ""}
${metrics ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:10px;"><tr>${metrics}</tr></table>` : ""}
${url ? `<p style="margin:12px 0 0;font-size:12px;"><a href="${escapeHtml(url)}" style="color:${COLORS.teal};text-decoration:none;">元記事を開く ↗</a></p>` : ""}
${!article.analyzed ? `<p style="margin:14px 0 0;font-size:11px;color:${COLORS.muted};">※ AI解析が終わっていないため、登録時の要約を載せています。</p>` : ""}
</td></tr>
</table>
</div>`;
}

// --- テキスト本文 ---------------------------------------------------------------------
// HTMLを表示しない環境（テキスト優先の設定・一部の携帯メール）でも読めるよう、同じ内容を
// プレーンテキストでも作って一緒に送る。

export function buildNewsMailText(input: NewsMailInput): string {
  const { article } = input;
  const businesses = input.businesses ?? DEFAULT_BUSINESSES;
  const note = sanitizeNote(input.note);
  const lines: string[] = [];
  if (note) lines.push(`【ひとこと】${note}`, "");
  lines.push(`■ ${article.title}`, `${businessLabel(businesses, article.business)}　${dateLine(article)}`, "", article.summary ?? "要約は登録されていません。");
  if (article.implications) lines.push("", `企画への示唆: ${article.implications}`);
  if (article.metrics.length > 0) lines.push("", `主な数値: ${article.metrics.slice(0, 6).map((metric) => `${metric.name} ${metric.value}`).join(" ／ ")}`);
  const url = safeUrl(article.originalUrl);
  if (url) lines.push("", url);
  if (!article.analyzed) lines.push("", "※ AI解析が終わっていないため、登録時の要約を載せています。");
  return lines.join("\n");
}

/** 件名・HTML・テキストをまとめて作る。送信APIはこの結果をそのままAIDEへ渡す。 */
export function buildNewsMail(input: NewsMailInput): NewsMailContent {
  return { subject: buildNewsMailSubject(input.subjectBody), html: buildNewsMailHtml(input), text: buildNewsMailText(input) };
}

// --- 送信リクエストの検証 ---------------------------------------------------------------

export type NewsMailRequest = { articleId: string; subjectBody: string; note: string; idempotencyKey: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `POST /api/news-mail/send`の本文を検証する。
 *
 * **本文のHTMLは受け取らない。** 受け取るのは「どの記事を送るか」・件名・ひとことだけで、本文は
 * サーバー側が記事IDでDBを引き直してから組み立てる（ブラウザから任意のHTMLを送れる口を
 * 作らないため）。空・上限超過・不正な値はnull。
 */
export function parseNewsMailRequest(body: unknown): NewsMailRequest | null {
  if (!isRecord(body)) return null;

  const articleId = typeof body.articleId === "string" ? body.articleId.trim() : "";
  if (articleId === "" || articleId.length > 100) return null;

  const subjectBody = typeof body.subjectBody === "string" ? sanitizeSubjectBody(body.subjectBody) : "";
  if (subjectBody === "" || subjectBody.length > MAX_SUBJECT_BODY_LENGTH) return null;

  const rawNote = body.note === undefined || body.note === null ? "" : body.note;
  if (typeof rawNote !== "string") return null;
  const note = sanitizeNote(rawNote);
  if (note.length > MAX_NOTE_LENGTH) return null;

  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (idempotencyKey === "" || idempotencyKey.length > 200) return null;

  return { articleId, subjectBody, note, idempotencyKey };
}

// --- 画面へ渡す形 ---------------------------------------------------------------------
// サーバーコンポーネントからクライアントコンポーネントへ渡せるのはJSONにできる値だけなので、
// 日付はISO文字列にして運び、ブラウザ側で`Date`へ戻してから本文の組み立てに使う。

export type NewsMailArticleDto = Omit<NewsMailArticle, "publishedAt" | "occurredAt" | "collectedAt"> & {
  publishedAt: string | null;
  occurredAt: string | null;
  collectedAt: string;
};

export function toNewsMailArticle(dto: NewsMailArticleDto): NewsMailArticle {
  return {
    ...dto,
    publishedAt: dto.publishedAt ? new Date(dto.publishedAt) : null,
    occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : null,
    collectedAt: new Date(dto.collectedAt),
  };
}
