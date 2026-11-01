// ブラウザ内で完結する画像圧縮・ZIP化（#64）。元画像・圧縮画像・ZIPはResearch Deskの
// DBやサーバーディスクへ永続保存しない方針のため、ここで作った結果はメモリ上でのみ扱い、
// 呼び出し元がAIDEへの送信リクエストへそのまま載せる。

import { computeResizedSize } from "./image-mail-resize.ts";
import { planGroups } from "./image-mail-split.ts";

// 短辺（縦横のうち短いほう）のpx。キー名は互換のため`width`のまま据え置く（#340）。
export const WIDTH_PRESETS = [800, 1200, 1600] as const;
export const DEFAULT_WIDTH: WidthPreset = 1200;
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
  /** 縮小の基準にした短辺のpx。 */
  width: WidthPreset;
}

async function resizeImageToJpeg(file: File, shortSide: number): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = computeResizedSize(bitmap.width, bitmap.height, shortSide);
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
 * 短辺を`width`pxに縮小してJPEG化し、2MB以下の複数のZIPに分ける。自動で短辺を下げることはしない。
 * 画像は撮影順に詰めて2MB以下のZIPに分ける（#332）。
 */
export async function buildImageMailZip(files: File[], width: WidthPreset = DEFAULT_WIDTH): Promise<ImageMailZipResult> {
  if (files.length === 0) throw new Error("画像を1枚以上選択してください");
  const jpegs: Uint8Array[] = [];
  for (const file of files) jpegs.push(await resizeImageToJpeg(file, width));
  const groups = planGroups(jpegs.map((jpeg) => jpeg.byteLength), MAX_ZIP_SIZE_BYTES);

  const parts: ImageMailZipPart[] = [];
  for (const group of groups) {
    const entries = group.map((index) => ({ name: `${String(index + 1).padStart(2, "0")}.jpg`, data: jpegs[index] }));
    parts.push(...(await buildParts(entries)));
  }
  return { parts, width };
}

// 見積もりが外れて2MBを超えたときは、半分に割って作り直す。
async function buildParts(entries: { name: string; data: Uint8Array }[]): Promise<ImageMailZipPart[]> {
  const zip = await buildZip(Object.fromEntries(entries.map((entry) => [entry.name, entry.data])));
  if (zip.byteLength <= MAX_ZIP_SIZE_BYTES) return [{ zip, imageCount: entries.length }];
  if (entries.length === 1) throw new Error(`${entries[0].name.replace(".jpg", "")}枚目の写真が1枚だけで2MBを超えています。短辺を下げてもう一度お試しください`);
  const half = Math.ceil(entries.length / 2);
  return [...(await buildParts(entries.slice(0, half))), ...(await buildParts(entries.slice(half)))];
}
