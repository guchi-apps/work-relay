/**
 * 事業区分（エクステリア／ロッカー／AI関連）の定義。
 *
 * 区分の定義は`industry_business`テーブルが正で、ここには**DBに依存しない型・純粋な関数**と、
 * マイグレーションが投入する初期値（`DEFAULT_BUSINESSES`）だけを置く。`node --test`はPrismaを
 * importするモジュールを読めないため、プロンプト組み立てやテストはこのファイルだけに依存させ、
 * DBからの読み出しは`businesses.ts`に分ける。
 */

export type BusinessKey = string;
export type BusinessColor = "teal" | "orange" | "violet";
export type BusinessFeed = { name: string; query: string; lang: "ja" | "en" };

export type BusinessDef = {
  key: BusinessKey;
  /** 画面に出す名前（例: エクステリア事業）。 */
  label: string;
  /** 「宅配 3件」のような短い表記に使う名前。 */
  shortLabel: string;
  /** 区分の下に出す補足（キーワードの並び）。 */
  hint: string;
  /** AIに渡す「この区分で何を見るか」。 */
  scope: string;
  /** 検索・判定基準の初期値。 */
  defaultPolicy: string;
  color: BusinessColor;
  sortOrder: number;
  feeds: BusinessFeed[];
};

const POLICY_TAIL = "について、商品企画、市場、導入、制度、安全性に役立つ一次情報を優先する。話題の背景に出るだけの記事、人事・芸能・スポーツなど事業と直接関係しない記事は採用しない。";

/** マイグレーション`industry_business`の初期値と同じ内容。変えるときは両方を揃える。 */
export const DEFAULT_BUSINESSES: BusinessDef[] = [
  {
    key: "EXTERIOR",
    label: "エクステリア事業",
    shortLabel: "エクステリア",
    hint: "戸建て · 宅配ボックス · ポスト · 機能門柱 · 外構",
    scope: "宅配ボックス、郵便ポスト、機能門柱、置き配、防犯（なりすまし受け取り・盗難）、施工性、配送ロボット／ドローン配送",
    defaultPolicy: `宅配ボックス・ポスト・機能門柱${POLICY_TAIL}`,
    color: "teal",
    sortOrder: 1,
    feeds: [{ name: "宅配・住宅設備の公開情報", query: "(宅配ボックス OR ポスト OR 機能門柱 OR 置き配) (新商品 OR 発表 OR 導入 OR 補助金)", lang: "ja" }],
  },
  {
    key: "LOCKER",
    label: "ロッカー事業",
    shortLabel: "ロッカー",
    hint: "マルチロッカー · セルフ発送 · 競合・類似サービス",
    scope: "マルチロッカー、セルフ発送機、PUDO・SMARI・Amazon Hub等の受取／発送／返品、ロッカーの運用・設置・事業性",
    defaultPolicy: `マルチロッカー${POLICY_TAIL}`,
    color: "orange",
    sortOrder: 2,
    feeds: [
      { name: "ロッカー・発送サービスの公開情報", query: "(PUDO OR SMARI OR Amazon Hub OR マルチエキューブ OR SPACER OR セルフ発送) (導入 OR 発表 OR 物流 OR 返品)", lang: "ja" },
      { name: "海外ロッカー事例", query: "(parcel locker OR locker drop-off OR self-service shipping kiosk)", lang: "en" },
    ],
  },
  {
    key: "AI",
    label: "AI関連",
    shortLabel: "AI",
    hint: "Gemini · Copilot · 生成AI · 業務活用",
    scope: "Gemini、Microsoft Copilot（Microsoft 365 Copilot・GitHub Copilot等）の新機能、料金・プラン、法人向けの導入・活用事例、安全性・ガバナンス",
    defaultPolicy: "Gemini・Copilotについて、新機能、料金・プラン、導入・活用事例、セキュリティやガバナンスに役立つ一次情報を優先する。話題の背景に出るだけの記事、人事・芸能・スポーツなどAIの利用と直接関係しない記事は採用しない。",
    color: "violet",
    sortOrder: 3,
    feeds: [
      { name: "Gemini・Copilotの公開情報", query: "(Gemini OR Copilot OR \"Microsoft 365 Copilot\" OR \"GitHub Copilot\") (新機能 OR 発表 OR 料金 OR 導入)", lang: "ja" },
      { name: "Gemini・Copilotの海外情報", query: "(Gemini OR \"Microsoft Copilot\" OR \"GitHub Copilot\") (announces OR launches OR pricing OR enterprise)", lang: "en" },
    ],
  },
];

/** 旧区分値。外部（AIDE・iOS共有）が送ってくる値を当面は受け付けるための読み替え。 */
const LEGACY_KEYS: Record<string, BusinessKey> = { DELIVERY: "EXTERIOR" };

export function businessKeys(defs: readonly BusinessDef[]): BusinessKey[] {
  return [...defs].sort((a, b) => a.sortOrder - b.sortOrder).map((def) => def.key);
}

export function sortBusinesses(defs: readonly BusinessDef[]): BusinessDef[] {
  return [...defs].sort((a, b) => a.sortOrder - b.sortOrder);
}

export function findBusiness(defs: readonly BusinessDef[], key: string): BusinessDef | undefined {
  return defs.find((def) => def.key === key);
}

/** 区分値を検証する。旧`DELIVERY`は`EXTERIOR`に読み替える。未知の値は`null`。 */
export function normalizeBusinessKey(defs: readonly BusinessDef[], value: unknown): BusinessKey | null {
  if (typeof value !== "string") return null;
  const key = LEGACY_KEYS[value] ?? value;
  return defs.some((def) => def.key === key) ? key : null;
}

export function businessLabel(defs: readonly BusinessDef[], key: string): string {
  return findBusiness(defs, key)?.label ?? key;
}

export function businessShortLabel(defs: readonly BusinessDef[], key: string): string {
  return findBusiness(defs, key)?.shortLabel ?? key;
}

/** URLクエリ`?business=exterior`用の小文字キー。 */
export function businessParam(key: string): string {
  return key.toLowerCase();
}

/** 区分ごとに0で初期化した集計用のオブジェクト。 */
export function zeroCounts(defs: readonly BusinessDef[]): Record<BusinessKey, number> {
  return Object.fromEntries(defs.map((def) => [def.key, 0]));
}

/** `?business=`の値を検証する。`all`か区分の小文字キー（旧`delivery`は`exterior`）。それ以外は`all`。 */
export function parseBusinessParam(defs: readonly BusinessDef[], value: string | string[] | undefined): string {
  if (typeof value !== "string") return "all";
  const key = normalizeBusinessKey(defs, value.toUpperCase());
  return key ? businessParam(key) : "all";
}

/** 小文字のクエリ値を区分キーに戻す（キーは大文字で持つ規約）。 */
export function businessFromParam(param: string): BusinessKey {
  return param.toUpperCase();
}
