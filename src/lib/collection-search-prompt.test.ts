import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LEASE_SECONDS } from "./analysis-job-rules.ts";
import {
  buildCollectionSearchPrompt,
  buildCollectionSearchSchema,
  COLLECTION_SEARCH_ARTICLE_LIMIT,
  COLLECTION_SEARCH_ARTICLE_LIMIT_PER_BUSINESS,
  COLLECTION_SEARCH_TIMEOUT_SECONDS,
  COLLECTED_INFORMATION_TYPES,
  parseCollectionSearchPayload,
} from "./collection-search-prompt.ts";

// JSTで2026-09-21 12:00
const NOW = new Date("2026-09-21T03:00:00Z");

function article(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    business: "EXTERIOR",
    informationType: "NEW_PRODUCT",
    title: "宅配ボックスの新商品を発表",
    url: "https://example.com/news/1",
    sourceName: "サンプル通信",
    publisher: "サンプル社",
    isPrimarySource: true,
    publishedAt: "2026-09-19T00:00:00+09:00",
    occurredAt: null,
    summary: "戸建て向けの宅配ボックスを発売する。",
    implications: "自社の競合製品として比較する。",
    importance: "HIGH",
    targetCompany: "サンプル社",
    targetProduct: "新型ボックス",
    keywords: ["宅配ボックス"],
    tags: ["新商品"],
    periodScope: "IN_SCOPE",
    extractedMetrics: [{ name: "想定価格", value: "48,000円" }],
    ...overrides,
  };
}

describe("buildCollectionSearchPrompt", () => {
  it("今日の日付・対象期間・件数の上限・事業の観点を含める", () => {
    const prompt = buildCollectionSearchPrompt(NOW);
    assert.ok(prompt.includes("2026-09-21"), "今日");
    assert.ok(prompt.includes("2026-09-14"), "7日前");
    assert.ok(prompt.includes(`事業ごとに${COLLECTION_SEARCH_ARTICLE_LIMIT_PER_BUSINESS}件まで`));
    assert.ok(prompt.includes(`合計${COLLECTION_SEARCH_ARTICLE_LIMIT}件まで`));
    assert.ok(prompt.includes("宅配ボックス"));
    assert.ok(prompt.includes("マルチロッカー"));
    assert.ok(prompt.includes("古い記事で件数を埋めない"));
    assert.ok(prompt.includes("査読論文・行政調査"));
    assert.ok(prompt.includes("公開SNS"));
  });

  it("URLを推測で作らせない", () => {
    assert.ok(buildCollectionSearchPrompt(NOW).includes("URLを推測で作らない"));
  });

  it("不採用記事と調整指示を事業ごとの基準として渡す", () => {
    const prompt = buildCollectionSearchPrompt(NOW, {
      EXTERIOR: { policy: "宅配は人事記事を採用しない", instruction: "ポスト社長を避ける", rejectedArticles: [{ title: "ポスト社長に就任", reason: null }], existingArticles: [{ title: "既存の宅配記事", summary: "既存要約", url: "https://example.com/delivery" }] },
      LOCKER: { policy: "ロッカーは芸能記事を採用しない", instruction: "俳優の話題を避ける", rejectedArticles: [{ title: "俳優がロッカーを利用", reason: null }], existingArticles: [] },
    });
    assert.ok(prompt.includes("宅配は人事記事を採用しない"));
    assert.ok(prompt.includes("ポスト社長を避ける"));
    assert.ok(prompt.includes("ポスト社長に就任"));
    assert.ok(prompt.includes("ロッカーは芸能記事を採用しない"));
    assert.ok(prompt.includes("俳優の話題を避ける"));
    assert.ok(prompt.includes("俳優がロッカーを利用"));
    assert.ok(prompt.includes("既存の宅配記事"));
  });

  it("不採用記事に理由が添えられていれば、その理由も渡す（#194）", () => {
    const prompt = buildCollectionSearchPrompt(NOW, {
      EXTERIOR: { policy: "宅配の基準", instruction: null, rejectedArticles: [{ title: "ポスト社長に就任", reason: "宅配と無関係な人事記事のため" }], existingArticles: [] },
      LOCKER: { policy: "ロッカーの基準", instruction: null, rejectedArticles: [{ title: "俳優がロッカーを利用", reason: null }], existingArticles: [] },
    });
    assert.ok(prompt.includes("ポスト社長に就任（理由: 宅配と無関係な人事記事のため）"));
    assert.ok(prompt.includes("俳優がロッカーを利用"));
    assert.ok(!prompt.includes("俳優がロッカーを利用（理由:"));
  });
});

