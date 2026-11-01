import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAnalysisPrompt, buildOutputSchema, CONTENT_PROMPT_LIMIT, parseAnalysisPayload, parseAnnouncedOn } from "./analysis-prompt.ts";

const article = {
  id: "article-1",
  title: "パナソニック、宅配ボックスに顔認証の解錠を追加",
  originalUrl: "https://example.com/news/1",
  sourceName: "日経クロステック",
  publisher: null,
  business: "EXTERIOR" as const,
  publishedAt: new Date("2026-08-28T00:00:00Z"),
  collectedAt: new Date("2026-08-30T00:00:00Z"),
  content: "本文",
  summary: null,
};

const valid = {
  relevance: "EXTERIOR",
  confidence: 0.91,
  reason: "宅配ボックスの解錠方式に関する新製品発表のため",
  noiseReason: null,
  summary: "顔認証ユニットを10月に発売する。",
  fullSummary: null,
  announcedOn: "2026-08-28",
  regions: ["日本"],
  metrics: [{ name: "発売時期", value: "2026年10月" }, { name: "対応機種", value: 12 }],
  implications: "後付けで既設ストックを取りに行ける",
  importance: "HIGH",
  duplicates: [{ title: "同じ発表の転載記事", url: "https://example.com/news/2", reason: "発表主体と製品名が一致" }],
  relatedFindings: [{ title: "ニュースリリース", url: "https://example.com/pr", publishedOn: "2026-08-28", summary: "仕様一覧", reason: "数値の裏取り", isPrimarySource: true }],
};

describe("buildAnalysisPrompt", () => {
  it("原典URL・取得日・既存記事をプロンプトへ含める", () => {
    const prompt = buildAnalysisPrompt(article, [{ title: "既存の記事", originalUrl: "https://example.com/news/9", business: "LOCKER", publishedAt: null, summary: null }]);
    assert.match(prompt, /https:\/\/example\.com\/news\/1/);
    assert.match(prompt, /2026-08-30/);
    assert.match(prompt, /既存の記事/);
  });

  it("本文が無い記事でも、本文が無い旨を伝えて解析を続けさせる", () => {
    const prompt = buildAnalysisPrompt({ ...article, content: null }, []);
    assert.match(prompt, /本文は保存されていません/);
    assert.match(prompt, /同じ週に登録済みの記事はありません/);
  });

  it("長い本文は上限まで切り詰める（1回の実行で利用枠を使い切らないため）", () => {
    const prompt = buildAnalysisPrompt({ ...article, content: "あ".repeat(CONTENT_PROMPT_LIMIT + 500) }, []);
    assert.ok(!prompt.includes("あ".repeat(CONTENT_PROMPT_LIMIT + 1)));
  });
});

describe("buildOutputSchema", () => {
  it("すべての項目をrequiredにし、余計なキーを許さない（構造化出力の制約）", () => {
    const schema = buildOutputSchema() as { required: string[]; additionalProperties: boolean };
    assert.equal(schema.additionalProperties, false);
    for (const key of ["relevance", "confidence", "reason", "summary", "importance", "duplicates", "relatedFindings"]) {
      assert.ok(schema.required.includes(key), key);
    }
  });

  // キー名を決めないオブジェクトを1つでも置くと、OpenAIの構造化出力がモデルを呼ぶ前に
  // 400（invalid_json_schema）で弾く（#90）。オブジェクトは必ずpropertiesを持たせる。
  it("キー名を決めないオブジェクトを含めない（構造化出力が受け付けないため）", () => {
    const openObjects: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) return node.forEach((item, index) => walk(item, `${path}[${index}]`));
      if (typeof node !== "object" || node === null) return;
      const schema = node as Record<string, unknown>;
      const isObjectType = schema.type === "object" || (Array.isArray(schema.type) && schema.type.includes("object"));
      if (isObjectType && (schema.properties === undefined || schema.additionalProperties !== false)) openObjects.push(path);
      for (const [key, child] of Object.entries(schema)) walk(child, `${path}.${key}`);
    };
    walk(buildOutputSchema(), "$");
    assert.deepEqual(openObjects, []);
  });
});

describe("parseAnalysisPayload", () => {
  it("正しい応答を受け入れる", () => {
    const result = parseAnalysisPayload(valid);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.relevance, "EXTERIOR");
    assert.equal(result.value.duplicates.length, 1);
    assert.equal(result.value.relatedFindings[0].isPrimarySource, true);
    // name/valueの配列を項目名→値のオブジェクトへ畳み、数値で返ってきた値も文字列へ寄せる。
    assert.equal(result.value.metrics.発売時期, "2026年10月");
    assert.equal(result.value.metrics.対応機種, "12");
  });

  it("metricsがオブジェクトで返ってきても読む（旧形式の応答で解析を捨てないため）", () => {
    const result = parseAnalysisPayload({ ...valid, metrics: { 発売時期: "2026年10月", 対応機種: 12 } });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.metrics.対応機種, "12");
  });

  it("metricsが壊れていても、記事1件ぶんの解析ごと捨てない", () => {
    const result = parseAnalysisPayload({ ...valid, metrics: [{ value: "名前がない" }, "配列の要素が文字列"] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.value.metrics, {});
  });

  it("判定・信頼度・要約が欠けた応答は保存しない", () => {
    assert.equal(parseAnalysisPayload({ ...valid, relevance: "UNKNOWN" }).ok, false);
    assert.equal(parseAnalysisPayload({ ...valid, confidence: "高" }).ok, false);
    assert.equal(parseAnalysisPayload({ ...valid, summary: "" }).ok, false);
    assert.equal(parseAnalysisPayload({ ...valid, importance: "とても高い" }).ok, false);
    assert.equal(parseAnalysisPayload("JSONではない文字列").ok, false);
  });

  it("信頼度は0〜1へ丸める", () => {
    const result = parseAnalysisPayload({ ...valid, confidence: 4 });
    assert.equal(result.ok && result.value.confidence, 1);
  });

  it("URLの無い関連情報は落とす（裏取りに使えないため）", () => {
    const result = parseAnalysisPayload({ ...valid, relatedFindings: [{ title: "出典不明の情報", url: null, publishedOn: null, summary: "", reason: "", isPrimarySource: false }] });
    assert.equal(result.ok && result.value.relatedFindings.length, 0);
  });

  it("重複候補・関連情報が壊れていても、記事1件ぶんの解析ごと捨てない", () => {
    const result = parseAnalysisPayload({ ...valid, duplicates: "配列ではない", relatedFindings: null });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.duplicates.length, 0);
  });
});

describe("parseAnnouncedOn", () => {
  it("YYYY-MM-DDをUTCの日付として読む", () => {
    assert.equal(parseAnnouncedOn("2026-08-28")?.toISOString(), "2026-08-28T00:00:00.000Z");
  });

  it("読めない値はnullにして保存を続ける", () => {
    assert.equal(parseAnnouncedOn("2026年8月28日"), null);
    assert.equal(parseAnnouncedOn(null), null);
  });
});
