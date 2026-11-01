/**
 * 週報メール（#110）の件名・本文の組み立てと、送信リクエストの検証。
 *
 * **Prisma・Reactに触れない純粋な関数だけを置く。** 理由は2つある。
 *
 * 1. `pnpm test`（`node --test`）から直接読めるようにするため（`src/lib/triage.ts`と同じ方針）
 * 2. **同じ関数を画面のプレビューと送信の両方から使うため。** ブラウザ側は選択中の記事から
 *    `buildNewsMailHtml()`を呼んでそのまま差し込み、サーバー側は記事IDでDBを引き直してから
 *    同じ関数を呼ぶ。プレビューと実際に送る本文が別実装になると、片方だけ直して食い違う
 *
 * HTMLはメールクライアント向けに**tableとインラインスタイルだけ**で組む。Gmailは`<style>`の
 * 一部やflex/gridを落とすため、レイアウトはtableで作り、色・余白は各要素へ直接書く。
 * 図（事業別の件数バー）も画像ではなく、幅を指定したtableのセルで描く——画像はGmailの
 * 初期表示でブロックされることがあり、その場合に何も読めなくなるため。
 */

// `node --test`（型を剥がしてTypeScriptのまま実行する）から読めるよう、依存は相対パス＋拡張子
// つきで書く。`@/`のエイリアスはtsconfigのpathsで、Nodeの実行時解決には効かない。
import { formatIsoDate, formatWeekLabel, isWithinWeek, OLDEST_WEEK_OFFSET } from "./jst-week.ts";
import type { WeekRange } from "./jst-week.ts";
import { DEFAULT_BUSINESSES, businessLabel, businessShortLabel, sortBusinesses, type BusinessDef } from "./business-defs.ts";
import type { WeeklyBriefTopic } from "./weekly-brief-prompt.ts";

/** 件名の固定接頭辞。画面からは変更できない（画像メールの`[画像]`と同じ扱い）。 */
export const SUBJECT_PREFIX = "[業界ニュース]";

/** 件名のうち利用者が編集できる部分の上限。 */
export const MAX_SUBJECT_BODY_LENGTH = 160;

/** 1通に載せられる記事数の上限。1週ぶんの保持上限（事業ごと15件＝30件）に余裕を足した値。 */
export const MAX_MAIL_ARTICLES = 60;

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

export type NewsMailBrief = { headline: string; overview: string; topics: WeeklyBriefTopic[] };

export type NewsMailInput = {
  range: WeekRange;
  subjectBody: string;
  articles: NewsMailArticle[];
  brief: NewsMailBrief | null;
  /** 事業区分のマスタ。省略時は初期値。 */
  businesses?: BusinessDef[];
};

export type NewsMailContent = { subject: string; html: string; text: string };

const IMPORTANCE_LABELS: Record<MailImportance, string> = { HIGH: "高", MEDIUM: "中", REFERENCE: "参考" };
const IMPORTANCE_ORDER: MailImportance[] = ["HIGH", "MEDIUM", "REFERENCE"];

