import assert from "node:assert/strict";
import { test } from "node:test";
import { articleBackLink, articleDetailHref, parseArticleOrigin, shouldAutoAnalyze } from "./article-back-link.ts";

test("from=inboxだけを一覧起点として読む", () => {
  assert.equal(parseArticleOrigin("inbox"), "inbox");
  assert.equal(parseArticleOrigin("https://evil.example"), null);
  assert.equal(parseArticleOrigin(["inbox"]), null);
  assert.equal(parseArticleOrigin(undefined), null);
});

test("戻り先は起点と仕分けタブで変わる", () => {
  assert.equal(articleBackLink("inbox").href, "/dashboard?triage=pending");
  assert.equal(articleBackLink("inbox", "adopted").href, "/dashboard?triage=adopted");
  assert.equal(articleBackLink("inbox", "//evil").href, "/dashboard?triage=pending");
  assert.equal(articleBackLink(null, "adopted").href, "/dashboard");
  assert.equal(articleBackLink("inbox", "adopted").label, "業界ニュースへ戻る");
});

test("自動解析は一覧から開いた未解析で、不採用でない記事だけ", () => {
  assert.equal(shouldAutoAnalyze("inbox", null, "pending"), true);
  assert.equal(shouldAutoAnalyze("inbox", null, "rejected"), false);
  assert.equal(shouldAutoAnalyze("inbox", "COMPLETED", "pending"), false);
  assert.equal(shouldAutoAnalyze("inbox", "FAILED", "pending"), false);
  assert.equal(shouldAutoAnalyze(null, null, "pending"), false);
});

test("詳細リンクは一覧起点のときだけfromと仕分けタブを付ける", () => {
  assert.equal(articleDetailHref("a1", "inbox"), "/dashboard/articles/a1?from=inbox");
  assert.equal(articleDetailHref("a1", "inbox", "rejected"), "/dashboard/articles/a1?from=inbox&triage=rejected");
  assert.equal(articleDetailHref("a1", null, "rejected"), "/dashboard/articles/a1");
});
