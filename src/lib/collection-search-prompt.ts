/**
 * 業界ニュースの「収集ジョブ」（Codex CLIのWeb検索）のプロンプト・出力スキーマ・結果検証。
 *
 * これまではChatGPTの定期タスクが毎日20:00に直近7日分を検索・選定・要約し、AIDE経由で
 * `POST /api/internal/weekly-report`へ登録していた（aideの`docs/chatgpt-mcp.md`）。その作業を、
 * 記事解析（#79）・週の総括（#110）と同じVPS上のCodex CLIへ移す。ポーラー
 * （`scripts/codex-analysis-worker.mjs`）は`jobId`・`prompt`・`outputSchema`しか見ないため、
 * ここで作った文面とスキーマをclaimの応答へ載せるだけで動く。
 *
 * **出力の形は週報登録API（`WeeklyReportArticle`）に揃えてある。** 受け取った結果は
 * `importWeeklyReport()`へそのまま渡して取り込むので、URL一致の冪等性・同一イベントの統合・
 * 週あたり上限は、AIDE経由の登録と同じ規則で働く。
 *
 * `src/lib/analysis-prompt.ts`と同じく、Prisma・DBには触れない（`pnpm test`の対象にするため）。
 * **キー名を決めないオブジェクトをスキーマへ置かない**という#90の制約もそのまま当てはまる。
 */

// `@/`のエイリアスは`node --test`の実行時には解決されないため、相対パス＋拡張子で書く。
import { DEFAULT_BUSINESSES, businessKeys, sortBusinesses, type BusinessDef } from "./business-defs.ts";
import { formatIsoDate } from "./jst-week.ts";

export type CollectedBusiness = string;
export type CollectedImportance = "HIGH" | "MEDIUM" | "REFERENCE";
export type CollectedPeriodScope = "IN_SCOPE" | "PAST_30_DAYS_SUPPLEMENT";

/** `POST /api/internal/weekly-report`の`informationType`と同じ値（`prisma/schema.prisma`の列挙と一致）。 */
export const COLLECTED_INFORMATION_TYPES = [
  "NEW_PRODUCT",
  "COMPETITOR",
  "INTRODUCTION_CASE",
  "RECRUITMENT_PARTNERSHIP",
  "POLICY_SUBSIDY",
  "MARKET_STATISTICS",
  "USER_ISSUE",
  "CONSTRUCTION",
  "QUALITY_SAFETY",
  "PATENT",
  "ACADEMIC_RESEARCH",
  "VIDEO",
  "SOCIAL_TREND",
  "OVERSEAS_CASE",
  "OTHER",
] as const;
export type CollectedInformationType = (typeof COLLECTED_INFORMATION_TYPES)[number];

/**
 * 1回の収集で受け取る記事の上限。AIDE経由の週報登録（`/api/internal/weekly-report`）の
 * 入力上限（各事業5件）に揃えてある。全体はAIDE中継の上限（10件）には縛られず、
 * 事業が3区分になった（#362）ぶん15件にしている（この経路は`importWeeklyReport()`を直接呼ぶ）。
 */
export const COLLECTION_SEARCH_ARTICLE_LIMIT = 15;
export const COLLECTION_SEARCH_ARTICLE_LIMIT_PER_BUSINESS = 5;
/**
 * 区分ごとの上限の上書き。AI関連は件数が多くなりやすく、大きな新機能・活用事例だけを見たいため
 * 3件にする（#424）。該当が無い週は0件でよい。
 */
export const COLLECTION_SEARCH_ARTICLE_LIMIT_BY_BUSINESS: Record<string, number> = { AI: 3 };

export function articleLimitFor(business: string): number {
  return COLLECTION_SEARCH_ARTICLE_LIMIT_BY_BUSINESS[business] ?? COLLECTION_SEARCH_ARTICLE_LIMIT_PER_BUSINESS;
}

