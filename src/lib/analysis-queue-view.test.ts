import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatClock, formatDuration, formatLeaseRemaining, formatSnapshotTime, leaseProgress, orderQueue, startOfJstDay } from "./analysis-queue-view.ts";

describe("formatDuration", () => {
  it("1分未満は秒だけ、1時間未満は分と秒、それ以上は時間と分で出す", () => {
    assert.equal(formatDuration(58_400), "58秒");
    assert.equal(formatDuration(192_000), "3分12秒");
    assert.equal(formatDuration(65 * 60_000 + 30_000), "1時間5分");
  });

  it("時計のずれで負になっても0秒として出す", () => {
    assert.equal(formatDuration(-5_000), "0秒");
  });
});

describe("formatClock / formatSnapshotTime", () => {
  it("サーバーのタイムゾーンに関わらずJSTで出す", () => {
    const date = new Date("2026-09-17T05:32:10Z");
    assert.equal(formatClock(date), "14:32");
    assert.equal(formatSnapshotTime(date), "9/17 14:32:10");
  });
});

describe("formatLeaseRemaining", () => {
  const now = new Date("2026-09-17T05:00:00Z");

  it("残り時間を分単位で切り上げて出す", () => {
    assert.equal(formatLeaseRemaining(new Date("2026-09-17T05:10:30Z"), now), "期限まで 11分");
  });

  it("期限を過ぎても解析中のまま残っていたら、ポーラーが止まっている可能性を出す", () => {
    assert.equal(formatLeaseRemaining(new Date("2026-09-17T04:59:00Z"), now), "期限切れ（ポーラー停止の可能性）");
    assert.equal(formatLeaseRemaining(now, now), "期限切れ（ポーラー停止の可能性）");
  });

  it("期限の記録が無いジョブは期限なしとして出す", () => {
    assert.equal(formatLeaseRemaining(null, now), "期限なし");
  });
});

describe("leaseProgress", () => {
  const startedAt = new Date("2026-09-17T05:00:00Z");
  const leaseExpiresAt = new Date("2026-09-17T05:15:00Z");

  it("取得から期限までのうち経過した割合を返す", () => {
    assert.equal(leaseProgress(startedAt, leaseExpiresAt, new Date("2026-09-17T05:03:00Z")), 0.2);
  });

  it("0〜1の範囲に収める", () => {
    assert.equal(leaseProgress(startedAt, leaseExpiresAt, new Date("2026-09-17T04:59:00Z")), 0);
    assert.equal(leaseProgress(startedAt, leaseExpiresAt, new Date("2026-09-17T05:30:00Z")), 1);
    assert.equal(leaseProgress(null, leaseExpiresAt, startedAt), 0);
  });
});

describe("startOfJstDay", () => {
  it("JSTの日付が変わった直後はその日の0時を返す", () => {
    assert.equal(startOfJstDay(new Date("2026-09-16T15:30:00Z")).toISOString(), "2026-09-16T15:00:00.000Z");
  });

  it("JSTの23時台は同じ日の0時を返す（UTCでは前日になる時間帯）", () => {
    assert.equal(startOfJstDay(new Date("2026-09-17T14:59:00Z")).toISOString(), "2026-09-16T15:00:00.000Z");
  });
});

describe("orderQueue", () => {
  it("積んだ時刻の古い順に並べる", () => {
    const entries = [
      { id: "a2", queuedAt: new Date("2026-09-17T05:05:00Z") },
      { id: "a1", queuedAt: new Date("2026-09-17T05:01:00Z") },
    ];
    assert.deepEqual(orderQueue(entries).map((entry) => entry.id), ["a1", "a2"]);
  });
});
