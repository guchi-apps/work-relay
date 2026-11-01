import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getWeekRange } from "./jst-week.ts";
import {
  buildNewsMail,
  buildNewsMailHtml,
  buildNewsMailSubject,
  buildNewsMailText,
  countNewsMailArticles,
  defaultSubjectBody,
  escapeHtml,
  isCollectedOnly,
  MAX_MAIL_ARTICLES,
  parseNewsMailRequest,
  sanitizeSubjectBody,
  SUBJECT_PREFIX,
  type NewsMailArticle,
} from "./news-mail.ts";

// 2026-09-07（月）を「今週」とする。先週はJSTの8/31(月)0時〜9/7(月)0時。
const NOW = new Date("2026-09-08T03:00:00Z");
const LAST_WEEK = getWeekRange(-1, NOW);

function article(overrides: Partial<NewsMailArticle> = {}): NewsMailArticle {
  return {
    id: "article-1",
    title: "パナソニック、宅配ボックスに後付けの通知ユニット",
    originalUrl: "https://example.com/news/1",
    sourceName: "パナソニック ニュースリリース",
    business: "EXTERIOR",
    isPrimarySource: true,
    importance: "HIGH",
    publishedAt: new Date("2026-09-02T01:00:00Z"),
    occurredAt: null,
    collectedAt: new Date("2026-09-03T11:00:00Z"),
    summary: "既設のコンボへ工事なしで取り付けられる通知ユニット。",
    implications: "既設向けアクセサリを外構提案へ組み込む余地がある。",
    metrics: [{ name: "想定価格", value: "12,800円" }],
    analyzed: true,
    ...overrides,
  };
}

describe("isCollectedOnly", () => {
  it("公開日が週の外・収集日が週の中なら「取得のみ」", () => {
    const target = article({ publishedAt: new Date("2026-08-25T00:00:00Z"), collectedAt: new Date("2026-09-02T00:00:00Z") });
    assert.equal(isCollectedOnly(target, LAST_WEEK), true);
  });

  it("公開日が週の中なら「取得のみ」ではない", () => {
    assert.equal(isCollectedOnly(article(), LAST_WEEK), false);
  });

  it("公開日が無くても発生日が週の中なら「取得のみ」ではない", () => {
    const target = article({ publishedAt: null, occurredAt: new Date("2026-09-01T00:00:00Z") });
    assert.equal(isCollectedOnly(target, LAST_WEEK), false);
  });

  it("公開日・発生日がどちらも無い記事は「取得のみ」と呼ばない（元々収集日で週が決まるため）", () => {
    const target = article({ publishedAt: null, occurredAt: null });
    assert.equal(isCollectedOnly(target, LAST_WEEK), false);
  });
});

describe("countNewsMailArticles", () => {
  it("事業・重要度・一次情報・未解析・取得のみを数える", () => {
    const counts = countNewsMailArticles(
      [
        article(),
        article({ id: "a2", business: "LOCKER", importance: "MEDIUM", isPrimarySource: false, analyzed: false }),
        article({ id: "a3", business: "LOCKER", importance: "MEDIUM", publishedAt: new Date("2026-08-20T00:00:00Z"), collectedAt: new Date("2026-09-01T00:00:00Z") }),
      ],
      LAST_WEEK,
    );
    assert.equal(counts.total, 3);
    assert.deepEqual(counts.byBusiness, [
      { business: "EXTERIOR", count: 1 },
      { business: "LOCKER", count: 2 },
      { business: "AI", count: 0 },
    ]);
    assert.deepEqual(counts.byImportance, [
      { importance: "HIGH", count: 1 },
      { importance: "MEDIUM", count: 2 },
      { importance: "REFERENCE", count: 0 },
    ]);
    assert.equal(counts.primarySource, 2);
    assert.equal(counts.unanalyzed, 1);
    assert.equal(counts.collectedOnly, 1);
  });
});

describe("buildNewsMailSubject", () => {
  it("接頭辞は常に付く", () => {
    assert.equal(buildNewsMailSubject("先週の業界ニュース"), `${SUBJECT_PREFIX} 先週の業界ニュース`);
  });

  it("本文が空でも接頭辞だけは残る", () => {
    assert.equal(buildNewsMailSubject("   "), SUBJECT_PREFIX);
  });

  // 件名はAIDE側でメールヘッダーへ載る。改行が残ると任意のヘッダーを差し込める経路になり得る。
  it("改行・制御文字を落として1行にする", () => {
    assert.equal(buildNewsMailSubject("先週の\r\nBcc: evil@example.com"), `${SUBJECT_PREFIX} 先週の Bcc: evil@example.com`);
    assert.ok(!buildNewsMailSubject("a\nb").includes("\n"));
  });
});

describe("sanitizeSubjectBody", () => {
  it("制御文字を空白にし、連続する空白をまとめる", () => {
    assert.equal(sanitizeSubjectBody("  a\t\tb\u0000c  "), "a b c");
  });
});

describe("defaultSubjectBody", () => {
  it("週ラベルと件数を含む", () => {
    const subject = defaultSubjectBody(LAST_WEEK, 5);
    assert.match(subject, /2026年8月30日 — 9月5日/);
    assert.match(subject, /5件/);
  });
});

describe("escapeHtml", () => {
  it("記号をすべて実体参照にする", () => {
    assert.equal(escapeHtml(`<b>"A"&'B'</b>`), "&lt;b&gt;&quot;A&quot;&amp;&#39;B&#39;&lt;/b&gt;");
  });
});