/** 検索の対象期間（日）。古い記事で件数を埋めないため補充期間は設けない。 */
export const COLLECTION_SEARCH_WINDOW_DAYS = 7;

/**
 * ポーラーがこのジョブに使う実行上限（秒）。Web検索をしながら選定・要約まで行うため、記事1件の
 * 解析（既定600秒）より長く取る。**ポーラーの保持期限（`LEASE_SECONDS`＝900秒）より短く**して
 * おかないと、実行中にリースが切れて別のポーラーが同じジョブを取り直す。
 */
export const COLLECTION_SEARCH_TIMEOUT_SECONDS = 780;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 文字列の保存上限。実行ログや長文をそのまま溜め込まないための切り詰め。 */
const TITLE_LIMIT = 500;
const SOURCE_NAME_LIMIT = 500;
const URL_LIMIT = 512;
const TEXT_LIMIT = 2000;
const LIST_ITEM_LIMIT = 100;
const LIST_LIMIT = 20;
const METRICS_MAX_KEYS = 30;
const METRICS_MAX_JSON_LENGTH = 2000;

/**
 * 収集のプロンプトを組み立てる。
 *
 * **既に登録済みの記事は渡さない。** 渡せば新規性は上がるが、ChatGPT定期タスクと並べて
 * 品質を見比べる間は、両者が独立に選んだ結果を比べたい（渡すと重なりが見えなくなる）。
 * 重複はURL一致と同一イベントの統合（#43）が取り込み側で処理する。
 */
export type RejectedArticle = { title: string; reason: string | null };
export type CollectionSearchBusinessContext = { policy: string; instruction: string | null; rejectedArticles: RejectedArticle[]; existingArticles: { title: string; summary: string | null; url: string }[] };
/** 事業区分のキー → その区分の判定基準・不採用記事・掲載済み記事。 */
export type CollectionSearchPolicyContext = Record<string, CollectionSearchBusinessContext>;

function businessPolicySection(label: string, business: CollectionSearchBusinessContext): string[] {
  return [
    `### ${label}`,
    "",
    business.policy,
    ...(business.rejectedArticles.length
      ? ["", "利用者が不採用にした記事（同じ傾向を避ける参考。理由が添えられているものは特に重視する）:", ...business.rejectedArticles.map((article) => `- ${article.title}${article.reason ? `（理由: ${article.reason}）` : ""}`)]
      : []),
    ...(business.instruction ? ["", "利用者からの調整指示:", business.instruction] : []),
    ...(business.existingArticles.length ? ["", "同じ週に掲載済みの記事（新規・更新差分の確認に使う）:", ...business.existingArticles.map((article) => `- ${article.title}: ${article.summary ?? "要約なし"} (${article.url})`)] : []),
    "",
  ];
}

