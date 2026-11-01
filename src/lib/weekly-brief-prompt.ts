/**
 * 週報メールの「週の総括」（#110）のプロンプト・出力スキーマ・結果検証。
 *
 * 実行するのは記事1件ずつの解析（#79）と同じVPS上のCodex CLIで、ポーラー
 * （`scripts/codex-analysis-worker.mjs`）は`jobId`・`prompt`・`outputSchema`しか見ていないため、
 * ここで作った文面とスキーマを`POST /api/internal/analysis/claim`の応答へ載せるだけで動く
 * （ポーラーの配り直しは要らない）。
 *
 * `src/lib/analysis-prompt.ts`と同じく、Prisma・DBには触れない（`pnpm test`の対象にするため）。
 * **キー名を決めないオブジェクトをスキーマへ置かない**という#90の制約もそのまま当てはまる。
 */

// `@/`のエイリアスは`node --test`の実行時には解決されないため、相対パス＋拡張子で書く。
import { formatIsoDate, formatWeekLabel } from "./jst-week.ts";
import type { WeekRange } from "./jst-week.ts";
import { DEFAULT_BUSINESSES, businessLabel, businessShortLabel, sortBusinesses, type BusinessDef } from "./business-defs.ts";

/** 総括の対象としてプロンプトへ載せる記事。画面でチェックが入っていたものだけを渡す。 */
export type WeeklyBriefArticle = {
  title: string;
  business: string;
  sourceName: string;
  isPrimarySource: boolean;
  importance: "HIGH" | "MEDIUM" | "REFERENCE";
  publishedAt: Date | null;
  collectedAt: Date;
  summary: string | null;
  implications: string | null;
};

export type WeeklyBriefTopic = { label: string; text: string };
export type WeeklyBriefPayload = { headline: string; overview: string; topics: WeeklyBriefTopic[] };

/** 注目トピックの上限。メール冒頭に置く前提なので、読み切れる数で切る。 */
export const MAX_BRIEF_TOPICS = 4;

/** 1件あたりの要約をプロンプトへ載せる上限。記事が増えても1回の実行が枠を食い潰さないよう切る。 */
export const BRIEF_SUMMARY_LIMIT = 400;

const IMPORTANCE_LABELS = { HIGH: "高", MEDIUM: "中", REFERENCE: "参考" } as const;

function articleLine(article: WeeklyBriefArticle, index: number, businesses: readonly BusinessDef[]): string {
  const published = article.publishedAt ? formatIsoDate(article.publishedAt) : "公開日不明";
  const lines = [
    `${index + 1}. [${businessLabel(businesses, article.business)}] ${article.title}`,
    `   ${published}（取得 ${formatIsoDate(article.collectedAt)}） / ${article.sourceName} / ${article.isPrimarySource ? "一次情報" : "関連記事"} / 重要度 ${IMPORTANCE_LABELS[article.importance]}`,
  ];
  if (article.summary) lines.push(`   要約: ${article.summary.slice(0, BRIEF_SUMMARY_LIMIT)}`);
  if (article.implications) lines.push(`   示唆: ${article.implications.slice(0, BRIEF_SUMMARY_LIMIT)}`);
  return lines.join("\n");
}

/**
 * 総括のプロンプトを組み立てる。
 *
 * 記事1件ずつの解析と違い、ここで欲しいのは**横断の見立て**なので、個々の記事の要約を
 * 繰り返させない。出力の形はJSON Schemaで縛るため、キー名の列挙はしない。
 */
