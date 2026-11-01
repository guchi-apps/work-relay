"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { BusinessDef } from "@/lib/business-defs";
import {
  buildNewsMailHtml,
  defaultSubjectBody,
  MAX_NOTE_LENGTH,
  MAX_SUBJECT_BODY_LENGTH,
  SUBJECT_PREFIX,
  toNewsMailArticle,
  type NewsMailArticleDto,
} from "@/lib/news-mail";

type Props = {
  article: NewsMailArticleDto;
  /** 事業区分のマスタ（メール冒頭の事業名に使う）。 */
  businesses: BusinessDef[];
  /** 共有した記事の登録後など、開いた状態で始めたいとき。 */
  defaultOpen?: boolean;
};

type SendResult = { ok: true } | { ok: false; message: string };

/**
 * 記事1件を社用メールに送るボタンと送信シート（#385）。
 *
 * **プレビューは`src/lib/news-mail.ts`の`buildNewsMailHtml()`が返すHTMLをそのまま描いている**——
 * 送信時にサーバーが組み立てるのも同じ関数なので、見えている内容と送る内容が食い違わない。
 * 差し込む値はすべて同関数の中でエスケープしている。PCでは右からのシート、スマホでは下からのシート。
 */
export default function ArticleMailButton({ article, businesses, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <>
      <button type="button" className="btn-mail" onClick={() => setOpen(true)}>
        ✉ メールで送る
      </button>
      {open && <MailSheet article={article} businesses={businesses} onClose={() => setOpen(false)} />}
    </>
  );
}

function MailSheet({ article, businesses, onClose }: { article: NewsMailArticleDto; businesses: BusinessDef[]; onClose: () => void }) {
  const [note, setNote] = useState("");
  const [subjectBody, setSubjectBody] = useState(() => defaultSubjectBody(article));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  // 送信に失敗して押し直したときに二重送信にならないよう、同じ内容の間は同じ鍵を使い回す。
  const idempotencyKeyRef = useRef<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  const previewHtml = useMemo(() => buildNewsMailHtml({ article: toNewsMailArticle(article), subjectBody, note, businesses }), [article, subjectBody, note, businesses]);

  function edited() {
    idempotencyKeyRef.current = null;
    setResult(null);
  }

  async function send() {
    if (!idempotencyKeyRef.current) idempotencyKeyRef.current = crypto.randomUUID();
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch("/api/news-mail/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ articleId: article.id, subjectBody: subjectBody.trim(), note, idempotencyKey: idempotencyKeyRef.current }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setResult({ ok: false, message: body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : "送信に失敗しました" });
        return;
      }
      // 送信できた内容へもう一度同じ鍵で送らないよう、成功したら鍵を捨てる。
      idempotencyKeyRef.current = null;
      setResult({ ok: true });
    } catch {
      setResult({ ok: false, message: "通信に失敗しました。しばらくしてから再試行してください" });
    } finally {
      setBusy(false);
    }
  }

  const canSend = !busy && subjectBody.trim().length > 0 && note.length <= MAX_NOTE_LENGTH && result?.ok !== true;

  return (
    <div className="mail-sheet-root">
      <div className="mail-scrim" onClick={onClose} />
      <div className="mail-sheet" role="dialog" aria-modal="true" aria-label="この記事をメールで送る">
        <div className="mail-sheet-head">
          <h2>この記事をメールで送る</h2>
          <button ref={closeRef} type="button" className="btn" onClick={onClose}>
            ✕ 閉じる
          </button>
        </div>

        <div className="mail-sheet-field">
          <label htmlFor={`mail-note-${article.id}`}>ひとこと（任意）</label>
          <textarea
            id={`mail-note-${article.id}`}
            value={note}
            maxLength={MAX_NOTE_LENGTH}
            rows={3}
            placeholder="例）法人向けの増設提案に使えそう。来週の企画会議で話したいです。"
            onChange={(event) => {
              setNote(event.target.value);
              edited();
            }}
          />
          <span className="hint">
            本文の先頭に添えます。{note.length} / {MAX_NOTE_LENGTH}文字
          </span>
        </div>

        <div className="mail-sheet-field">
          <label htmlFor={`mail-subject-${article.id}`}>件名</label>
          <div className="subject-input-row">
            <span className="subject-fixed">{SUBJECT_PREFIX}</span>
            <input
              id={`mail-subject-${article.id}`}
              type="text"
              value={subjectBody}
              maxLength={MAX_SUBJECT_BODY_LENGTH}
              onChange={(event) => {
                setSubjectBody(event.target.value);
                edited();
              }}
            />
          </div>
        </div>

        <div className="mail-sheet-field">
          <span className="mail-sheet-label">送る内容のプレビュー</span>
          <div className="mail-preview">
            <div className="bar">受信側で見える形（HTMLとテキストの両方を送ります）</div>
            {/* 差し込む値は buildNewsMailHtml() 側でエスケープ済み。ここで組み立てたHTMLは
                そのまま送信本文にもなるため、プレビュー専用の別実装は持たない。 */}
            <div className="mail-frame" dangerouslySetInnerHTML={{ __html: previewHtml }} />
          </div>
        </div>

        <p className="dest-note">宛先・BCCは設定済みの社用アドレス固定です（画面からは変更できません）。同じ内容を続けて押しても二重には送りません。{!article.analyzed && "この記事はAI解析前のため、登録時の要約を載せます。"}</p>

        {result &&
          (result.ok ? (
            <div className="success-banner">
              <div className="dot">✓</div>
              <div>
                <p>送信しました。Gmailで受信を確認してください。</p>
              </div>
            </div>
          ) : (
            <div className="success-banner error">
              <div className="dot">!</div>
              <div>
                <p>{result.message}</p>
              </div>
            </div>
          ))}

        <button type="button" className="cta full big" disabled={!canSend} onClick={() => void send()}>
          {busy ? "送信中…" : result?.ok ? "送信済み" : "この内容で送信する"}
        </button>
      </div>
    </div>
  );
}
