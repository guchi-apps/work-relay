/**
 * 解析状況画面（#137）の表示用の計算。DB・Prismaに触れない純粋な関数だけを置き、
 * `node --test`から直接読めるようにしている。
 */

import { DAY_MS, JST_OFFSET_MS, jstParts } from "./jst-week.ts";

/** 画面を自動で最新化する間隔。ポーラーの取得間隔より短くしても表示は変わらない。 */
export const AUTO_REFRESH_SECONDS = 15;

/** 「最近完了」に出す件数。 */
export const RECENT_COMPLETED_LIMIT = 10;

/** 「要対応」に出す件数の上限。溜まり続けても画面が伸びきらないようにする。 */
export const ATTENTION_LIMIT = 20;

/** 経過時間・所要時間（例: `58秒`・`3分12秒`・`1時間5分`）。負の値は0として扱う。 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}分${String(totalSeconds % 60).padStart(2, "0")}秒`;
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}

/** JSTの時刻（例: `14:29`）。 */
export function formatClock(date: Date): string {
  const { hour, minute } = jstParts(date);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** 画面の「◯時点」（例: `9/17 14:32:10`）。自動更新で変わったことが分かるよう秒まで出す。 */
export function formatSnapshotTime(date: Date): string {
  const { month, day } = jstParts(date);
  const seconds = Math.floor((date.getTime() + JST_OFFSET_MS) / 1000) % 60;
  return `${month}/${day} ${formatClock(date)}:${String(seconds).padStart(2, "0")}`;
}

/**
 * 「期限まで ◯分」。
 *
 * 期限切れのジョブを待ちへ戻すのはポーラーの取得（`claimAnalysisJobs()`）だけなので、期限を
 * 過ぎても解析中のまま残っているのは、ポーラーが止まっている（取りに来ていない）ときに限られる。
 */
export function formatLeaseRemaining(leaseExpiresAt: Date | null, now: Date): string {
  if (!leaseExpiresAt) return "期限なし";
  const remaining = leaseExpiresAt.getTime() - now.getTime();
  if (remaining <= 0) return "期限切れ（ポーラー停止の可能性）";
  return `期限まで ${Math.ceil(remaining / 60_000)}分`;
}

/**
 * 実行中ジョブの進み具合（0〜1）。解析の実時間は分からないため、取得から期限までのうち
 * どれだけ経ったかを出す。バーが右端へ近づくほど期限切れ（落ちた扱い）が近い。
 */
export function leaseProgress(startedAt: Date | null, leaseExpiresAt: Date | null, now: Date): number {
  if (!startedAt || !leaseExpiresAt) return 0;
  const total = leaseExpiresAt.getTime() - startedAt.getTime();
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, (now.getTime() - startedAt.getTime()) / total));
}

/** JSTの今日0時。「今日の実績」の集計開始に使う。 */
export function startOfJstDay(now: Date): Date {
  const jst = now.getTime() + JST_OFFSET_MS;
  return new Date(jst - (jst % DAY_MS) - JST_OFFSET_MS);
}

export type QueueEntry = { queuedAt: Date };

/** 待ち行列を、ポーラーが実際に取る順（積んだ時刻の古い順）に並べる。 */
export function orderQueue<T extends QueueEntry>(entries: T[]): T[] {
  return [...entries].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime());
}