export function buildCollectionSearchPrompt(now: Date, context?: CollectionSearchPolicyContext, businesses: BusinessDef[] = DEFAULT_BUSINESSES): string {
  const defs = sortBusinesses(businesses);
  const windowStart = new Date(now.getTime() - COLLECTION_SEARCH_WINDOW_DAYS * DAY_MS);
  return [
    "あなたは戸建て・集合住宅向けのエクステリア（宅配ボックス・ポスト・機能門柱）とマルチロッカー事業を手がけ、生成AI（Gemini・Copilot）の業務活用も追うメーカーの商品企画担当を支援するリサーチャーです。",
    "Web検索を使って、下記の${defs.length}区分に関する業界ニュースを集め、選び、要約してください。指定されたJSON Schemaに合うJSONだけを最終応答として返し、説明文・前置き・コードフェンスは付けないでください。",
    "",
    "## 対象の事業",
    "",
    ...defs.map((def) => `- ${def.label}（${def.key}）: ${def.scope}`),
    "",
    ...(context
      ? [
          "## 現在の検索・判定基準（事業ごと）",
          "",
          ...defs.flatMap((def) => context[def.key] ? businessPolicySection(`${def.label}（${def.key}）`, context[def.key]) : []),
          "この基準と不採用記事を踏まえて記事を選んでください。収集後は nextPolicies に、区分ごと（business）に次回以降に使う改善済みの検索・判定基準（policy）を簡潔に書いてください。",
          "",
        ]
      : []),
    "## 対象期間",
    "",
    `- 今日は${formatIsoDate(now)}（JST）です。実行時点から直近${COLLECTION_SEARCH_WINDOW_DAYS}日（${formatIsoDate(windowStart)}以降）に公開・発表された記事だけを選び、periodScope は IN_SCOPE にします。古い記事で件数を埋めないでください。`,
    "",
    "## 選び方",
    "",
    `- 事業ごとに${COLLECTION_SEARCH_ARTICLE_LIMIT_PER_BUSINESS}件まで、合計${COLLECTION_SEARCH_ARTICLE_LIMIT}件までを目安にします。該当する記事が少ない事業は、無理に埋めず少ない件数のままにしてください。`,
    `- 区分（${defs.map((def) => def.label).join("・")}）を別々に検索・選定します。確認する観点は区分ごとに次のとおりです。${defs.map((def) => `${def.label}は${def.scope}`).join("。")}。`,
    "- 各事業で国内検索と英語による海外検索を必ず行い、米国・欧州・アジア／オセアニアの一次情報を確認します。通常ニュースに加え、査読論文・行政調査、特許公報、企業公式・放送局の動画、ログイン不要の公開SNSを毎回確認します。",
    "- 学術は公開日・査読状況・研究地域・主要条件／数値・DOI等の原典を確認します。特許は番号・権利者・優先日・法的状態・示唆を確認し、同じ特許ファミリーは1件へ統合します。FTO・侵害等の法的判断はしません。動画は放送予定と放送後の新情報を統合します。SNSは個人情報・晒し・噂・生成AI捏造を除外し、反応数／複数投稿傾向／現場性／具体的な仕様・運用課題がある公開情報だけを扱います。",
    "- 同じ週の既存記事と比べ、同一発表・導入・実証・制度変更・数値発表・特許ファミリーは増やさず、数値・地域・仕様・利用者反応の差分があれば既存記事の更新として扱います。一次情報を主リンクにし、補足記事とSNS反応は同じ記事に集約します。商品企画・全体設計への示唆を説明できない情報は採用しません。",
    "- 商品企画・全体設計の判断に効くものを優先します。新商品・競合の動き・導入事例・制度や補助金・市場統計・ユーザーの課題・品質や安全・海外事例などです。",
    "- 公式発表・行政・企業のニュースリリースなど一次情報を優先し、その記事の isPrimarySource を true にします。転載・解説記事しか見つからないときは false にし、可能なら元の発表元を publisher・targetCompany に入れてください。",
    "- 同じ発表を報じた複数の記事は1件にまとめ、最も原典に近いものを選びます。",
    "- 語句が一致するだけで、各区分の話題が背景や小道具としてしか出てこない記事（芸能・スポーツ・事件など）は選ばないでください。",
    "",
    ...(defs.some((def) => def.key === "AI")
      ? [
          "## AI関連の絞り込み（他の基準・調整指示より優先）",
          "",
          `- AI関連は大きな変更点だけを扱い、${articleLimitFor("AI")}件までにします。無理に埋めず、該当が無ければ0件で構いません。`,
          "- 採用するのは、(1) 主要な新機能・大型アップデート・新プランの追加、(2) 業務でどう活用されているかが具体的に分かる活用事例、のどちらかです。importance が HIGH 相当のものだけを選びます。",
          "- 次のものは採用しません: 企業の参入・提携・人事・資金調達・買収の話、細かい料金改定、小規模な修正・軽微なアップデート、噂・予想、単なる解説・入門記事。",
          "",
        ]
      : []),
    "## 各記事に付ける内容",
    "",
    "- title・url・sourceName（媒体名）: 検索で実際に開いて確認できた記事のものだけを書きます。**URLを推測で作らない。** 検索サービスのリダイレクトURLではなく、記事そのもののURLを書いてください。",
    "- publisher（発表元）・targetCompany・targetProduct: 分かる範囲で入れます。targetProduct は同一イベントの判定に使うので、製品・サービス名が分かるときは必ず入れてください。",
    "- publishedAt（公開日時）・occurredAt（事象の発生日時）: ISO 8601。region（国・地域）: 分かる範囲で入れます。分からなければ null にします。",
    "- informationType: 情報の種別。importance: HIGH（高）／MEDIUM（中）／REFERENCE（参考）。",
    "- summary: 記事の要約（200字程度）。**記事が英語などの外国語でも、必ず日本語で書きます。** 外国語の記事は、冒頭の1文で「誰が・何を発表した記事か」を日本語で示し、利用者が題名を読まなくても採用判断できるようにします。固有名詞・製品名は原語のままで構いません。",
    "- implications: 商品企画・全体設計への示唆。当社が何を検討すべきかという形で書きます。",
    "- extractedMetrics: 設置台数・金額・発売時期などの数字が記事に出ているときだけ、1件ずつ name（項目名）と value（単位つきの文字列）に分けた配列にします。無ければ空の配列にします。",
    "- keywords・tags: 検索や分類に使う語。",
    "- searchReport: 実際に確認した地域・情報源・検索テーマを列挙します。0件でも必ず返します。",
    "",
    "事実に無いことを足さないでください。記事に書かれていないことは書かず、断定できないものは「〜とみられる」と書きます。",
  ].join("\n");
}