describe("buildCollectionSearchSchema", () => {
  it("記事の全項目をrequiredにし、余計なキーを許さない（構造化出力の制約）", () => {
    const schema = buildCollectionSearchSchema() as { required: string[]; additionalProperties: boolean; properties: { articles: { maxItems: number; items: { required: string[]; properties: Record<string, unknown> } } } };
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ["articles", "nextPolicies", "searchReport"]);
    const items = schema.properties.articles.items;
    assert.equal(schema.properties.articles.maxItems, COLLECTION_SEARCH_ARTICLE_LIMIT);
    assert.deepEqual([...items.required].sort(), Object.keys(items.properties).sort());
  });

  it("区分のenumはマスタの区分（AI関連を含む）と一致し、nextPoliciesも区分で縛る", () => {
    const schema = buildCollectionSearchSchema() as { properties: { articles: { items: { properties: { business: { enum: string[] } } } }; nextPolicies: { items: { properties: { business: { enum: string[] } } } } } };
    assert.deepEqual(schema.properties.articles.items.properties.business.enum, ["EXTERIOR", "LOCKER", "AI"]);
    assert.deepEqual(schema.properties.nextPolicies.items.properties.business.enum, ["EXTERIOR", "LOCKER", "AI"]);
  });

  it("情報種別は週報登録APIと同じ12種類", () => {
    assert.equal(COLLECTED_INFORMATION_TYPES.length, 15);
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
    walk(buildCollectionSearchSchema(), "$");
    assert.deepEqual(openObjects, []);
  });
});

describe("実行上限", () => {
  it("ポーラーの保持期限（リース）より短い", () => {
    assert.ok(COLLECTION_SEARCH_TIMEOUT_SECONDS < LEASE_SECONDS);
  });
});

