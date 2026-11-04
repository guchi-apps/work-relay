"use client";

import { useRef, useState } from "react";
import { SHARE_TEXT_QUERY_MAX_LENGTH } from "@/lib/share-inbox";
import { buildTextMailHtml, MAX_SUBJECT_BODY_LENGTH, MAX_TEXT_LENGTH } from "@/lib/text-mail";

type SendResult = { ok: true } | { ok: false; message: string };

type Props = {
  /** 送る文章。`editable`のときは入力欄の初期値。 */
  text: string;
  /** 件名の初期値（編集可能部分）。`editable`で未編集のときは本文の1行目を使う。 */
  defaultSubjectBody?: string;
  /** trueなら本文を画面で書ける（メモ画面。#393）。falseなら受け取った文章をそのまま送る（共有画面。#149）。 */
  editable?: boolean;
};

function firstLine(text: string): string {
  return (text.split(/\r?\n/).find((line) => line.trim() !== "") ?? "").trim();
}

/**
 * 文章を社用メールへ送る操作（#149で`SharePanel`内に作り、#393でメモ画面と共用するため切り出した）。
 * 件名・本文の組み立ては`src/lib/text-mail.ts`の`buildTextMailHtml()`をそのまま使う——送る内容は
 * DBに保存されていないため、このブラウザが持つ本文をそのままサーバーへ渡す。
 */
export default function TextMailBlock({ text: initialText, defaultSubjectBody = "", editable = false }: Props) {
  const [text, setText] = useState(initialText);
  // 件名を手で触るまでは、編集可能なときは本文の1行目に追従させる。
  const [subjectEdit, setSubjectEdit] = useState<string | null>(editable ? null : defaultSubjectBody.slice(0, MAX_SUBJECT_BODY_LENGTH));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  // 送信に失敗して押し直したときに二重送信にならないよう、同じ内容の間は同じ鍵を使い回す。
  const idempotencyKeyRef = useRef<string | null>(null);

  // 初期値は上限に収めておく（入力欄のmaxLengthはプログラムで入れた値を切り詰めない）。
  const subjectBody = subjectEdit ?? firstLine(text).slice(0, MAX_SUBJECT_BODY_LENGTH);

  function resetOutcome() {
    setResult(null);
    // 内容が変わったら別の送信として扱う（週報メールの resetOutcome() と同じ）。
    idempotencyKeyRef.current = null;
  }

  async function send() {
    if (!idempotencyKeyRef.current) idempotencyKeyRef.current = crypto.randomUUID();
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch("/api/text-mail/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, subjectBody: subjectBody.trim(), idempotencyKey: idempotencyKeyRef.current }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : "送信に失敗しました";
        setResult({ ok: false, message });
        return;
      }
      idempotencyKeyRef.current = null;
      setResult({ ok: true });
      if (editable) {
        // 続けて次のメモを書けるよう空に戻す。
        setText("");
        setSubjectEdit(null);
      }
    } catch {
      setResult({ ok: false, message: "通信に失敗しました。しばらくしてから再試行してください" });
    } finally {
      setBusy(false);
    }
  }

  const subjectLength = subjectBody.trim().length;
  const trimmedText = text.trim();
  const canSend = !busy && trimmedText.length > 0 && text.length <= MAX_TEXT_LENGTH && subjectLength > 0 && subjectLength <= MAX_SUBJECT_BODY_LENGTH;
  // 共有元から画面へ渡す時点で文章はSHARE_TEXT_QUERY_MAX_LENGTH文字に切り詰められる
  // （URL長の制約。src/lib/share-inbox.ts）。ぴったりその長さなら切れている可能性がある。
  const mayBeTruncated = !editable && text.length >= SHARE_TEXT_QUERY_MAX_LENGTH;

  return (
    <>
      {mayBeTruncated && (
        <div className="share-note">
          <span className="share-note-mark" aria-hidden="true">i</span>
          <div>
            <p>共有元の制約で、長い文章は{SHARE_TEXT_QUERY_MAX_LENGTH}文字までしかこの画面に届きません。元の文章より短くなっている場合があります。</p>
          </div>
        </div>
      )}
      {editable && (
        <div className="imgmail-block">
          <div className="newsmail-block-head">
            <h2>メモ</h2>
            <span>最大{MAX_TEXT_LENGTH}文字</span>
          </div>
          <textarea
            className="memo-textarea"
            value={text}
            maxLength={MAX_TEXT_LENGTH}
            rows={7}
            onChange={(event) => {
              setText(event.target.value);
              resetOutcome();
            }}
            placeholder="思いついたことを書く"
            aria-label="メモ"
          />
          <p className="memo-count">{text.length} / {MAX_TEXT_LENGTH}</p>
        </div>
      )}
      <div className="imgmail-block">
        <div className="newsmail-block-head">
          <h2>件名</h2>
          <span>先頭の [メモ] は固定です</span>
        </div>
        <div className="subject-input-row">
          <span className="subject-fixed">[メモ]</span>
          <input
            type="text"
            value={subjectBody}
            maxLength={MAX_SUBJECT_BODY_LENGTH}
            onChange={(event) => {
              setSubjectEdit(event.target.value);
              resetOutcome();
            }}
            placeholder="件名"
          />
        </div>
      </div>
      {trimmedText && (
        <div className="imgmail-block">
          <div className="newsmail-block-head">
            <h2>送る内容のプレビュー</h2>
            <span>この文章をそのまま送ります</span>
          </div>
          <div className="mail-preview">
            <div className="bar">受信側で見える形</div>
            {/* buildTextMailHtml()はサーバーの送信時にも使う関数。プレビューと送信本文を
                別実装にしないため、ここでもそのまま差し込む。値はエスケープ済み。 */}
            <div className="mail-frame" dangerouslySetInnerHTML={{ __html: buildTextMailHtml(text) }} />
          </div>
        </div>
      )}
      <p className="dest-note">宛先・BCCは設定済みの社用アドレス固定です（画面からは変更できません）。同じ内容を続けて押しても二重には送りません。</p>
      <button type="button" className="cta full big" disabled={!canSend} onClick={() => void send()}>
        {busy ? "送信中…" : "この内容で送信する"}
      </button>
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
    </>
  );
}
