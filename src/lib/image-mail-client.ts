// ブラウザ内で完結する画像圧縮・ZIP化（#64）。元画像・圧縮画像・ZIPはResearch Deskの
// DBやサーバーディスクへ永続保存しない方針のため、ここで作った結果はメモリ上でのみ扱い、
// 呼び出し元がAIDEへの送信リクエストへそのまま載せる。

import { planGroups } from "./image-mail-split.ts";

export const WIDTH_PRESETS = [1200, 900, 600] as const;
export type WidthPreset = (typeof WIDTH_PRESETS)[number];

export const MAX_ZIP_SIZE_BYTES = 2 * 1024 * 1024;

const JPEG_QUALITY = 0.82;

export interface ImageMailZipPart {
  zip: Uint8Array;
  imageCount: number;
}

export interface ImageMailZipResult {
  /** 2MB以下に収まるよう分けたZIP。1通で収まるときは1件。 */
  parts: ImageMailZipPart[];
  width: WidthPreset;
  autoDowngraded: boolean;
}

async function resizeImageToJpeg(file: File, maxWidth: number): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxWidth / bitmap.width);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("画像の描画コンテキストを取得できませんでした");
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    if (!blob) throw new Error(`${file.name}の圧縮に失敗しました`);
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

async function buildZip(entries: Record<string, Uint8Array>): Promise<Uint8Array> {
  const { zip } = await import("fflate");
  return new Promise((resolve, reject) => {
    zip(entries, { level: 6 }, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

/**
 * 横幅を手動指定した場合はその横幅だけで作る。自動（`manualWidth`未指定）の場合は
 * 1200→900→600pxの順に作り直し、1通に収まった時点で止める。
 * 最後の横幅でも2MBを超えるときは、画像を撮影順に詰めて2MB以下の複数のZIPに分ける（#332）。
 */
export async function buildImageMailZip(files: File[], manualWidth: WidthPreset | null): Promise<ImageMailZipResult> {
  if (files.length === 0) throw new Error("画像を1枚以上選択してください");
  const widths = manualWidth ? [manualWidth] : WIDTH_PRESETS;

  for (const [widthIndex, width] of widths.entries()) {
    const jpegs: Uint8Array[] = [];
    for (const file of files) jpegs.push(await resizeImageToJpeg(file, width));
    const groups = planGroups(jpegs.map((jpeg) => jpeg.byteLength), MAX_ZIP_SIZE_BYTES);
    const isLast = widthIndex === widths.length - 1;
    if (groups.length > 1 && !isLast) continue;

    const parts: ImageMailZipPart[] = [];
    for (const group of groups) {
      const entries = group.map((index) => ({ name: `${String(index + 1).padStart(2, "0")}.jpg`, data: jpegs[index] }));
      parts.push(...(await buildParts(entries)));
    }
    return { parts, width, autoDowngraded: !manualWidth && width !== WIDTH_PRESETS[0] };
  }
  throw new Error("ZIPの作成に失敗しました");
}

// 見積もりが外れて2MBを超えたときは、半分に割って作り直す。
async function buildParts(entries: { name: string; data: Uint8Array }[]): Promise<ImageMailZipPart[]> {
  const zip = await buildZip(Object.fromEntries(entries.map((entry) => [entry.name, entry.data])));
  if (zip.byteLength <= MAX_ZIP_SIZE_BYTES) return [{ zip, imageCount: entries.length }];
  if (entries.length === 1) throw new Error(`${entries[0].name.replace(".jpg", "")}枚目の写真が1枚だけで2MBを超えています。横幅を下げてもう一度お試しください`);
  const half = Math.ceil(entries.length / 2);
  return [...(await buildParts(entries.slice(0, half))), ...(await buildParts(entries.slice(half)))];
}
