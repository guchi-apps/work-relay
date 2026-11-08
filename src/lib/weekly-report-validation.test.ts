import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BUSINESSES } from "./business-defs.ts";
import { MAX_NORMALIZED_URL_LENGTH, MAX_SHORT_TEXT_LENGTH } from "./collection-rules.ts";
import { validateWeeklyReportInput } from "./weekly-report-validation.ts";

const business = DEFAULT_BUSINESSES[0].key;

function body(article: Record<string, unknown> = {}) {
  return {
    executedAt: "2026-11-08T00:00:00Z",
    targetFrom: "2026-11-01",
    targetTo: "2026-11-07",
    articles: [{ business, title: "タイトル", url: "https://example.com/a", sourceName: "媒体", informationType: "OTHER", ...article }],
  };
}

describe("validateWeeklyReportInput", () => {
  it("列幅ちょうどの文字列は受け付ける", () => {
    const long = "あ".repeat(MAX_SHORT_TEXT_LENGTH);
    assert.doesNotThrow(() => validateWeeklyReportInput(body({ title: long, sourceName: long, publisher: long, targetCompany: long, targetProduct: long, region: long }), DEFAULT_BUSINESSES));
  });

  for (const field of ["title", "sourceName", "publisher", "targetCompany", "targetProduct", "region"]) {
    it(`${field}が列幅を超えると断る`, () => {
      assert.throws(() => validateWeeklyReportInput(body({ [field]: "あ".repeat(MAX_SHORT_TEXT_LENGTH + 1) }), DEFAULT_BUSINESSES), new RegExp(`${field}は${MAX_SHORT_TEXT_LENGTH}文字まで`));
    });
  }

  it("正規化後のURLが列幅を超えると断る", () => {
    const url = `https://example.com/${"a".repeat(MAX_NORMALIZED_URL_LENGTH)}`;
    assert.throws(() => validateWeeklyReportInput(body({ url }), DEFAULT_BUSINESSES), /urlが長すぎます/);
  });

  it("トラッキング用クエリを除いて収まるURLは受け付ける", () => {
    const url = `https://example.com/a?utm_source=${"x".repeat(MAX_NORMALIZED_URL_LENGTH)}`;
    assert.doesNotThrow(() => validateWeeklyReportInput(body({ url }), DEFAULT_BUSINESSES));
  });

  it("文字列でないpublisherは断り、nullは受け付ける", () => {
    assert.throws(() => validateWeeklyReportInput(body({ publisher: 1 }), DEFAULT_BUSINESSES), /publisherが不正/);
    assert.doesNotThrow(() => validateWeeklyReportInput(body({ publisher: null }), DEFAULT_BUSINESSES));
  });
});
