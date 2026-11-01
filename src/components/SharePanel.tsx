"use client";

import type { BusinessDef } from "@/lib/business-defs";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { SHARE_TEXT_QUERY_MAX_LENGTH } from "@/lib/share-inbox";
import { buildTextMailHtml, MAX_SUBJECT_BODY_LENGTH } from "@/lib/text-mail";
import { TRIAGE_LABELS, type TriageState } from "@/lib/triage";

export type ExistingArticleView = {
  id: string;
  title: string;
  sourceName: string;
  collectedAtIso: string;
  analysisStatus: string | null;
  triage: TriageState;
  pickPath: string;
};

type Props = {
  /** 事業区分のマスタ。 */
  businesses: BusinessDef[];
  url: string | null;
  text: string;
  defaultTitle: string;
  /** 共有されたURLがすでに新着記事にある場合、その記事。 */
  existing: ExistingArticleView | null;
};

type Business = string;
type Saved = { outcome: "created" | "duplicate"; article: ExistingArticleView };

const ANALYSIS_LABELS: Record<string, string> = { QUEUED: "解析待ち", RUNNING: "解析中", COMPLETED: "解析済み", FAILED: "解析失敗", AUTH_REQUIRED: "解析停止中" };

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatJstDate(iso: string): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "long", day: "numeric" }).format(new Date(iso));
}

function ArticleStatusChip({ article }: { article: ExistingArticleView }) {
  const label = article.analysisStatus ? ANALYSIS_LABELS[article.analysisStatus] ?? article.analysisStatus : TRIAGE_LABELS[article.triage];
  return <span className="share-chip">{label}</span>;
}

/**
 * 共有された記事・文章の操作（#144・#149）。URLがあれば新着記事への登録、無ければ
 * 文章をそのまま社用メールへ送る（`TextMailBlock`）。どちらも無ければ案内だけ出す。
 */
export default function SharePanel({ businesses, url, text, defaultTitle, existing }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState(defaultTitle);
  const [business, setBusiness] = useState<Business | null>(null);
  const [busy, setBusy] = useState<"add" | "add_send" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved | null>(existing ? { outcome: "duplicate", article: existing } : null);

  if (!url) {
    if (!text) {
      return (
        <div className="share-card">
          <div className="share-note">
            <span className="share-note-mark" aria-hidden="true">i</span>
            <div>
              <p><strong>共有された内容がありません</strong></p>
              <p>記事として追加できるのはURLのある共有だけです。</p>
            </div>
          </div>
          <Link className="cta ghost full big" href="/dashboard/image-mail">写真を添えて「画像を送る」へ</Link>
        </div>
      );
    }
    return (
      <div className="share-card">
        <div className="imgmail-block">
          <div className="imgmail-block-head"><h2>受け取った文章</h2></div>
          <p className="share-text">{text}</p>
        </div>
        <TextMailBlock text={text} defaultSubjectBody={defaultTitle} />
      </div>
    );
  }

  async function submit(then: "add" | "add_send") {
    if (!business || !url) return;
    setBusy(then);
    setError(null);
    try {
      const response = await fetch("/api/articles/shared", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, title: title.trim(), text, business }),
      });
      const body: unknown = await response.json().catch(() => null);
      const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      if (!response.ok) {
        setError(typeof record.message === "string" ? record.message : "追加に失敗しました");
        return;
      }
      const article = record.article as Omit<ExistingArticleView, "collectedAtIso" | "pickPath"> & { collectedAt: string };
      const view: ExistingArticleView = { ...article, collectedAtIso: article.collectedAt, pickPath: String(record.pickPath) };
      if (then === "add_send") {
        router.push(view.pickPath);
        return;
      }
      setSaved({ outcome: record.outcome === "created" ? "created" : "duplicate", article: view });
    } catch {
      setError("通信に失敗しました。しばらくしてから再試行してください");
    } finally {
      setBusy(null);
    }
  }

  const source = (
    <div className="share-source">
      <div className="share-favicon" aria-hidden="true">{hostOf(url).slice(0, 1).toUpperCase()}</div>
      <div>
        <b>{saved ? saved.article.title : hostOf(url)}</b>
        <a href={url} target="_blank" rel="noreferrer">{saved ? hostOf(url) : url}</a>
        {!saved && text ? <p>{text}</p> : null}
      </div>
    </div>
  );

  if (saved) {
    const created = saved.outcome === "created";
    return (
      <div className="share-card">
        {created ? (
          <div className="success-banner">
            <div className="dot">✓</div>
            <div>
              <p>新着記事に追加しました</p>
              <small>AI解析を待っています。終わると「ニュースを送る」に並びます</small>
            </div>
          </div>
        ) : (
          <div className="share-note">
            <span className="share-note-mark" aria-hidden="true">!</span>
            <div>
              <p><strong>この記事はすでに新着記事にあります</strong></p>
              <p>{formatJstDate(saved.article.collectedAtIso)}に登録済みです。重ねて追加はしません。</p>
            </div>
          </div>
        )}
        <div className="imgmail-block">
          <div className="imgmail-block-head"><h2>{created ? "追加した記事" : "登録済みの記事"}</h2><ArticleStatusChip article={saved.article} /></div>
          {source}
        </div>
        <div className="share-actions">
          <Link className="cta full big" href={saved.article.pickPath}>この記事だけ送る</Link>
          <Link className="cta ghost full big" href={`/dashboard/articles/${saved.article.id}`}>記事の詳細を開く</Link>
        </div>
      </div>
    );
  }

  const canSubmit = busy === null && business !== null && title.trim().length > 0;

  return (
    <div className="share-card">
      <div className="imgmail-block">
        <div className="imgmail-block-head"><h2>受け取った記事</h2></div>
        {source}
      </div>
      <div className="imgmail-block">
        <div className="imgmail-block-head"><h2>タイトル</h2><span>新着記事での見出しになります</span></div>
        <input id="share-title" className="imgmail-title-input" type="text" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder="記事のタイトル" />
      </div>
      <div className="imgmail-block">
        <div className="imgmail-block-head"><h2>事業</h2><span>AI解析で見直されることがあります</span></div>
        <div className="segmented" role="radiogroup" aria-label="事業">
          {businesses.map((def) => (
            <button key={def.key} type="button" role="radio" aria-checked={business === def.key} className={business === def.key ? "active" : ""} onClick={() => setBusiness(def.key)}>{def.shortLabel}</button>
          ))}
        </div>
      </div>
      {error && <p className="helper" style={{ color: "#b8541c" }}>{error}</p>}
      <div className="share-actions">
        <button type="button" className="cta full big" disabled={!canSubmit} onClick={() => submit("add")}>{busy === "add" ? "追加中…" : "新着記事に追加する"}</button>
        <button type="button" className="cta ghost full big" disabled={!canSubmit} onClick={() => submit("add_send")}>{busy === "add_send" ? "追加中…" : "追加して、この記事だけ送る"}</button>
      </div>
      {business === null && <p className="helper">事業を選ぶと追加できます。</p>}
    </div>
  );
}

