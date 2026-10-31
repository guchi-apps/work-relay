// 画像メール送信時、AIDEへ転送するZIPの添付ファイル名を組み立てる（#118）。
// 「yymmdd タイトル.zip」形式にする（#329でコロン区切りをやめた）。日付はJST基準（研究デスクは社内利用のみのため固定）。

export function buildImageMailZipFileName(title: string, now: Date): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const get = (type: "year" | "month" | "day") => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")} ${title}.zip`;
}