export function buildWeeklyBriefPrompt(range: WeekRange, articles: WeeklyBriefArticle[], businesses: BusinessDef[] = DEFAULT_BUSINESSES): string {
  const defs = sortBusinesses(businesses);
  const countsText = defs.map((def) => `${businessShortLabel(defs, def.key)} ${articles.filter((article) => article.business === def.key).length}件`).join(" ／ ");
  return [
    "あなたは戸建て・集合住宅向けのエクステリア（宅配ボックス・ポスト・機能門柱）とマルチロッカー事業を手がけ、生成AI（Gemini・Copilot）の業務活用も追うメーカーの商品企画担当を支援するリサーチャーです。",
    `以下は${formatWeekLabel(range)}の業界ニュースのうち、担当者が「社内へ共有する」と選んだ記事の一覧です。`,
    "これらを横断して読み、週報メールの冒頭に置く総括を書いてください。指定されたJSON Schemaに合うJSONだけを最終応答として返し、説明文・前置き・コードフェンスは付けないでください。",
    "",
    "## 書いてほしい内容",
    "",
    "- headline: この週を一行で言い表す見出し（30字程度）。「〜が相次いだ週」のように、何が起きた週なのかが分かる書き方にする",
    "- overview: 全体像（200〜300字）。個々の記事の要約を並べ直すのではなく、**複数の記事に共通する流れ・対立・変化**を書く。当社が次に何を見るべきかを1文で締める",
    `- topics: 注目トピックを最大${MAX_BRIEF_TOPICS}件。label は「制度」「製品」「拠点」「競合」のような2〜4字の分類、text はその内容を1文（60字程度）で書く。重要度が高いもの・一次情報を優先する`,
    "",
    "事実に無いことを足さないでください。一覧に書かれていないことは書かず、断定できないものは「〜とみられる」と書きます。",
    "",
    `## 対象の記事（${countsText}）`,
    "",
    articles.length > 0 ? articles.map((article, index) => articleLine(article, index, defs)).join("\n") : "（対象の記事がありません）",
  ].join("\n");
}

/**
 * `codex exec --output-schema`へ渡すJSON Schema。
 *
 * 構造化出力は「全プロパティが required」「`additionalProperties: false`」を要求する。
 * キー名を決めないオブジェクトは置かない（#90。置くとモデルを呼ぶ前に400で落ちる）。
 */
export function buildWeeklyBriefSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["headline", "overview", "topics"],
    properties: {
      headline: { type: "string" },
      overview: { type: "string" },
      topics: {
        type: "array",
        maxItems: MAX_BRIEF_TOPICS,
        items: { type: "object", additionalProperties: false, required: ["label", "text"], properties: { label: { type: "string" }, text: { type: "string" } } },
      },
    },
  };
}

// --- 結果の検証 -----------------------------------------------------------------------

export type WeeklyBriefParseResult = { ok: true; value: WeeklyBriefPayload } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function topics(value: unknown): WeeklyBriefTopic[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .flatMap((item) => {
      const text = requiredString(item.text);
      // labelは分類の札で、無くても本文は読める。textが無い要素だけを落とす。
      return text ? [{ label: requiredString(item.label) ?? "", text }] : [];
    })
    .slice(0, MAX_BRIEF_TOPICS);
}

/**
 * Codexが返したJSONを検証する。
 *
 * `headline`と`overview`が欠けていたら総括として使えないので保存しない。`topics`は
 * 空でも本文は成立するため、読めた要素だけを残す（記事解析の`parseAnalysisPayload()`と同じ方針）。
 */
export function parseWeeklyBriefPayload(raw: unknown): WeeklyBriefParseResult {
  if (!isRecord(raw)) return { ok: false, error: "総括の結果がオブジェクトではありません" };
  const headline = requiredString(raw.headline);
  if (!headline) return { ok: false, error: "headlineが空です" };
  const overview = requiredString(raw.overview);
  if (!overview) return { ok: false, error: "overviewが空です" };
  return { ok: true, value: { headline, overview, topics: topics(raw.topics) } };
}

/** DBのJSON列から読んだ`topics`を表示用に戻す。壊れた値は無視する（`toMergedSources()`と同じ）。 */
export function toWeeklyBriefTopics(value: unknown): WeeklyBriefTopic[] {
  return topics(value);
}
