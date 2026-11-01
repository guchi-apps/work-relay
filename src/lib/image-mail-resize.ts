// 画像メールの縮小サイズの計算（#340）。DOMに依存しない純関数にしておき、`node --test`で検証する。

/**
 * 短辺が`shortSide`になるよう縦横比を保って縮小したサイズを返す。
 * 短辺がすでに`shortSide`以下なら拡大せず、元のサイズのまま返す。
 */
export function computeResizedSize(width: number, height: number, shortSide: number): { width: number; height: number } {
  const scale = Math.min(1, shortSide / Math.min(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** プレビュー用サムネイルの長辺のpx（#349）。 */
export const THUMBNAIL_LONG_SIDE = 300;

/**
 * 長辺が`longSide`になるよう縦横比を保って縮小したサイズを返す（#349）。拡大はしない。
 */
export function computeThumbnailSize(width: number, height: number, longSide: number = THUMBNAIL_LONG_SIDE): { width: number; height: number } {
  const scale = Math.min(1, longSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
