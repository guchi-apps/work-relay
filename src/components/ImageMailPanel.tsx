"use client";

import { useEffect, useRef, useState } from "react";
import { formatPartSuffix } from "@/lib/image-mail-split";
import { WIDTH_PRESETS, buildImageMailZip, type ImageMailZipResult, type WidthPreset } from "@/lib/image-mail-client";

type WidthMode = "auto" | WidthPreset;
type ShareNotice = { kind: "received"; count: number } | { kind: "error"; message: string };

const SHARE_ERROR_MESSAGES: Record<string, string> = {
  no_files: "共有された内容に写真が含まれていませんでした。",
  too_many_files: "一度に共有できる写真は20枚までです。枚数を減らしてもう一度共有してください。",
  too_large: "共有された写真の合計が10MBを超えていました。枚数を減らしてもう一度共有してください。",
  not_image: "写真以外のファイルは受け取れません。",
};

type Props = {
  /** ショートカット・共有メニューから開いたときの受け取り番号（`?shared=`）。 */
  sharedId: string | null;
  /** 共有の受け口で断ったときの理由（`?shareError=`）。 */
  shareError: string | null;
};
type PartStatus = "waiting" | "sending" | "done" | "failed";
type SendResult = { ok: true } | { ok: false; message: string };

interface SelectedImage {
  id: string;
  file: File;
  previewUrl: string;
}