/**
 * `codex exec --output-schema`へ渡すJSON Schema。
 *
 * 構造化出力は「全プロパティが required」「`additionalProperties: false`」を要求する。省略できる
 * 項目は`["string","null"]`で表す。キー名を決めないオブジェクト（数値の項目名など）は置かず、
 * `{ name, value }`の配列で受ける（#90。置くとモデルを呼ぶ前に400で落ちる）。
 */
export function buildCollectionSearchSchema(businesses: BusinessDef[] = DEFAULT_BUSINESSES): Record<string, unknown> {
  const keys = businessKeys(businesses);
  const nullableString = { type: ["string", "null"] };
  return {
    type: "object",
    additionalProperties: false,
    required: ["articles", "nextPolicies", "searchReport"],
    properties: {
      articles: {
        type: "array",
        maxItems: COLLECTION_SEARCH_ARTICLE_LIMIT,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "business",
            "informationType",
            "title",
            "url",
            "sourceName",
            "publisher",
            "isPrimarySource",
            "publishedAt",
            "occurredAt",
            "summary",
            "implications",
            "importance",
            "targetCompany",
            "targetProduct",
            "region",
            "keywords",
            "tags",
            "periodScope",
            "extractedMetrics",
          ],
          properties: {
            business: { type: "string", enum: keys },
            informationType: { type: "string", enum: [...COLLECTED_INFORMATION_TYPES] },
            title: { type: "string" },
            url: { type: "string" },
            sourceName: { type: "string" },
            publisher: nullableString,
            isPrimarySource: { type: "boolean" },
            publishedAt: nullableString,
            occurredAt: nullableString,
            summary: nullableString,
            implications: nullableString,
            importance: { type: "string", enum: ["HIGH", "MEDIUM", "REFERENCE"] },
            targetCompany: nullableString,
            targetProduct: nullableString,
            region: nullableString,
            keywords: { type: "array", items: { type: "string" } },
            tags: { type: "array", items: { type: "string" } },
            periodScope: { type: "string", enum: ["IN_SCOPE", "PAST_30_DAYS_SUPPLEMENT"] },
            extractedMetrics: {
              type: "array",
              items: { type: "object", additionalProperties: false, required: ["name", "value"], properties: { name: { type: "string" }, value: { type: "string" } } },
            },
          },
        },
      },
      // 区分名をキーにしたオブジェクトは構造化出力で使えない（analysis-promptのmetricsと同じ）ため、配列で受ける。
      nextPolicies: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          required: ["business", "policy"],
          properties: { business: { type: "string", enum: keys }, policy: { type: "string" } },
        },
      },
      searchReport: {
        type: "object", additionalProperties: false,
        required: ["checkedRegions", "checkedSources", "checkedThemes"],
        properties: {
          checkedRegions: { type: "array", items: { type: "string" } },
          checkedSources: { type: "array", items: { type: "string" } },
          checkedThemes: { type: "array", items: { type: "string" } },
        },
      },
    },
  };
}