type SendResult = { ok: true } | { ok: false; message: string };

/**
 * URLの無い共有（文章だけ）を社用メールへ送る操作（#149）。件名・本文の組み立ては
 * `src/lib/text-mail.ts`の`buildTextMailHtml()`をそのまま使う——送る内容はDBに保存されて
 * いないため、このブラウザが持つ`text`をそのままサーバーへ渡す（画像メールの`title`と同じ扱い）。
 */
function TextMailBlock({ text, defaultSubjectBody }: { text: string; defaultSubjectBody: string }) {
  // 初期値は文章の1行目（最大200文字）。入力欄のmaxLengthはプログラムで入れた値を切り詰めない
  // ため、ここで件名の上限に収めておく（超えたまま送るとサーバー側の検証で400になる）。
  const [subjectBody, setSubjectBody] = useState(() => defaultSubjectBody.slice(0, MAX_SUBJECT_BODY_LENGTH));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  // 送信に失敗して押し直したときに二重送信にならないよう、同じ内容の間は同じ鍵を使い回す。
  const idempotencyKeyRef = useRef<string | null>(null);

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
    } catch {
      setResult({ ok: false, message: "通信に失敗しました。しばらくしてから再試行してください" });
    } finally {
      setBusy(false);
    }
  }

  const subjectLength = subjectBody.trim().length;
  const canSend = !busy && subjectLength > 0 && subjectLength <= MAX_SUBJECT_BODY_LENGTH;
  // 共有元（他のアプリの共有メニュー・ショートカット）からこの画面へ渡す時点で、文章は
  // SHARE_TEXT_QUERY_MAX_LENGTH文字に切り詰められる（URL長の制約。src/lib/share-inbox.ts）。
  // ぴったりその長さなら切れている可能性があるので、送信前に気づけるよう注記する。
  const mayBeTruncated = text.length >= SHARE_TEXT_QUERY_MAX_LENGTH;

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
              setSubjectBody(event.target.value);
              setResult(null);
              // 内容が変わったら別の送信として扱う（週報メールの resetOutcome() と同じ）。
              idempotencyKeyRef.current = null;
            }}
            placeholder="件名"
          />
        </div>
      </div>
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