describe("buildNewsMailHtml", () => {
  const input = { range: LAST_WEEK, subjectBody: "先週の業界ニュース", articles: [article()], brief: null };

  it("週ラベル・記事タイトル・元記事リンクを含む", () => {
    const html = buildNewsMailHtml(input);
    assert.match(html, /2026年8月30日 — 9月5日/);
    assert.match(html, /後付けの通知ユニット/);
    assert.match(html, /href="https:\/\/example\.com\/news\/1"/);
  });

  it("タイトルに混ざったHTMLはエスケープする", () => {
    const html = buildNewsMailHtml({ ...input, articles: [article({ title: "<script>alert(1)</script>" })] });
    assert.ok(!html.includes("<script>"));
    assert.match(html, /&lt;script&gt;/);
  });

  it("http以外のURLはリンクにしない", () => {
    const html = buildNewsMailHtml({ ...input, articles: [article({ originalUrl: "javascript:alert(1)" })] });
    assert.ok(!html.includes("javascript:"));
  });

  it("総括があれば見出し・全体像・注目トピックを載せる", () => {
    const html = buildNewsMailHtml({
      ...input,
      brief: { headline: "制度と拠点が同時に動いた週", overview: "補助の拡大と拠点の増設が重なった。", topics: [{ label: "制度", text: "補助が1戸2万円へ" }] },
    });
    assert.match(html, /制度と拠点が同時に動いた週/);
    assert.match(html, /補助の拡大と拠点の増設が重なった。/);
    assert.match(html, /補助が1戸2万円へ/);
  });

  it("総括が無いときはその旨を出し、AIの節は作らない", () => {
    const html = buildNewsMailHtml(input);
    assert.match(html, /総括はまだ作成していません/);
    assert.ok(!html.includes("注目トピック"));
  });

  it("未解析の記事があれば注記を添える", () => {
    const html = buildNewsMailHtml({ ...input, articles: [article({ analyzed: false })] });
    assert.match(html, /AI解析なし/);
    assert.match(html, /1件はAI解析が終わっていない/);
  });

  it("記事が0件でも壊れない", () => {
    const html = buildNewsMailHtml({ ...input, articles: [] });
    assert.match(html, /送る記事が選ばれていません/);
  });
});

describe("buildNewsMailText", () => {
  it("HTMLタグを含まず、記事のタイトルとURLを含む", () => {
    const text = buildNewsMailText({ range: LAST_WEEK, subjectBody: "x", articles: [article()], brief: null });
    assert.ok(!text.includes("<"));
    assert.match(text, /後付けの通知ユニット/);
    assert.match(text, /https:\/\/example\.com\/news\/1/);
    assert.match(text, /想定価格 12,800円/);
  });
});

describe("buildNewsMail", () => {
  it("件名・HTML・テキストをまとめて返す", () => {
    const mail = buildNewsMail({ range: LAST_WEEK, subjectBody: "先週の業界ニュース", articles: [article()], brief: null });
    assert.equal(mail.subject, `${SUBJECT_PREFIX} 先週の業界ニュース`);
    assert.ok(mail.html.length > 0);
    assert.ok(mail.text.length > 0);
  });
});

describe("parseNewsMailRequest", () => {
  const valid = { articleIds: ["a1", "a2"], subjectBody: "先週の業界ニュース", weekOffset: -1, basis: "either", idempotencyKey: "key-1" };

  it("正しい入力を受け付け、重複IDをまとめる", () => {
    const parsed = parseNewsMailRequest({ ...valid, articleIds: ["a1", "a1", "a2"] });
    assert.deepEqual(parsed?.articleIds, ["a1", "a2"]);
    assert.equal(parsed?.weekOffset, -1);
    assert.equal(parsed?.basis, "either");
  });

  it("記事が空・上限超過なら受け付けない", () => {
    assert.equal(parseNewsMailRequest({ ...valid, articleIds: [] }), null);
    assert.equal(parseNewsMailRequest({ ...valid, articleIds: Array.from({ length: MAX_MAIL_ARTICLES + 1 }, (_, index) => `a${index}`) }), null);
  });

  it("件名が空・長すぎるなら受け付けない", () => {
    assert.equal(parseNewsMailRequest({ ...valid, subjectBody: "   " }), null);
    assert.equal(parseNewsMailRequest({ ...valid, subjectBody: "あ".repeat(400) }), null);
  });

  it("件名の改行は落としたうえで受け付ける", () => {
    assert.equal(parseNewsMailRequest({ ...valid, subjectBody: "先週の\nBcc: evil@example.com" })?.subjectBody, "先週の Bcc: evil@example.com");
  });

  it("未来の週・画面から到達できない週・知らない基準・鍵なしは受け付けない", () => {
    assert.equal(parseNewsMailRequest({ ...valid, weekOffset: 1 }), null);
    assert.equal(parseNewsMailRequest({ ...valid, weekOffset: -9 }), null);
    assert.equal(parseNewsMailRequest({ ...valid, weekOffset: -8 })?.weekOffset, -8);
    assert.equal(parseNewsMailRequest({ ...valid, basis: "unknown" }), null);
    assert.equal(parseNewsMailRequest({ ...valid, idempotencyKey: "" }), null);
  });

  it("本文のHTMLを渡されても結果には含めない（本文はサーバーが作る）", () => {
    const parsed = parseNewsMailRequest({ ...valid, bodyHtml: "<script>alert(1)</script>" });
    assert.ok(parsed !== null);
    assert.ok(!Object.hasOwn(parsed, "bodyHtml"));
  });
});
