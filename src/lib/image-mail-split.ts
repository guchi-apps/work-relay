// 画像メールのZIPを2MB以下に分割する計画（#332）。DBにもブラウザAPIにも依存しない純関数に
// しておき、`node --test`で検証できるようにする。

/** ZIP1件あたりのヘッダ分の見積もり（ローカルヘッダ＋中央ディレクトリ＋ファイル名）。 */
export const ZIP_ENTRY_OVERHEAD_BYTES = 160;
/** ZIP全体の終端レコード分の見積もり。 */
export const ZIP_BASE_OVERHEAD_BYTES = 22;

export function estimateZipSize(sizes: number[]): number {
  return sizes.reduce((total, size) => total + size + ZIP_ENTRY_OVERHEAD_BYTES, ZIP_BASE_OVERHEAD_BYTES);
}

/**
 * 画像の並び順を保ったまま、見積もりが`limit`以下になるよう先頭から詰めてグループに分ける。
 * 返すのは各グループの画像の添字。1枚だけで`limit`を超える画像は、そのまま1枚のグループになる
 * （呼び出し側が「1枚で超えている」と判断できるようにするため）。
 */
export function planGroups(sizes: number[], limit: number): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  let currentSizes: number[] = [];
  for (const [index, size] of sizes.entries()) {
    if (current.length > 0 && estimateZipSize([...currentSizes, size]) > limit) {
      groups.push(current);
      current = [];
      currentSizes = [];
    }
    current.push(index);
    currentSizes.push(size);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** 件名・添付名に付ける連番。1通だけのときは付けない。 */
export function formatPartSuffix(partIndex: number, partTotal: number): string {
  return partTotal > 1 ? ` (${partIndex}/${partTotal})` : "";
}