const PART_STATUS_LABELS: Record<PartStatus, string> = { waiting: "待機中", sending: "送信中…", done: "送信済み", failed: "失敗" };

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// PC/スマホ問わず同じ<input>から起動する。`capture="environment"`は対応端末でだけ
// 背面カメラを直接開き、非対応環境では通常のファイル選択にフォールバックする。
export default function ImageMailPanel({ sharedId, shareError }: Props) {
  const [title, setTitle] = useState("");
  const [images, setImages] = useState<SelectedImage[]>([]);
  const [widthMode, setWidthMode] = useState<WidthMode>("auto");
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [buildResult, setBuildResult] = useState<ImageMailZipResult | null>(null);
  // 分割した各通の送信状態と、通ごとの重複送信防止キー（#332）。
  const [partKeys, setPartKeys] = useState<string[]>([]);
  const [partStatuses, setPartStatuses] = useState<PartStatus[]>([]);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<SendResult | null>(null);

  const [shareNotice, setShareNotice] = useState<ShareNotice | null>(shareError ? { kind: "error", message: SHARE_ERROR_MESSAGES[shareError] ?? "共有された写真を受け取れませんでした。" } : null);

  const captureInputRef = useRef<HTMLInputElement>(null);
  const pickInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      for (const image of images) URL.revokeObjectURL(image.previewUrl);
    };
  }, [images]);

  // 共有された写真（#144）はサーバーのメモリに一時的に置かれている。受け取ると向こうからは消える。
  // `?shared=`が無くても問い合わせるのは、ログインし直してから開いた場合にも拾うため。
  // 一度受け取ると二度目は204になるので、開発時のStrictModeでエフェクトが2回走っても
  // 問い合わせは1回に限る（中断もしない。1回目の結果を捨てると写真が失われる）。
  const shareFetchedRef = useRef(false);
  useEffect(() => {
    if (shareFetchedRef.current) return;
    shareFetchedRef.current = true;
    const query = sharedId ? `?id=${encodeURIComponent(sharedId)}` : "";
    (async () => {
      try {
        const response = await fetch(`/api/share/inbox${query}`, { cache: "no-store" });
        if (response.status === 204) {
          if (sharedId) setShareNotice({ kind: "error", message: "共有された写真が見つかりませんでした。受け取りから10分以上経ったか、すでに読み込み済みです。もう一度共有してください。" });
          return;
        }
        if (!response.ok) return;
        const form = await response.formData();
        const files = form.getAll("files").filter((value): value is File => value instanceof File);
        const sharedTitle = form.get("title");
        if (files.length === 0) return;
        addFiles(files);
        if (typeof sharedTitle === "string" && sharedTitle) setTitle((current) => current || sharedTitle);
        setShareNotice({ kind: "received", count: files.length });
      } catch {
        if (sharedId) setShareNotice({ kind: "error", message: "共有された写真の読み込みに失敗しました。もう一度共有してください。" });
      } finally {
        // 再読み込みで同じ番号を問い合わせ直さないよう、アドレスバーからクエリを外す。
        if (sharedId || shareError) window.history.replaceState(null, "", window.location.pathname);
      }
    })();
    // 表示時に一度だけ問い合わせる。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetOutcome() {
    setBuildResult(null);
    setBuildError(null);
    setPartKeys([]);
    setPartStatuses([]);
    setSendResult(null);
  }

  function addFiles(fileList: FileList | File[] | null) {
    if (!fileList || fileList.length === 0) return;
    const added = Array.from(fileList).map((file) => ({ id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file) }));
    setImages((current) => [...current, ...added]);
    resetOutcome();
  }

  function removeImage(id: string) {
    setImages((current) => {
      const target = current.find((image) => image.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return current.filter((image) => image.id !== id);
    });
    resetOutcome();
  }

  async function handleBuild() {
    setBuilding(true);
    setBuildError(null);
    try {
      const manualWidth = widthMode === "auto" ? null : widthMode;
      const result = await buildImageMailZip(images.map((image) => image.file), manualWidth);
      setBuildResult(result);
      setPartKeys(result.parts.map(() => crypto.randomUUID()));
      setPartStatuses(result.parts.map(() => "waiting"));
      setSendResult(null);
    } catch (error) {
      setBuildResult(null);
      setBuildError(error instanceof Error ? error.message : "ZIPの作成に失敗しました");
    } finally {
      setBuilding(false);
    }
  }

  function setPartStatus(index: number, status: PartStatus) {
    setPartStatuses((current) => current.map((value, i) => (i === index ? status : value)));
  }

  // 送信済みでない最初の通から順に送る。失敗したらそこで止め、再度押すとその通から再開する。
  async function handleSend() {
    if (!buildResult) return;
    setSending(true);
    setSendResult(null);
    const total = buildResult.parts.length;
    try {
      for (const [index, part] of buildResult.parts.entries()) {
        if (partStatuses[index] === "done") continue;
        setPartStatus(index, "sending");
        const form = new FormData();
        form.set("title", title.trim());
        form.set("imageCount", String(part.imageCount));
        form.set("width", String(buildResult.width));
        form.set("idempotencyKey", partKeys[index]);
        form.set("partIndex", String(index + 1));
        form.set("partTotal", String(total));
        form.set("zip", new Blob([new Uint8Array(part.zip)], { type: "application/zip" }), "images.zip");

        let failure: string | null = null;
        try {
          const response = await fetch("/api/image-mail/send", { method: "POST", body: form });
          if (!response.ok) {
            const body: unknown = await response.json().catch(() => null);
            failure = body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : "送信に失敗しました";
          }
        } catch {
          failure = "通信に失敗しました。しばらくしてから再試行してください";
        }
        if (failure) {
          setPartStatus(index, "failed");
          setSendResult({ ok: false, message: total > 1 ? `${index + 1}/${total}通目の送信に失敗しました。${failure}` : failure });
          return;
        }
        setPartStatus(index, "done");
      }
      setSendResult({ ok: true });
    } finally {
      setSending(false);
    }
  }

  const partCount = buildResult?.parts.length ?? 0;
  const doneCount = partStatuses.filter((status) => status === "done").length;
  const allSent = partCount > 0 && doneCount === partCount;
  const nextPart = partStatuses.findIndex((status) => status !== "done") + 1;
  const canBuild = !building && images.length > 0 && title.trim().length > 0;
  const canSend = !sending && buildResult !== null && !allSent;

  const sendLabel = sending
    ? partCount > 1 ? `${Math.max(nextPart, 1)}/${partCount}を送信中…` : "送信中…"
    : partCount > 1 ? (doneCount > 0 ? `${nextPart}/${partCount}から送信を再開する` : `${partCount}通に分けて送信する`) : "この内容で送信する";

  return (
    <>
    {shareNotice && (
      shareNotice.kind === "received" ? (
        <div className="share-received" role="status">
          <span className="share-received-mark" aria-hidden="true">📥</span>
          <div>
            <p>共有から写真を{shareNotice.count}枚受け取りました</p>
            <small>受け取った写真はサーバーの一時領域から消しました</small>
          </div>
        </div>
      ) : (
        <div className="share-received error" role="alert">
          <span className="share-received-mark" aria-hidden="true">!</span>
          <div><p>{shareNotice.message}</p></div>
        </div>
      )
    )}
    <div className="imgmail-card">
      <div className="imgmail-block">
        <div className="imgmail-block-head"><h2>写真タイトル</h2></div>
        <input
          className="imgmail-title-input"
          type="text"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            resetOutcome();
          }}
          placeholder="例）〇〇現場 定例点検"
          maxLength={200}
        />
      </div>

      <div className="imgmail-block">
        <div className="imgmail-block-head"><h2>写真</h2><span>{images.length}枚選択中</span></div>
        <div className="imgmail-add">
          <button type="button" className="cta" onClick={() => captureInputRef.current?.click()}>📷　写真を撮る</button>
          <button type="button" className="cta ghost" onClick={() => pickInputRef.current?.click()}>🖼　写真を追加</button>
        </div>
        <input ref={captureInputRef} type="file" accept="image/*" capture="environment" hidden onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} />
        <input ref={pickInputRef} type="file" accept="image/*" multiple hidden onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} />
        {images.length > 0 && (
          <div className="imgmail-thumbs">
            {images.map((image) => (
              <div key={image.id} className="thumb" style={{ backgroundImage: `url(${image.previewUrl})`, backgroundSize: "cover", backgroundPosition: "center" }}>
                <button type="button" aria-label={`${image.file.name}を削除`} onClick={() => removeImage(image.id)}>×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="imgmail-block">
        <div className="imgmail-block-head"><h2>横幅</h2><span>2MBを超えると自動で下げ、それでも超えたら分割します</span></div>
        <div className="segmented">
          <button type="button" className={widthMode === "auto" ? "active" : ""} onClick={() => { setWidthMode("auto"); resetOutcome(); }}>自動<small>1200→900→600</small></button>
          {WIDTH_PRESETS.map((preset) => (
            <button key={preset} type="button" className={widthMode === preset ? "active" : ""} onClick={() => { setWidthMode(preset); resetOutcome(); }}>{preset}px</button>
          ))}
        </div>
      </div>

      <button type="button" className="cta full big" disabled={!canBuild} onClick={handleBuild}>{building ? "作成中…" : "ZIPを作成する"}</button>

      {buildError && <p className="helper" style={{ color: "#b8541c" }}>{buildError}</p>}

      {buildResult && (
        <div className="result-card">
          <div className="result-grid">
            <div><small>画像数</small><p>{images.length}枚</p></div>
            <div><small>最終横幅</small><p>{buildResult.width}px</p></div>
            <div><small>通数</small><p>{partCount}通</p></div>
          </div>
          {buildResult.autoDowngraded && <div className="result-note">ℹ️　2MBを超えたため、{buildResult.width}pxへ自動で縮小しました。</div>}
          {partCount > 1 && <div className="result-note">ℹ️　合計が2MBを超えるため、{partCount}通に分けました。1通ずつ順に送信します。</div>}
          {partCount > 1 && (
            <div className="parts">
              {buildResult.parts.map((part, index) => (
                <div key={index} className="part">
                  <b>{index + 1}/{partCount}</b>
                  <span>{part.imageCount}枚　{formatBytes(part.zip.byteLength)}</span>
                  <span className={`badge ${partStatuses[index] ?? "waiting"}`}>{PART_STATUS_LABELS[partStatuses[index] ?? "waiting"]}</span>
                </div>
              ))}
            </div>
          )}
          <div className="subject-row"><span className="subject-fixed">[画像]</span><span className="subject-title">{title.trim() || "（タイトル未入力）"}{formatPartSuffix(Math.max(nextPart, 1), partCount)}</span></div>
          <p className="dest-note">宛先・BCCは設定済みの社用アドレス固定です（画面から変更はできません）。</p>
        </div>
      )}

      <button type="button" className="cta full big" disabled={!canSend} onClick={handleSend}>{sendLabel}</button>

      {sendResult && (
        sendResult.ok ? (
          <div className="success-banner">
            <div className="dot">✓</div>
            <div>
              <p>{partCount > 1 ? `${partCount}通すべて送信しました。` : "送信しました。"}Gmailで受信を確認してください。</p>
            </div>
          </div>
        ) : (
          <div className="success-banner" style={{ background: "#fdece0", borderColor: "#f0c39a" }}>
            <div className="dot" style={{ background: "#b8541c" }}>!</div>
            <div><p style={{ color: "#8a3a12" }}>{sendResult.message}</p></div>
          </div>
        )
      )}

      <p className="helper">600pxでも2MBを超える場合は、2MB以下のZIPに分けて複数のメールで送ります。</p>
    </div>
    </>
  );
}
