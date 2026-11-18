import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cardBadge, dayHeading, defaultTriageTab, formatDayWithWeekday, groupByCollectedDay, isStaleArticle, jstDayKey, jstDayStart, parsePeriodParam, periodParam, sumRunCounts } from "./timeline.ts";

const jst = (value: string) => new Date(`${value}+09:00`);

describe("parsePeriodParam", () => {
  it("未指定・不正な値は直近30日", () => {
    assert.deepEqual(parsePeriodParam(undefined), { kind: "recent" });
    assert.deepEqual(parsePeriodParam("recent"), { kind: "recent" });
    assert.deepEqual(parsePeriodParam("w1"), { kind: "recent" });
    assert.deepEqual(parsePeriodParam(["w0"]), { kind: "recent" });
    assert.deepEqual(parsePeriodParam("w-01"), { kind: "recent" });
  });

  it("w0〜w-8は週の指定として読み、それより前は直近30日に戻す", () => {
    assert.deepEqual(parsePeriodParam("w0"), { kind: "week", offset: 0 });
    assert.deepEqual(parsePeriodParam("w-8"), { kind: "week", offset: -8 });
    assert.deepEqual(parsePeriodParam("w-9"), { kind: "recent" });
  });

  it("periodParamで元の値に戻せる", () => {
    assert.equal(periodParam({ kind: "recent" }), "recent");
    assert.equal(periodParam({ kind: "week", offset: -2 }), "w-2");
  });
});

describe("JSTの日付", () => {
  it("UTCでは前日でもJSTの日付で区切る", () => {
    assert.equal(jstDayKey(new Date("2026-11-17T20:30:00Z")), "2026-11-18");
    assert.equal(jstDayStart(jst("2026-11-18T05:12:00")).toISOString(), "2026-11-17T15:00:00.000Z");
  });

  it("見出しは今日・昨日・曜日付きの日付", () => {
    const now = jst("2026-11-18T09:00:00");
    assert.equal(dayHeading(jst("2026-11-18T00:10:00"), now), "今日");
    assert.equal(dayHeading(jst("2026-11-17T23:50:00"), now), "昨日");
    assert.equal(dayHeading(jst("2026-11-16T12:00:00"), now), "11月16日（月）");
    assert.equal(formatDayWithWeekday(jst("2026-11-18T23:59:00")), "11月18日（水）");
  });
});

describe("groupByCollectedDay", () => {
  const item = (id: string, collectedAt: string, publishedAt: string | null) => ({ id, collectedAt: jst(collectedAt), publishedAt: publishedAt ? jst(publishedAt) : null, occurredAt: null });

  it("取り込んだ日の新しい順に区切り、同じ日の中は公開日の新しい順に並べる", () => {
    const days = groupByCollectedDay([
      item("old-collected", "2026-11-17T05:00:00", "2026-11-17T01:00:00"),
      item("today-old-news", "2026-11-18T05:00:00", "2026-11-12T10:00:00"),
      item("today-fresh", "2026-11-18T05:01:00", "2026-11-17T22:00:00"),
      item("today-no-date", "2026-11-18T05:02:00", null),
    ]);
    assert.deepEqual(days.map((day) => day.key), ["2026-11-18", "2026-11-17"]);
    assert.deepEqual(days[0].items.map((entry) => entry.id), ["today-no-date", "today-fresh", "today-old-news"]);
    assert.deepEqual(days[1].items.map((entry) => entry.id), ["old-collected"]);
  });

  it("空なら空", () => {
    assert.deepEqual(groupByCollectedDay([]), []);
  });
});

describe("isStaleArticle", () => {
  it("取り込んだ時点で公開から3日以上たった記事だけ", () => {
    assert.equal(isStaleArticle({ collectedAt: jst("2026-11-18T05:00:00"), publishedAt: jst("2026-11-15T05:00:00"), occurredAt: null }), true);
    assert.equal(isStaleArticle({ collectedAt: jst("2026-11-18T05:00:00"), publishedAt: jst("2026-11-15T06:00:00"), occurredAt: null }), false);
    assert.equal(isStaleArticle({ collectedAt: jst("2026-11-18T05:00:00"), publishedAt: null, occurredAt: jst("2026-11-01T00:00:00") }), true);
    assert.equal(isStaleArticle({ collectedAt: jst("2026-11-18T05:00:00"), publishedAt: null, occurredAt: null }), false);
  });
});

describe("defaultTriageTab", () => {
  it("未判定があれば未判定、無ければ採用を開く", () => {
    assert.equal(defaultTriageTab(3), "pending");
    assert.equal(defaultTriageTab(0), "adopted");
  });
});

describe("今日の収集", () => {
  it("複数のランの件数を合計する", () => {
    assert.deepEqual(sumRunCounts([{ insertedCount: 5, mergedCount: 1, excludedCount: 0 }, { insertedCount: 7, mergedCount: 2, excludedCount: 1 }]), { insertedCount: 12, mergedCount: 3, excludedCount: 1 });
    assert.deepEqual(sumRunCounts([]), { insertedCount: 0, mergedCount: 0, excludedCount: 0 });
  });

  it("今日のランで作られた記事はNEW、統合された記事は更新", () => {
    const today = new Set(["run-today"]);
    assert.equal(cardBadge({ collectionRunId: "run-today", updatedByRunId: "run-today" }, today), "new");
    assert.equal(cardBadge({ collectionRunId: "run-old", updatedByRunId: "run-today" }, today), "updated");
    assert.equal(cardBadge({ collectionRunId: "run-old", updatedByRunId: "run-old" }, today), null);
    assert.equal(cardBadge({ collectionRunId: null, updatedByRunId: null }, today), null);
  });
});