// --- 結果の検証 -----------------------------------------------------------------------

/** 検証を通した記事1件。`WeeklyReportArticle`（`src/lib/collection.ts`）にそのまま渡せる形。 */
export type CollectedArticle = {
  business: CollectedBusiness;
  informationType: CollectedInformationType;
  title: string;
  url: string;
  sourceName: string;
  publisher: string | null;
  isPrimarySource: boolean;
  publishedAt: string | null;
  occurredAt: string | null;
  summary: string | null;
  implications: string | null;
  importance: CollectedImportance;
  targetCompany: string | null;
  targetProduct: string | null;
  region: string | null;
  keywords: string[];
  tags: string[];
  periodScope: CollectedPeriodScope;
  extractedMetrics: Record<string, string> | null;
};

export type CollectionSearchReport = { checkedRegions: string[]; checkedSources: string[]; checkedThemes: string[] };
export type CollectionSearchParseResult =
  | { ok: true; articles: CollectedArticle[]; found: number; dropped: number; nextPolicies: Record<string, string>; searchReport: CollectionSearchReport }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, limit = TEXT_LIMIT): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, limit) : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .map((item) => item.trim().slice(0, LIST_ITEM_LIMIT))
    .slice(0, LIST_LIMIT);
}

/** ISO 8601として読める日時だけを通す。読めない値は捨てて記事は残す（日付の欠けで記事ごと落とさない）。 */
function optionalIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** `http:`・`https:`のURLだけを通す。DBの`normalizedUrl`（512文字）に収まらないものは登録で例外になるため落とす。 */
function articleUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0 || text.length > URL_LIMIT) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? text : null;
  } catch {
    return null;
  }
}

/**
 * `{ name, value }`の配列を項目名→値のオブジェクトへ畳む（#90）。スキーマを渡していてもモデルが
 * 旧来のオブジェクトで返すことはあるため、その1件を捨てる理由が無く、両方の形を受ける。
 * 項目数・JSONの長さは週報登録API（`extractedMetrics`）の上限に揃える。上限を超えたら数値は捨てる。
 */
