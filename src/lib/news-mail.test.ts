import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildNewsMail,
  buildNewsMailHtml,
  buildNewsMailSubject,
  buildNewsMailText,
  defaultSubjectBody,
  escapeHtml,
  MAX_NOTE_LENGTH,
  parseNewsMailRequest,
  sanitizeNote,
  sanitizeSubjectBody,
  SUBJECT_PREFIX,
  type NewsMailArticle,
} from "./news-mail.ts";

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

describe("sanitizeSubjectBody", () => {
  it("制御文字を空白にし、連続する空白をまとめる", () => {
    assert.equal(sanitizeSubjectBody("  a\t\t" + "b" + String.fromCharCode(0) + "c  "), "a b c");
  });
});

describe("sanitizeNote", () => {
  it("改行は残し、3つ以上の連続は2つにまとめ、前後の空白を削る", () => {
    assert.equal(sanitizeNote("  a\r\n\r\n\r\n\r\nb  "), "a\n\nb");
  });

  it("改行以外の制御文字は落とす", () => {
    assert.equal(sanitizeNote("a" + String.fromCharCode(0) + "b" + String.fromCharCode(27) + "c"), "abc");
  });
});

describe("defaultSubjectBody", () => {
  it("記事のタイトルを件名の初期値にし、上限で切る", () => {
    assert.equal(defaultSubjectBody({ title: "新製品を発表" }), "新製品を発表");
    assert.equal(defaultSubjectBody({ title: "あ".repeat(400) }).length, 160);
  });
});

describe("escapeHtml", () => {
  it("記号をすべて実体参照にする", () => {
    assert.equal(escapeHtml(`<b>"A"&'B'</b>`), "&lt;b&gt;&quot;A&quot;&amp;&#39;B&#39;&lt;/b&gt;");
  });
});

describe("buildNewsMailHtml", () => {
  const input = { article: article(), subjectBody: "x", note: "" };

  it("記事タイトル・要約・元記事リンクを含む", () => {
    const html = buildNewsMailHtml(input);
    assert.match(html, /後付けの通知ユニット/);
    assert.match(html, /工事なしで取り付けられる/);
    assert.match(html, /href="https:\/\/example\.com\/news\/1"/);
  });

  it("タイトルに混ざったHTMLはエスケープする", () => {
    const html = buildNewsMailHtml({ ...input, article: article({ title: "<script>alert(1)</script>" }) });
    assert.ok(!html.includes("<script>"));
    assert.match(html, /&lt;script&gt;/);
  });

  it("http以外のURLはリンクにしない", () => {
    const html = buildNewsMailHtml({ ...input, article: article({ originalUrl: "javascript:alert(1)" }) });
    assert.ok(!html.includes("javascript:"));
  });

  it("ひとことがあれば載せ、HTMLはエスケープする。空なら節ごと出さない", () => {
    const withNote = buildNewsMailHtml({ ...input, note: "来週話したい<b>" });
    assert.match(withNote, /ひとこと/);
    assert.match(withNote, /来週話したい&lt;b&gt;/);
    assert.ok(!buildNewsMailHtml(input).includes("ひとこと"));
  });

  it("未解析の記事には注記を添える", () => {
    const html = buildNewsMailHtml({ ...input, article: article({ analyzed: false }) });
    assert.match(html, /AI解析なし/);
    assert.match(html, /AI解析が終わっていない/);
  });
});

describe("buildNewsMailText", () => {
  it("HTMLタグを含まず、タイトル・URL・数値・ひとことを含む", () => {
    const text = buildNewsMailText({ article: article(), subjectBody: "x", note: "来週話したい" });
    assert.ok(!text.includes("<"));
    assert.match(text, /後付けの通知ユニット/);
    assert.match(text, /https:\/\/example\.com\/news\/1/);
    assert.match(text, /想定価格 12,800円/);
    assert.match(text, /【ひとこと】来週話したい/);
  });
});

describe("buildNewsMail", () => {
  it("件名・HTML・テキストをまとめて返す", () => {
    const mail = buildNewsMail({ article: article(), subjectBody: "気になる記事", note: "" });
    assert.equal(mail.subject, `${SUBJECT_PREFIX} 気になる記事`);
    assert.ok(mail.html.length > 0);
    assert.ok(mail.text.length > 0);
  });
});

describe("parseNewsMailRequest", () => {
  const valid = { articleId: "a1", subjectBody: "気になる記事", note: "来週話したい", idempotencyKey: "key-1" };

  it("正しい入力を受け付ける。ひとことは省略できる", () => {
    assert.deepEqual(parseNewsMailRequest(valid), valid);
    assert.equal(parseNewsMailRequest({ ...valid, note: undefined })?.note, "");
  });

  it("記事IDが空・文字列でないなら受け付けない", () => {
    assert.equal(parseNewsMailRequest({ ...valid, articleId: "  " }), null);
    assert.equal(parseNewsMailRequest({ ...valid, articleId: ["a1"] }), null);
  });

  it("件名が空・長すぎるなら受け付けない", () => {
    assert.equal(parseNewsMailRequest({ ...valid, subjectBody: "   " }), null);
    assert.equal(parseNewsMailRequest({ ...valid, subjectBody: "あ".repeat(400) }), null);
  });

  it("件名の改行は落としたうえで受け付ける", () => {
    assert.equal(parseNewsMailRequest({ ...valid, subjectBody: "先週の\nBcc: evil@example.com" })?.subjectBody, "先週の Bcc: evil@example.com");
  });

  it("ひとことが上限超過・文字列でないなら受け付けない", () => {
    assert.equal(parseNewsMailRequest({ ...valid, note: "あ".repeat(MAX_NOTE_LENGTH + 1) }), null);
    assert.equal(parseNewsMailRequest({ ...valid, note: 1 }), null);
    assert.ok(parseNewsMailRequest({ ...valid, note: "あ".repeat(MAX_NOTE_LENGTH) }) !== null);
  });

  it("鍵なしは受け付けない", () => {
    assert.equal(parseNewsMailRequest({ ...valid, idempotencyKey: "" }), null);
  });

  it("本文のHTMLを渡されても結果には含めない（本文はサーバーが作る）", () => {
    const parsed = parseNewsMailRequest({ ...valid, bodyHtml: "<script>alert(1)</script>" });
    assert.ok(parsed !== null);
    assert.ok(!Object.hasOwn(parsed, "bodyHtml"));
  });
});
