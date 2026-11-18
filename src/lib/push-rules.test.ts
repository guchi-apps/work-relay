import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNewArticlesPayload,
  isSubscriptionGone,
  parseSubscriptionBody,
  shouldNotifyNewArticles,
} from "./push-rules.ts";

const valid = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "p", auth: "a" } };

test("購読の形が正しければ取り出せる", () => {
  assert.deepEqual(parseSubscriptionBody(valid), { endpoint: valid.endpoint, p256dh: "p", auth: "a" });
});

test("https以外・鍵欠け・非オブジェクトは断る", () => {
  assert.equal(parseSubscriptionBody({ ...valid, endpoint: "http://example.com/x" }), null);
  assert.equal(parseSubscriptionBody({ ...valid, endpoint: "not a url" }), null);
  assert.equal(parseSubscriptionBody({ endpoint: valid.endpoint }), null);
  assert.equal(parseSubscriptionBody({ ...valid, keys: { p256dh: "p" } }), null);
  assert.equal(parseSubscriptionBody(null), null);
  assert.equal(parseSubscriptionBody("x"), null);
});

test("endpointが長すぎる購読は断る", () => {
  assert.equal(parseSubscriptionBody({ ...valid, endpoint: `https://e.example/${"a".repeat(800)}` }), null);
});

test("新規0件の日は通知しない", () => {
  assert.equal(shouldNotifyNewArticles(0), false);
  assert.equal(shouldNotifyNewArticles(-1), false);
  assert.equal(shouldNotifyNewArticles(3), true);
});

test("通知文面には件数が入り、仕分け画面へ飛ぶ", () => {
  const payload = buildNewArticlesPayload(5);
  assert.match(payload.body, /5件/);
  assert.equal(payload.url, "/dashboard?triage=pending");
});

test("404・410だけを失効として扱う", () => {
  assert.equal(isSubscriptionGone(410), true);
  assert.equal(isSubscriptionGone(404), true);
  assert.equal(isSubscriptionGone(500), false);
  assert.equal(isSubscriptionGone(undefined), false);
});
