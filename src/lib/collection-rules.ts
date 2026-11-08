// 日次収集のうち、DBに触らない判定。`collection.ts`はPrismaをimportするためテストから読めないので、
// テストしたいロジックはここへ置く（`analysis-job-rules.ts`と同じ切り分け）。

/** `industry_information.normalizedUrl`の列幅（`prisma/schema.prisma`の`VarChar(512)`）。 */
export const MAX_NORMALIZED_URL_LENGTH = 512;

/**
 * `industry_information`の`title`・`sourceName`・`publisher`・`targetCompany`・`targetProduct`・`region`の
 * 列幅。`@db`指定の無い`String`はマイグレーションで`VARCHAR(191)`になる。超えるとINSERTがP2000で落ちる。
 */
export const MAX_SHORT_TEXT_LENGTH = 191;

/** 同じ記事を指すURLを揃える（トラッキング用クエリ・フラグメント・末尾スラッシュを除く）。 */
export function normalizeUrl(value: string): string {
  try {
    const url = new URL(value); url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) url.searchParams.delete(key);
    return url.toString().replace(/\/$/, "");
  } catch { return value.trim().replace(/\/$/, ""); }
}

/** 正規化後のURLが`normalizedUrl`列に収まるか。超えるとINSERTがP2000で落ちる。 */
export function fitsNormalizedUrlColumn(normalizedUrl: string): boolean {
  return normalizedUrl.length <= MAX_NORMALIZED_URL_LENGTH;
}

export type DailyRunStatus = "SUCCEEDED" | "PARTIAL" | "FAILED";

/**
 * 日次収集の実行結果の状態。フィードが全部取れなかった、または登録しようとした候補が全部失敗した
 * ときだけ`FAILED`にし、一部でも失敗があれば`PARTIAL`、何も失敗していなければ`SUCCEEDED`にする。
 */
export function decideDailyRunStatus(input: { feedCount: number; feedFailures: number; selectedCount: number; articleFailures: number }): DailyRunStatus {
  const { feedCount, feedFailures, selectedCount, articleFailures } = input;
  if (feedFailures >= feedCount) return "FAILED";
  if (selectedCount > 0 && articleFailures >= selectedCount) return "FAILED";
  return feedFailures + articleFailures > 0 ? "PARTIAL" : "SUCCEEDED";
}