function metricsRecord(value: unknown): Record<string, string> | null {
  const entries = Array.isArray(value)
    ? value.filter(isRecord).map((item) => [item.name, item.value] as const).filter(([name]) => typeof name === "string" && name.trim() !== "")
    : isRecord(value)
      ? Object.entries(value)
      : [];
  const record = Object.fromEntries(
    entries.filter(([, item]) => item !== null && item !== undefined && typeof item !== "object").map(([name, item]) => [String(name), String(item)] as const),
  );
  const keys = Object.keys(record);
  if (keys.length === 0 || keys.length > METRICS_MAX_KEYS || JSON.stringify(record).length > METRICS_MAX_JSON_LENGTH) return null;
  return record;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function toArticle(raw: unknown, keys: readonly string[]): CollectedArticle | null {
  if (!isRecord(raw)) return null;
  const business = oneOf(raw.business, keys);
  const title = optionalString(raw.title, TITLE_LIMIT);
  const url = articleUrl(raw.url);
  const sourceName = optionalString(raw.sourceName, SOURCE_NAME_LIMIT);
  // 事業・題名・URL・媒体名のどれかが欠けた記事は、取り込んでも使えない（登録APIも必須にしている）。
  if (!business || !title || !url || !sourceName) return null;
  return {
    business,
    informationType: oneOf(raw.informationType, COLLECTED_INFORMATION_TYPES) ?? "OTHER",
    title,
    url,
    sourceName,
    publisher: optionalString(raw.publisher, SOURCE_NAME_LIMIT),
    isPrimarySource: raw.isPrimarySource === true,
    publishedAt: optionalIsoDate(raw.publishedAt),
    occurredAt: optionalIsoDate(raw.occurredAt),
    summary: optionalString(raw.summary),
    implications: optionalString(raw.implications),
    importance: oneOf(raw.importance, ["HIGH", "MEDIUM", "REFERENCE"] as const) ?? "REFERENCE",
    targetCompany: optionalString(raw.targetCompany, SOURCE_NAME_LIMIT),
    targetProduct: optionalString(raw.targetProduct, SOURCE_NAME_LIMIT),
    region: optionalString(raw.region, 200),
    keywords: stringList(raw.keywords),
    tags: stringList(raw.tags),
    periodScope: oneOf(raw.periodScope, ["IN_SCOPE", "PAST_30_DAYS_SUPPLEMENT"] as const) ?? "IN_SCOPE",
    extractedMetrics: metricsRecord(raw.extractedMetrics),
  };
}

/**
 * Codexが返したJSONを検証する。
 *
 * - `articles`が配列でなければ失敗。**空の配列は成功**とする（その日に該当する記事が無いことは
 *   ありうる。取り込み件数0の実行として記録される）
 * - 読めない要素（必須項目の欠け・URLの不正）は落として続ける。**返ってきた記事が1件以上あるのに
 *   1件も読めなかった**ときだけ失敗にする（出力の形が壊れている可能性が高く、0件の成功と
 *   区別が付かなくなるため）
 * - 事業ごと・全体の上限を超えた分は、返ってきた順に落とす（上限は週報登録APIと同じ）
 */
export function parseCollectionSearchPayload(raw: unknown, businesses: BusinessDef[] = DEFAULT_BUSINESSES): CollectionSearchParseResult {
  const keys = businessKeys(businesses);
  if (!isRecord(raw)) return { ok: false, error: "収集の結果がオブジェクトではありません" };
  if (!Array.isArray(raw.articles)) return { ok: false, error: "articlesが配列ではありません" };

  const found = raw.articles.length;
  const perBusiness: Record<string, number> = Object.fromEntries(keys.map((key) => [key, 0]));
  const articles: CollectedArticle[] = [];
  for (const item of raw.articles) {
    const article = toArticle(item, keys);
    if (!article) continue;
    if (articles.length >= COLLECTION_SEARCH_ARTICLE_LIMIT || perBusiness[article.business] >= articleLimitFor(article.business)) continue;
    perBusiness[article.business]++;
    articles.push(article);
  }
  const nextPolicies: Record<string, string> = {};
  if (Array.isArray(raw.nextPolicies)) {
    for (const item of raw.nextPolicies) {
      if (!isRecord(item)) continue;
      const business = oneOf(item.business, keys);
      const policy = optionalString(item.policy, 4000);
      if (business && policy) nextPolicies[business] = policy;
    }
  }
  if (found > 0 && articles.length === 0) return { ok: false, error: "返ってきた記事がどれも読み取れませんでした" };
  return {
    ok: true,
    articles,
    found,
    dropped: found - articles.length,
    nextPolicies,
    searchReport: isRecord(raw.searchReport) ? { checkedRegions: stringList(raw.searchReport.checkedRegions), checkedSources: stringList(raw.searchReport.checkedSources), checkedThemes: stringList(raw.searchReport.checkedThemes) } : { checkedRegions: [], checkedSources: [], checkedThemes: [] },
  };
}