const COLORS = {
  navy: "#1d3440",
  teal: "#087f78",
  tealPale: "#e2f3ef",
  orange: "#d97735",
  violet: "#7a5bc7",
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

/**
 * その記事が「公開日ではなく、この週に取得したこと」で一覧に入っているか（#110）。
 *
 * 公開日（無ければ発生日）がこの週の外で、収集日がこの週の中にある記事を指す。どちらの日付も
 * 未設定の記事は元々収集日で週が決まるため、ここでは「取得のみ」とは呼ばない。
 * DB側の絞り込み（`weekConditionByBasis()`）の判定を厳密に写したものではなく、
 * **利用者へ「なぜこの記事が出ているか」を示すための表示上の目印**として使う。
 */
export function isCollectedOnly(article: Pick<NewsMailArticle, "publishedAt" | "occurredAt" | "collectedAt">, range: WeekRange): boolean {
  const reference = article.publishedAt ?? article.occurredAt;
  if (reference === null) return false;
  return !isWithinWeek(reference, range) && isWithinWeek(article.collectedAt, range);
}

/** 件名の編集できる部分の初期値。 */
export function defaultSubjectBody(range: WeekRange, articleCount: number): string {
  return `${formatWeekLabel(range)} の業界ニュース（${articleCount}件）`;
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

export type NewsMailCounts = {
  total: number;
  byBusiness: { business: MailBusiness; count: number }[];
  byImportance: { importance: MailImportance; count: number }[];
  primarySource: number;
  collectedOnly: number;
  unanalyzed: number;
};

/** メール冒頭の内訳（図の元になる数）。画面の帯とメールで同じ数字を出すためここで数える。 */
export function countNewsMailArticles(articles: NewsMailArticle[], range: WeekRange, businesses: BusinessDef[] = DEFAULT_BUSINESSES): NewsMailCounts {
  return {
    total: articles.length,
    byBusiness: sortBusinesses(businesses).map((def) => def.key).map((business) => ({ business, count: articles.filter((article) => article.business === business).length })),
    byImportance: IMPORTANCE_ORDER.map((importance) => ({ importance, count: articles.filter((article) => article.importance === importance).length })),
    primarySource: articles.filter((article) => article.isPrimarySource).length,
    collectedOnly: articles.filter((article) => isCollectedOnly(article, range)).length,
    unanalyzed: articles.filter((article) => !article.analyzed).length,
  };
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

function dateLine(article: NewsMailArticle, range: WeekRange): string {
  const published = article.publishedAt ?? article.occurredAt;
  const parts = [published ? `${formatIsoDate(published)} 公開` : "公開日不明", article.sourceName, article.isPrimarySource ? "一次情報" : "関連記事", `重要度 ${IMPORTANCE_LABELS[article.importance]}`];
  if (isCollectedOnly(article, range)) parts.push(`この週に取得（${formatIsoDate(article.collectedAt)}）`);
  if (!article.analyzed) parts.push("AI解析なし");
  return parts.join(" ／ ");
}

function barRow(label: string, count: number, max: number, color: string): string {
  const percent = max > 0 ? Math.max(4, Math.round((count / max) * 100)) : 0;
  return `<tr>
<td style="padding:3px 0;width:96px;font-size:12px;color:${COLORS.body};">${escapeHtml(label)}</td>
<td style="padding:3px 8px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background:${COLORS.ground};border-radius:3px;">
<tr><td width="${percent}%" style="background:${color};font-size:0;line-height:14px;height:14px;border-radius:3px;">&nbsp;</td><td style="font-size:0;line-height:14px;height:14px;">&nbsp;</td></tr>
</table>
</td>
<td style="padding:3px 0;width:36px;text-align:right;font-size:12px;font-weight:bold;color:${COLORS.ink};">${count}</td>
</tr>`;
}

function pill(text: string, strong: boolean): string {
  const background = strong ? COLORS.tealPale : COLORS.ground;
  const color = strong ? COLORS.teal : COLORS.muted;
  return `<td style="padding:0 6px 6px 0;"><span style="display:inline-block;padding:4px 9px;border-radius:6px;background:${background};color:${color};font-size:11px;${strong ? "font-weight:bold;" : ""}">${escapeHtml(text)}</span></td>`;
}

function sectionHeading(text: string, note: string | null): string {
  return `<p style="margin:0 0 8px;font-size:11px;letter-spacing:.08em;color:${COLORS.teal};font-weight:bold;">${escapeHtml(text)}${note ? `<span style="margin-left:8px;padding:2px 7px;border-radius:99px;background:${COLORS.tealPale};color:${COLORS.teal};font-size:10px;font-weight:normal;">${escapeHtml(note)}</span>` : ""}</p>`;
}

function briefBlock(brief: NewsMailBrief): string {
  const topics = brief.topics.length
    ? `<div style="margin-top:16px;">${sectionHeading("注目トピック", "AIが選びました")}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
${brief.topics
  .map(
    (topic, index) => `<tr>
<td valign="top" style="padding:0 9px 7px 0;width:22px;"><span style="display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;border-radius:11px;background:${COLORS.navy};color:#ffffff;font-size:10px;font-weight:bold;">${index + 1}</span></td>
<td valign="top" style="padding:0 0 7px;font-size:12px;line-height:1.6;color:${COLORS.body};">${topic.label ? `<b style="color:${COLORS.ink};">${escapeHtml(topic.label)}</b>　` : ""}${escapeHtml(topic.text)}</td>
</tr>`,
  )
  .join("\n")}
</table></div>`
    : "";

  return `<div style="margin-bottom:18px;">
${sectionHeading("今週の全体像", "AIがまとめました")}
<p style="margin:0 0 6px;font-size:14px;font-weight:bold;color:${COLORS.ink};line-height:1.5;">${escapeHtml(brief.headline)}</p>
<p style="margin:0;padding:11px 13px;background:${COLORS.paper};border:1px solid ${COLORS.line};border-radius:8px;font-size:12px;line-height:1.8;color:${COLORS.body};">${escapeHtml(brief.overview)}</p>
${topics}
</div>`;
}

function countsBlock(counts: NewsMailCounts, businesses: BusinessDef[]): string {
  const max = Math.max(...counts.byBusiness.map((row) => row.count), 1);
  const pills = [
    ...counts.byImportance.map((row) => ({ text: `重要度 ${IMPORTANCE_LABELS[row.importance]}　${row.count}件`, strong: row.importance === "HIGH" && row.count > 0 })),
    { text: `一次情報　${counts.primarySource}件`, strong: false },
  ];
  return `<div style="margin-bottom:18px;">
${sectionHeading("内訳", null)}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
${counts.byBusiness.map((row) => barRow(businessLabel(businesses, row.business), row.count, max, COLORS[businesses.find((def) => def.key === row.business)?.color ?? "teal"])).join("\n")}
</table>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:9px;"><tr>${pills.map((item) => pill(item.text, item.strong)).join("")}</tr></table>
</div>`;
}

function articleBlock(article: NewsMailArticle, range: WeekRange): string {
  const url = safeUrl(article.originalUrl);
  const metrics = article.metrics
    .slice(0, 6)
    .map((metric) => `<td style="padding:0 6px 6px 0;"><span style="display:inline-block;padding:3px 8px;border-radius:5px;background:${COLORS.ground};color:#4a6260;font-size:11px;">${escapeHtml(metric.name)} <b style="color:${COLORS.teal};">${escapeHtml(metric.value)}</b></span></td>`)
    .join("");

  return `<div style="border-top:1px solid ${COLORS.line};padding-top:11px;margin-top:11px;">
<p style="margin:0;font-size:13px;line-height:1.5;font-weight:bold;color:${COLORS.ink};">${escapeHtml(article.title)}</p>
<p style="margin:3px 0 6px;font-size:11px;color:${COLORS.muted};">${escapeHtml(dateLine(article, range))}</p>
<p style="margin:0;font-size:12px;line-height:1.75;color:${COLORS.body};">${escapeHtml(article.summary ?? "要約は登録されていません。")}</p>
${article.implications ? `<p style="margin:7px 0 0;padding:8px 10px;border-left:2px solid #8fcfc2;background:${COLORS.paper};font-size:11.5px;line-height:1.7;color:#3d5a58;">企画への示唆: ${escapeHtml(article.implications)}</p>` : ""}
${metrics ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:7px;"><tr>${metrics}</tr></table>` : ""}
${url ? `<p style="margin:7px 0 0;font-size:11px;"><a href="${escapeHtml(url)}" style="color:${COLORS.teal};text-decoration:none;">元記事を開く ↗</a></p>` : ""}
</div>`;
}

/** 図解つきのHTML本文。画面のプレビューにもこの文字列をそのまま差し込む。 */
export function buildNewsMailHtml(input: NewsMailInput): string {
  const businesses = input.businesses ?? DEFAULT_BUSINESSES;
  const counts = countNewsMailArticles(input.articles, input.range, businesses);
  const sections = counts.byBusiness.map((row) => row.business).flatMap((business) => {
    const items = input.articles.filter((article) => article.business === business);
    if (items.length === 0) return [];
    return [
      `<div style="margin-bottom:18px;">
${sectionHeading(`${businessLabel(businesses, business)}（${items.length}件）`, null)}
${items.map((article) => articleBlock(article, input.range)).join("\n")}
</div>`,
    ];
  }).join("\n");

  const heroNote = counts.byBusiness.map((row) => `${businessShortLabel(businesses, row.business)} ${row.count}件`).join(" ／ ")
    + (counts.collectedOnly > 0 ? `　·　うちこの週に取得して拾った記事 ${counts.collectedOnly}件` : "");

  return `<div style="margin:0;padding:16px;background:${COLORS.ground};font-family:${FONT};">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;max-width:640px;margin:0 auto;background:#ffffff;border-radius:6px;">
<tr><td style="padding:18px 20px;background:${COLORS.navy};border-radius:6px 6px 0 0;">
<p style="margin:0;font-size:10px;letter-spacing:.16em;color:#7fdfc9;font-weight:bold;">WEEKLY INDUSTRY BRIEF</p>
<p style="margin:5px 0 0;font-size:17px;font-weight:bold;color:#ffffff;">業界ニュース週報　${escapeHtml(formatWeekLabel(input.range))}</p>
<p style="margin:4px 0 0;font-size:11px;color:#a9c6c3;">${escapeHtml(heroNote)}</p>
</td></tr>
<tr><td style="padding:18px 20px;">
${input.brief ? briefBlock(input.brief) : `<p style="margin:0 0 18px;padding:10px 12px;background:${COLORS.paper};border:1px dashed ${COLORS.line};border-radius:8px;font-size:11.5px;color:${COLORS.muted};">この週の総括はまだ作成していません。記事の一覧のみをお送りします。</p>`}
${counts.total > 0 ? countsBlock(counts, businesses) : ""}
${sections || `<p style="margin:0;font-size:12px;color:${COLORS.muted};">送る記事が選ばれていません。</p>`}
${counts.unanalyzed > 0 ? `<p style="margin:16px 0 0;font-size:11px;color:${COLORS.muted};">※ ${counts.unanalyzed}件はAI解析が終わっていないため、登録時の要約を載せています。</p>` : ""}
</td></tr>
</table>
</div>`;
}

// --- テキスト本文 ---------------------------------------------------------------------
// HTMLを表示しない環境（テキスト優先の設定・一部の携帯メール）でも読めるよう、同じ内容を
// プレーンテキストでも作って一緒に送る。

export function buildNewsMailText(input: NewsMailInput): string {
  const businesses = input.businesses ?? DEFAULT_BUSINESSES;
  const counts = countNewsMailArticles(input.articles, input.range, businesses);
  const lines: string[] = [`業界ニュース週報　${formatWeekLabel(input.range)}`, counts.byBusiness.map((row) => `${businessShortLabel(businesses, row.business)} ${row.count}件`).join(" ／ ")];
  if (counts.collectedOnly > 0) lines.push(`うちこの週に取得して拾った記事 ${counts.collectedOnly}件`);
  lines.push("");

  if (input.brief) {
    lines.push("■ 今週の全体像（AIがまとめました）", input.brief.headline, "", input.brief.overview, "");
    if (input.brief.topics.length > 0) {
      lines.push("■ 注目トピック（AIが選びました）");
      input.brief.topics.forEach((topic, index) => lines.push(`${index + 1}. ${topic.label ? `[${topic.label}] ` : ""}${topic.text}`));
      lines.push("");
    }
  }

  lines.push("■ 内訳");
  for (const row of counts.byBusiness) lines.push(`- ${businessLabel(businesses, row.business)}: ${row.count}件`);
  lines.push(`- 重要度: ${counts.byImportance.map((row) => `${IMPORTANCE_LABELS[row.importance]} ${row.count}件`).join(" / ")}`);
  lines.push(`- 一次情報: ${counts.primarySource}件`, "");

  for (const business of counts.byBusiness.map((row) => row.business)) {
    const items = input.articles.filter((article) => article.business === business);
    if (items.length === 0) continue;
    lines.push(`■ ${businessLabel(businesses, business)}（${items.length}件）`, "");
    for (const article of items) {
      lines.push(`・${article.title}`, `  ${dateLine(article, input.range)}`, `  ${article.summary ?? "要約は登録されていません。"}`);
      if (article.implications) lines.push(`  企画への示唆: ${article.implications}`);
      if (article.metrics.length > 0) lines.push(`  主な数値: ${article.metrics.slice(0, 6).map((metric) => `${metric.name} ${metric.value}`).join(" ／ ")}`);
      const url = safeUrl(article.originalUrl);
      if (url) lines.push(`  ${url}`);
      lines.push("");
    }
  }

  if (counts.unanalyzed > 0) lines.push(`※ ${counts.unanalyzed}件はAI解析が終わっていないため、登録時の要約を載せています。`);
  return lines.join("\n");
}

/** 件名・HTML・テキストをまとめて作る。送信APIはこの結果をそのままAIDEへ渡す。 */
export function buildNewsMail(input: NewsMailInput): NewsMailContent {
  return { subject: buildNewsMailSubject(input.subjectBody), html: buildNewsMailHtml(input), text: buildNewsMailText(input) };
}

// --- 送信リクエストの検証 ---------------------------------------------------------------

export type NewsMailRequest = { articleIds: string[]; subjectBody: string; weekOffset: number; basis: string; idempotencyKey: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `POST /api/news-mail/send`の本文を検証する。
 *
 * **本文のHTMLは受け取らない。** 受け取るのは「どの記事を送るか」と件名だけで、本文は
 * サーバー側が記事IDでDBを引き直してから組み立てる（ブラウザから任意のHTMLを送れる口を
 * 作らないため）。重複IDは1つにまとめ、空・上限超過・不正な値はnull。
 */
export function parseNewsMailRequest(body: unknown): NewsMailRequest | null {
  if (!isRecord(body)) return null;

  const articleIds = Array.isArray(body.articleIds) ? [...new Set(body.articleIds.filter((id): id is string => typeof id === "string" && id.trim() !== ""))] : [];
  if (articleIds.length === 0 || articleIds.length > MAX_MAIL_ARTICLES) return null;

  const subjectBody = typeof body.subjectBody === "string" ? sanitizeSubjectBody(body.subjectBody) : "";
  if (subjectBody === "" || subjectBody.length > MAX_SUBJECT_BODY_LENGTH) return null;

  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (idempotencyKey === "" || idempotencyKey.length > 200) return null;

  // 週送りで遡れる範囲は画面と揃える（`OLDEST_WEEK_OFFSET`）。ここだけ広いと、画面から
  // 到達できない週の総括と紐付いたリクエストを受け付けてしまう。
  const weekOffset = typeof body.weekOffset === "number" && Number.isInteger(body.weekOffset) ? body.weekOffset : null;
  if (weekOffset === null || weekOffset > 0 || weekOffset < OLDEST_WEEK_OFFSET) return null;

  const basis = body.basis === "published" || body.basis === "collected" || body.basis === "either" ? body.basis : null;
  if (basis === null) return null;

  return { articleIds, subjectBody, weekOffset, basis, idempotencyKey };
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
