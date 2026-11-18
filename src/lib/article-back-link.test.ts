import assert from "node:assert/strict";
import { test } from "node:test";
import { articleBackLink, articleDetailHref, parseArticleOrigin, shouldAutoAnalyze } from "./article-back-link.ts";

test("from=inboxだけを新着記事起点として読む", () => {
  assert.equal(parseArticleOrigin("inbox"), "inbox");
  assert.equal(parseArticleOrigin("https://evil.example"), null);
  assert.equal(parseArticleOrigin(["inbox"]), null);
  assert.equal(parseArticleOrigin(undefined), null);
});

test("戻り先は起点で変わる", () => {
  assert.equal(articleBackLink("inbox").href, "/dashboard/inbox");
  assert.equal(articleBackLink(null).href, "/dashboard");
});

test("自動解析は新着記事から開いた未解析の記事だけ", () => {
  assert.equal(shouldAutoAnalyze("inbox", null), true);
  assert.equal(shouldAutoAnalyze("inbox", "COMPLETED"), false);
  assert.equal(shouldAutoAnalyze("inbox", "FAILED"), false);
  assert.equal(shouldAutoAnalyze(null, null), false);
});

test("詳細リンクは新着記事起点のときだけfromを付ける", () => {
  assert.equal(articleDetailHref("a1", "inbox"), "/dashboard/articles/a1?from=inbox");
  assert.equal(articleDetailHref("a1", null), "/dashboard/articles/a1");
});