describe("parseCollectionSearchPayload", () => {
  it("正しい応答を受け入れ、数値の配列を項目名→値へ畳む", () => {
    const result = parseCollectionSearchPayload({ articles: [article()] });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.found, 1);
    assert.equal(result.dropped, 0);
    assert.deepEqual(result.articles[0].extractedMetrics, { 想定価格: "48,000円" });
    assert.equal(result.articles[0].publishedAt, "2026-09-18T15:00:00.000Z");
  });

  it("記事が0件でも成功にする（該当が無い日がありうる）", () => {
    const result = parseCollectionSearchPayload({ articles: [] });
    assert.deepEqual(result, { ok: true, articles: [], found: 0, dropped: 0, nextPolicies: {}, searchReport: { checkedRegions: [], checkedSources: [], checkedThemes: [] } });
  });

  it("オブジェクトでない・articlesが配列でない応答は失敗", () => {
    assert.equal(parseCollectionSearchPayload(null).ok, false);
    assert.equal(parseCollectionSearchPayload([]).ok, false);
    assert.equal(parseCollectionSearchPayload({ articles: "x" }).ok, false);
  });

  it("必須項目の欠け・http(s)以外・長すぎるURLの記事だけを落とし、残りは取り込む", () => {
    const result = parseCollectionSearchPayload({
      articles: [
        article(),
        article({ title: "" }),
        article({ url: "javascript:alert(1)" }),
        article({ url: `https://example.com/${"a".repeat(600)}` }),
        article({ sourceName: null }),
        article({ business: "OTHER" }),
        "文字列",
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.articles.length, 1);
    assert.equal(result.found, 7);
    assert.equal(result.dropped, 6);
  });

  it("返ってきた記事がすべて読めないときは失敗にする（0件の成功と区別するため）", () => {
    const result = parseCollectionSearchPayload({ articles: [article({ url: "not a url" }), article({ title: null })] });
    assert.equal(result.ok, false);
  });

  it("事業ごと・全体の上限を超えた分を、返ってきた順に落とす", () => {
    const delivery = Array.from({ length: 7 }, (_, index) => article({ url: `https://example.com/d${index}` }));
    const locker = Array.from({ length: 7 }, (_, index) => article({ business: "LOCKER", url: `https://example.com/l${index}` }));
    const result = parseCollectionSearchPayload({ articles: [...delivery, ...locker] });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.articles.filter((item) => item.business === "EXTERIOR").length, COLLECTION_SEARCH_ARTICLE_LIMIT_PER_BUSINESS);
    assert.equal(result.articles.filter((item) => item.business === "LOCKER").length, COLLECTION_SEARCH_ARTICLE_LIMIT_PER_BUSINESS);
    assert.equal(result.articles.length, COLLECTION_SEARCH_ARTICLE_LIMIT_PER_BUSINESS * 2);
    assert.equal(result.articles[0].url, "https://example.com/d0");
    assert.equal(result.dropped, 4);
  });

  it("不正な日付はnullにして記事は残し、列挙外の値は既定値へ倒す", () => {
    const result = parseCollectionSearchPayload({ articles: [article({ publishedAt: "昨日", occurredAt: "2026-13-45", informationType: "???", importance: "URGENT", periodScope: "?" })] });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const [item] = result.articles;
    assert.equal(item.publishedAt, null);
    assert.equal(item.occurredAt, null);
    assert.equal(item.informationType, "OTHER");
    assert.equal(item.importance, "REFERENCE");
    assert.equal(item.periodScope, "IN_SCOPE");
  });

  it("数値は旧来のオブジェクトの形でも受け、上限を超えたら捨てる", () => {
    const legacy = parseCollectionSearchPayload({ articles: [article({ extractedMetrics: { 台数: 120, 入れ子: { a: 1 } } })] });
    assert.ok(legacy.ok);
    if (legacy.ok) assert.deepEqual(legacy.articles[0].extractedMetrics, { 台数: "120" });

    const tooMany = Array.from({ length: 31 }, (_, index) => ({ name: `項目${index}`, value: "1" }));
    const capped = parseCollectionSearchPayload({ articles: [article({ extractedMetrics: tooMany })] });
    assert.ok(capped.ok);
    if (capped.ok) assert.equal(capped.articles[0].extractedMetrics, null);

    const empty = parseCollectionSearchPayload({ articles: [article({ extractedMetrics: [] })] });
    assert.ok(empty.ok);
    if (empty.ok) assert.equal(empty.articles[0].extractedMetrics, null);
  });

  it("キーワード・タグは文字列だけを、件数と長さを切って残す", () => {
    const result = parseCollectionSearchPayload({ articles: [article({ keywords: ["宅配", 1, "", "x".repeat(300)], tags: "文字列" })] });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.articles[0].keywords, ["宅配", "x".repeat(100)]);
    assert.deepEqual(result.articles[0].tags, []);
  });

  it("nextPoliciesは区分ごとに読み、未知の区分・空の基準は捨てる", () => {
    const result = parseCollectionSearchPayload({
      articles: [],
      nextPolicies: [
        { business: "AI", policy: "AIの基準" },
        { business: "EXTERIOR", policy: "  " },
        { business: "UNKNOWN", policy: "x" },
        "壊れた要素",
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.nextPolicies, { AI: "AIの基準" });
  });

  it("AI関連の記事も区分ごとの上限つきで受ける", () => {
    const ai = Array.from({ length: 7 }, (_, index) => article({ business: "AI", url: `https://example.com/a${index}` }));
    const result = parseCollectionSearchPayload({ articles: ai });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.articles.length, COLLECTION_SEARCH_ARTICLE_LIMIT_PER_BUSINESS);
  });
});
