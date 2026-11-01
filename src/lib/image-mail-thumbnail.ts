// 写真プレビュー用の小さなサムネイルを作る（#349）。元画像をそのまま表示すると枚数ぶんフルサイズで
// デコードされて重いため、長辺300pxのJPEGを1枚ずつ作る。ZIPに入る画像とは無関係。

import { THUMBNAIL_LONG_SIDE, computeThumbnailSize } from "./image-mail-resize.ts";

const THUMBNAIL_QUALITY = 0.7;

export interface NetworkHint {
  saveData?: boolean;
  effectiveType?: string;
}

/** データ節約・低速回線のときはサムネイルを自動では作らない。情報が取れない環境では作る。 */
export function shouldSkipThumbnails(connection: NetworkHint | null | undefined): boolean {
  if (!connection) return false;
  return connection.saveData === true || connection.effectiveType === "slow-2g" || connection.effectiveType === "2g";
}

export function readNetworkHint(): NetworkHint | null {
  if (typeof navigator === "undefined") return null;
  return (navigator as Navigator & { connection?: NetworkHint }).connection ?? null;
}

/** サムネイルのBlob URLを返す。呼び出し側が`URL.revokeObjectURL`で解放する。 */
export async function createThumbnailUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = computeThumbnailSize(bitmap.width, bitmap.height, THUMBNAIL_LONG_SIDE);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", THUMBNAIL_QUALITY));
    if (!blob) throw new Error("thumbnail failed");
    return URL.createObjectURL(blob);
  } finally {
    bitmap.close();
  }
}
