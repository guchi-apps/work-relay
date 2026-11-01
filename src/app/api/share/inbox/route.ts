import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { json, requireShareShortcutToken } from "@/lib/internal-auth";
import { getRequestOrigin } from "@/lib/request-origin";
import { acceptsJson, buildSharePagePath, getShareInboxStore, isRequestBodyTooLarge, normalizeBatchId, normalizeSharedText, putShareEntry, takeShareEntry, type PutResult, type SharedFile } from "@/lib/share-inbox";

export const runtime = "nodejs";

const PUT_ERROR_MESSAGES: Record<Exclude<PutResult, { ok: true }>["reason"], string> = {
  no_files: "写真が含まれていませんでした",
  too_many_files: "一度に送れる写真は20枚までです",
  too_large: "写真の合計が10MBを超えています。ショートカットで写真を縮めてから送ってください",
  not_image: "写真以外のファイルは受け取れません",
};

/**
 * 共有の受け口（#144）。呼び出し元は2つある。
 *
 * - iPhoneのショートカット（`Authorization: Bearer <SHARE_SHORTCUT_TOKEN>`）。JSONで開くURLを返し、
 *   ショートカットがそれをSafariで開く
 * - Androidのホーム画面アプリの共有メニュー（manifestの`share_target`）。ブラウザがこのURLへ
 *   フォームを送って遷移してくるので、セッションで認証して行き先へ303で飛ばす
 *
 * 写真はメモリにだけ置く（`src/lib/share-inbox.ts`）。URL・文章は置かずにクエリで画面へ渡す。
 * `batch`が同じ写真は1つの共有としてまとめる。応答の`count`は、まとめた合計の枚数。
 */
export async function POST(request: Request) {
  const fromShortcut = request.headers.has("authorization");
  // iOSアプリ（共有拡張から受け取った内容を渡す。#318）はセッションで認証し、リダイレクトではなくJSONで受ける。
  // `fromShortcut`以降の分岐は「JSONで返す呼び出し元か」の意味なので、名前は変えずに値だけ広げる。
  const asJson = fromShortcut || acceptsJson(request.headers.get("accept"));
  const origin = getRequestOrigin(request);
  // 置いた利用者。ショートカット（トークン認証）は利用者を持たないのでnull。
  let owner: string | null = null;

  if (fromShortcut) {
    const denied = requireShareShortcutToken(request);
    if (denied) return denied;
  } else {
    const user = await getCurrentUser();
    if (user.status === "unavailable") return json({ error: "auth_unavailable", message: "認証状態を確認できませんでした" }, 503);
    // 共有メニューからの遷移はページ遷移なので、401のJSONではなくログイン画面へ送る。
    // 送られてきた内容はここで失われるため、ログイン後にもう一度共有してもらう。
    // JSONで受ける呼び出し元（iOSアプリ）には401を返し、アプリが内容を端末に残したままログインへ案内する。
    if (user.status === "unauthenticated") return asJson ? json({ error: "unauthorized", message: "ログインが切れています" }, 401) : NextResponse.redirect(`${origin}/login`, 303);
    if (user.status === "authenticated") owner = user.user.email;
  }

  // `formData()`は本文を全部メモリへ読み込むので、上限を超えると分かっているものは読む前に断る（#172）。
  if (isRequestBodyTooLarge(request.headers.get("content-length"))) {
    const reason = "too_large";
    return asJson ? json({ error: reason, message: PUT_ERROR_MESSAGES[reason] }, 413) : NextResponse.redirect(`${origin}/dashboard/image-mail?shareError=${reason}`, 303);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return asJson ? json({ error: "invalid_form", message: "送られてきた内容を読み取れませんでした" }, 400) : NextResponse.redirect(`${origin}/dashboard/share`, 303);
  }

  // ショートカットの「ファイル」フィールドは先頭の1枚しか送らないため、「繰り返す」で1枚ずつ送る。
  // 同じ`batch`の写真は1つの置き場へ追記する（#163）。
  const batch = normalizeBatchId(stringField(form, "batch"));
  if (batch === "invalid") {
    const message = "batchは半角英数字と . _ : - の64文字以内にしてください";
    return asJson ? json({ error: "invalid_batch", message }, 400) : NextResponse.redirect(`${origin}/dashboard/image-mail?shareError=invalid_batch`, 303);
  }

  // 再送を見分ける冪等キー（iOSアプリは`PendingShare.id`）。同じ利用者の同じキーは最初の共有を返す。
  const shareKey = normalizeBatchId(stringField(form, "shareKey"));
  if (shareKey === "invalid") {
    const message = "shareKeyは半角英数字と . _ : - の64文字以内にしてください";
    return asJson ? json({ error: "invalid_share_key", message }, 400) : NextResponse.redirect(`${origin}/dashboard/image-mail?shareError=invalid_share_key`, 303);
  }

  const shared = normalizeSharedText({ title: stringField(form, "title"), text: stringField(form, "text"), url: stringField(form, "url") });
  // ショートカットのフォームで配列のキーを`files[]`と書いた場合も受け付ける。
  const blobs = [...form.getAll("files"), ...form.getAll("files[]")].filter((value): value is File => value instanceof File && value.size > 0);

  if (blobs.length === 0) {
    const path = buildSharePagePath(shared);
    return asJson ? json({ ok: true, kind: "text", openUrl: `${origin}${path}` }, 200) : NextResponse.redirect(`${origin}${path}`, 303);
  }

  const files: SharedFile[] = await Promise.all(blobs.map(async (blob, index) => ({ name: blob.name || `photo-${index + 1}.jpg`, type: blob.type.startsWith("image/") ? blob.type : guessImageType(blob.name), data: new Uint8Array(await blob.arrayBuffer()) })));
  // 写真に添えられた文章（URL以外）は写真タイトルの候補にする。
  const title = shared.title || shared.text.split(/\r?\n/)[0] || "";
  const result = putShareEntry(getShareInboxStore(), { title, files, batch, key: shareKey, owner }, Date.now());

  if (!result.ok) {
    const message = PUT_ERROR_MESSAGES[result.reason];
    return asJson ? json({ error: result.reason, message }, result.reason === "too_large" ? 413 : 400) : NextResponse.redirect(`${origin}/dashboard/image-mail?shareError=${result.reason}`, 303);
  }

  const openUrl = `${origin}/dashboard/image-mail?shared=${result.id}`;
  return asJson ? json({ ok: true, kind: "photos", count: result.count, openUrl }, 200) : NextResponse.redirect(openUrl, 303);
}

/**
 * 「画像を送る」画面が写真を受け取る。`?id=`が無ければ一番新しいものを返す（ログインし直して
 * 開いた場合など）。返したら置き場から消す。無ければ204。
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (user.status === "unavailable") return json({ error: "auth_unavailable" }, 503);
  if (user.status === "unauthenticated") return json({ error: "unauthorized" }, 401);

  const id = new URL(request.url).searchParams.get("id");
  const entry = takeShareEntry(getShareInboxStore(), id, Date.now(), user.user.email);
  if (!entry) return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });

  const body = new FormData();
  body.set("title", entry.title);
  for (const file of entry.files) body.append("files", new File([file.data as Uint8Array<ArrayBuffer>], file.name, { type: file.type }));
  return new NextResponse(body, { status: 200, headers: { "Cache-Control": "no-store" } });
}

function stringField(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" ? value : null;
}

// ショートカットの「URLの内容を取得」は、ファイルの種類を付けないか`application/octet-stream`で送ることがある。
function guessImageType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}
