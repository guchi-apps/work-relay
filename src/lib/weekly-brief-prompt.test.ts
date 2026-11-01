import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getWeekRange } from "./jst-week.ts";
import { buildWeeklyBriefPrompt, buildWeeklyBriefSchema, MAX_BRIEF_TOPICS, parseWeeklyBriefPayload, toWeeklyBriefTopics, type WeeklyBriefArticle } from "./weekly-brief-prompt.ts";

const NOW = new Date("2026-09-08T03:00:00Z");
const LAST_WEEK = getWeekRange(-1, NOW);

const articles: WeeklyBriefArticle[] = [
  {
    title: "国土交通省、置き配推進事業の補助枠を拡大",
    business: "EXTERIOR",
    sourceName: "国土交通省 報道発表",
    isPrimarySource: true,
    importance: "HIGH",
    publishedAt: new Date("2026-09-01T00:00:00Z"),
    collectedAt: new Date("2026-09-01T11:00:00Z"),
    summary: "戸建て向け宅配ボックス設置への補助を1戸あたり上限2万円へ引き上げる。",
    implications: "10月の受付開始に合わせた販促の準備が要る。",
  },
  {
    title: "日本郵便、PUDOステーションを1,000か所追加",
    business: "LOCKER",
    sourceName: "日本郵便 プレスリリース",
    isPrimarySource: true,
    importance: "MEDIUM",
    publishedAt: null,
    collectedAt: new Date("2026-09-02T11:00:00Z"),
    summary: null,
    implications: null,
  },
];

describe("buildWeeklyBriefPrompt", () => {
  it("週ラベル・事業ごとの件数・記事の見出しを含む", () => {
    const prompt = buildWeeklyBriefPrompt(LAST_WEEK, articles);
    assert.match(prompt, /2026年8月30日 — 9月5日/);
    assert.match(prompt, /エクステリア 1件 ／ ロッカー 1件 ／ AI 0件/);
    assert.match(prompt, /置き配推進事業の補助枠を拡大/);
    assert.match(prompt, /PUDOステーション/);
  });

  it("公開日が無い記事は「公開日不明」と書き、取得日は必ず載せる", () => {
    const prompt = buildWeeklyBriefPrompt(LAST_WEEK, articles);
    assert.match(prompt, /公開日不明（取得 2026-09-02）/);
  });

  it("要約・示唆が無い記事でも行が壊れない", () => {
    const prompt = buildWeeklyBriefPrompt(LAST_WEEK, [articles[1]]);
    assert.ok(!prompt.includes("要約: null"));
    assert.ok(!prompt.includes("示唆: null"));
  });

  it("記事が0件でも組み立てられる", () => {
    assert.match(buildWeeklyBriefPrompt(LAST_WEEK, []), /対象の記事がありません/);
  });
});

describe("buildWeeklyBriefSchema", () => {
  const schema = buildWeeklyBriefSchema();

  it("全プロパティがrequiredで、additionalPropertiesを閉じている", () => {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ["headline", "overview", "topics"]);
    const properties = schema.properties as Record<string, unknown>;
    assert.deepEqual(Object.keys(properties).sort(), ["headline", "overview", "topics"]);
  });

  // #90。キー名を決めないオブジェクトを置くと、モデルを呼ぶ前に400（invalid_json_schema）で
  // 落ちる。`src/lib/analysis-prompt.test.ts`と同じ観点をこちらでも機械的に確かめる。
  it("キー名を決めないオブジェクトを含まない", () => {
    function walk(node: unknown, path: string): void {
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${path}[${index}]`));
        return;
      }
      if (typeof node !== "object" || node === null) return;
      const record = node as Record<string, unknown>;
      if (record.type === "object") {
        assert.equal(record.additionalProperties, false, `${path}: additionalPropertiesがfalseではありません`);
        assert.ok(record.properties, `${path}: propertiesがありません`);
      }
      for (const [key, value] of Object.entries(record)) walk(value, `${path}.${key}`);
    }
    walk(schema, "$");
  });
});

describe("parseWeeklyBriefPayload", () => {
  it("見出し・全体像・トピックを読み取る", () => {
    const parsed = parseWeeklyBriefPayload({ headline: " 制度が動いた週 ", overview: "補助の拡大が中心。", topics: [{ label: "制度", text: "補助が1戸2万円へ" }] });
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok && parsed.value, { headline: "制度が動いた週", overview: "補助の拡大が中心。", topics: [{ label: "制度", text: "補助が1戸2万円へ" }] });
  });

  it("見出し・全体像が欠けていたら受け付けない", () => {
    assert.equal(parseWeeklyBriefPayload({ overview: "x", topics: [] }).ok, false);
    assert.equal(parseWeeklyBriefPayload({ headline: "x", topics: [] }).ok, false);
    assert.equal(parseWeeklyBriefPayload("なにか").ok, false);
  });

  it("トピックはtextがある要素だけを残し、上限で切る", () => {
    const parsed = parseWeeklyBriefPayload({
      headline: "h",
      overview: "o",
      topics: [{ label: "制度" }, { text: "ラベル無しでも残す" }, ...Array.from({ length: MAX_BRIEF_TOPICS + 2 }, (_, index) => ({ label: "他", text: `t${index}` }))],
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.topics.length, MAX_BRIEF_TOPICS);
    assert.equal(parsed.value.topics[0].label, "");
  });
});

describe("toWeeklyBriefTopics", () => {
  it("壊れたJSON列は空配列にする", () => {
    assert.deepEqual(toWeeklyBriefTopics(null), []);
    assert.deepEqual(toWeeklyBriefTopics("文字列"), []);
    assert.deepEqual(toWeeklyBriefTopics([{ text: "残る" }, "捨てる"]), [{ label: "", text: "残る" }]);
  });
});
