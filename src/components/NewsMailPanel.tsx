"use client";

import { sortBusinesses, type BusinessDef } from "@/lib/business-defs";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { JobStatusValue } from "@/lib/analysis-job-rules";
import type { WeekBasisParam } from "@/lib/industry-information";
import { formatDate, formatIsoDate } from "@/lib/jst-week";
import {
  buildNewsMailHtml,
  countNewsMailArticles,
  isCollectedOnly,
  MAX_MAIL_ARTICLES,
  MAX_SUBJECT_BODY_LENGTH,
  SUBJECT_PREFIX,
  toNewsMailArticle,
  type NewsMailArticleDto,
  type NewsMailBrief,
} from "@/lib/news-mail";
import { TRIAGE_CLASS, TRIAGE_LABELS, type TriageState } from "@/lib/triage";

export type NewsMailRow = { article: NewsMailArticleDto; triage: TriageState };

export type NewsMailBriefView = {
  status: JobStatusValue;
  headline: string | null;
  overview: string | null;
  topics: NewsMailBrief["topics"];
  failureMessage: string | null;
};

type Props = {
  /** 事業区分のマスタ（並び順・名前・補足・色）。 */
  businesses: BusinessDef[];
  rows: NewsMailRow[];
  weekOffset: number;
  basis: WeekBasisParam;
  /** 週の範囲。サーバーが決めた値をそのまま使う（ブラウザの現在時刻で週境界がずれないため）。 */
  weekStartIso: string;
  weekEndIso: string;
  brief: NewsMailBriefView | null;
  defaultSubjectBody: string;
  /** 記事解析のキューに残っている件数（`QUEUED`＋`RUNNING`）。総括の待ち順の目安に使う。 */
  analysisQueue: number;
  /** `?pick=`で指定された記事（#144）。あればその記事だけにチェックを入れて始める。 */
  pickedArticleId?: string | null;
};

type SendResult = { ok: true; articleCount: number; hasBrief: boolean } | { ok: false; message: string };

const IMPORTANCE_LABELS = { HIGH: "高", MEDIUM: "中", REFERENCE: "参考" } as const;

/** 総括を待っている間の再読み込み間隔。解析は数分かかるので短くしても意味がない。 */
const BRIEF_POLL_MS = 30_000;

/**
 * 週報メール画面（#110）の本体。
 *
 * 送る記事の選択・AIへの依頼・件名・プレビュー・送信をまとめて持つ。**プレビューは
 * `src/lib/news-mail.ts`の`buildNewsMailHtml()`が返すHTMLをそのまま描いている**——送信時に
 * サーバーが組み立てるのも同じ関数なので、見えている内容と送る内容が食い違わない。
 * 差し込む値はすべて同関数の中でエスケープしている。
 *
 * 一覧はチェックの状態でプレビューが変わるため、`TriageInbox`（#94）と違って選択状態を
 * Reactのstateで持つ。1週ぶんの記事は多くても数十件なので、この規模で問題にならない。
 */
export default function NewsMailPanel({ businesses, rows, weekOffset, basis, weekStartIso, weekEndIso, brief, defaultSubjectBody, analysisQueue, pickedArticleId = null }: Props) {
  const router = useRouter();
  const range = useMemo(() => ({ start: new Date(weekStartIso), end: new Date(weekEndIso) }), [weekStartIso, weekEndIso]);
  const adoptedIds = useMemo(() => rows.filter((row) => row.triage === "adopted").map((row) => row.article.id), [rows]);

  // 既定は「採用」にした記事だけにチェックを入れる。未判定・AIが対象外と判定した記事も
  // 一覧には出すが、チェックは外した状態から始める。
  const [selected, setSelected] = useState<Set<string>>(() => new Set(pickedArticleId ? [pickedArticleId] : adoptedIds));
  const [subjectBody, setSubjectBody] = useState(defaultSubjectBody);
  const [busy, setBusy] = useState<"analyze" | "brief" | "send" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<SendResult | null>(null);
  const [pending, startTransition] = useTransition();
  // 送信に失敗して押し直したときに二重送信にならないよう、同じ内容の間は同じ鍵を使い回す。
  const idempotencyKeyRef = useRef<string | null>(null);

  const briefRunning = brief !== null && (brief.status === "QUEUED" || brief.status === "RUNNING");

  // 総括はVPS上のCodexが1件ずつ順に作る（記事の解析と同じキューをFIFOで共有し、先に積んだ
  // 記事の解析が終わってから走る）。待っている間だけ画面を定期的に取り直す。
  useEffect(() => {
    if (!briefRunning) return;
    const timer = setInterval(() => startTransition(() => router.refresh()), BRIEF_POLL_MS);
    return () => clearInterval(timer);
  }, [briefRunning, router]);

  const resetOutcome = useCallback(() => {
    idempotencyKeyRef.current = null;
    setSendResult(null);
  }, []);

  function toggle(articleId: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(articleId);
      else next.delete(articleId);
      return next;
    });
    resetOutcome();
  }

  function selectAll(checked: boolean) {
    setSelected(checked ? new Set(rows.map((row) => row.article.id)) : new Set());
    resetOutcome();
  }

  function resetToAdopted() {
    setSelected(new Set(adoptedIds));
    resetOutcome();
  }

  const selectedArticles = useMemo(() => rows.filter((row) => selected.has(row.article.id)).map((row) => toNewsMailArticle(row.article)), [rows, selected]);
  const counts = useMemo(() => countNewsMailArticles(selectedArticles, range, businesses), [selectedArticles, range, businesses]);

  const briefForMail: NewsMailBrief | null = brief && brief.status === "COMPLETED" && brief.headline && brief.overview ? { headline: brief.headline, overview: brief.overview, topics: brief.topics } : null;

  const previewHtml = useMemo(
    () => buildNewsMailHtml({ range, subjectBody, articles: selectedArticles, brief: briefForMail, businesses }),
    // briefForMailは毎レンダーで作り直されるオブジェクトなので、中身が変わったときだけ作り直す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range, subjectBody, selectedArticles, businesses, brief?.status, brief?.headline, brief?.overview, brief?.topics],
  );

  const unanalyzedIds = useMemo(() => rows.filter((row) => selected.has(row.article.id) && !row.article.analyzed).map((row) => row.article.id), [rows, selected]);

  async function enqueueAnalysis() {
    if (unanalyzedIds.length === 0) return;
    setBusy("analyze");
    setNotice(null);
    try {
      const response = await fetch("/api/analysis/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ articleIds: unanalyzedIds }) });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setNotice("解析を積めませんでした。しばらくしてからもう一度お試しください。");
        return;
      }
      const queued = body && typeof body === "object" && "queued" in body && typeof body.queued === "number" ? body.queued : unanalyzedIds.length;
      setNotice(`${queued}件の解析を積みました。終わり次第この画面に反映されます。`);
    } catch {
      setNotice("解析を積めませんでした。通信状態を確認してください。");
    } finally {
      setBusy(null);
      startTransition(() => router.refresh());
    }
  }

  async function requestBrief() {
    if (selected.size === 0) return;
    setBusy("brief");
    setNotice(null);
    try {
      const response = await fetch("/api/weekly-brief/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ weekOffset, basis, articleIds: [...selected] }),
      });
      if (response.status === 409) setNotice("この週の総括はすでに生成中です。終わるまでお待ちください。");
      else if (!response.ok) setNotice("総括を依頼できませんでした。しばらくしてからもう一度お試しください。");
      else setNotice(analysisQueue > 0 ? `総括の作成を依頼しました。先に走る記事の解析が${analysisQueue}件あるため、そのぶん待ちます。` : "総括の作成を依頼しました。数分かかります。");
    } catch {
      setNotice("総括を依頼できませんでした。通信状態を確認してください。");
    } finally {
      setBusy(null);
      startTransition(() => router.refresh());
    }
  }

  async function send() {
    if (selected.size === 0) return;
    if (!idempotencyKeyRef.current) idempotencyKeyRef.current = crypto.randomUUID();
    setBusy("send");
    setSendResult(null);
    try {
      const response = await fetch("/api/news-mail/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ articleIds: [...selected], subjectBody: subjectBody.trim(), weekOffset, basis, idempotencyKey: idempotencyKeyRef.current }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : "送信に失敗しました";
        setSendResult({ ok: false, message });
        return;
      }
      // 送信できた内容へもう一度同じ鍵で送らないよう、成功したら鍵を捨てる。
      idempotencyKeyRef.current = null;
      setSendResult({ ok: true, articleCount: selected.size, hasBrief: briefForMail !== null });
    } catch {
      setSendResult({ ok: false, message: "通信に失敗しました。しばらくしてから再試行してください" });
    } finally {
      setBusy(null);
    }
  }

  const working = busy !== null || pending;
  const canSend = selected.size > 0 && subjectBody.trim().length > 0 && selected.size <= MAX_MAIL_ARTICLES && !working;

  return (
    <>
      <div className="ai-strip">
        <span className="who">AI</span>
        <span className="stat">
          記事の解析　<b>{counts.total - counts.unanalyzed}件 / {counts.total}件</b> 済み
        </span>
        <button type="button" disabled={unanalyzedIds.length === 0 || working} onClick={() => void enqueueAnalysis()}>
          {busy === "analyze" ? "積んでいます…" : `未解析の${unanalyzedIds.length}件を解析する`}
        </button>
        <span className="sep" />
        <span className="stat">週の総括</span>
        {briefRunning ? (
          <span className="running">
            <i />
            {analysisQueue > 0 ? `順番待ち（先に記事の解析が${analysisQueue}件）` : "生成中"}
          </span>
        ) : brief?.status === "COMPLETED" ? (
          <span className="stat done">作成済み</span>
        ) : brief ? (
          <span className="stat warn">{brief.failureMessage ?? "作成できませんでした"}</span>
        ) : (
          <span className="stat">未作成</span>
        )}
        <button type="button" className="primary" disabled={selected.size === 0 || briefRunning || working} onClick={() => void requestBrief()}>
          {brief ? "作り直す" : "総括を作る"}
        </button>
        <span className="spacer" />
        <span className="stat muted">記事の解析が終わってから総括が走ります。総括が無くても送信できます</span>
      </div>
      {notice && <p className="mail-notice">{notice}</p>}

      <div className="bulk-bar" role="toolbar" aria-label="送る記事を選ぶ">
        <label>
          <input type="checkbox" checked={rows.length > 0 && selected.size === rows.length} disabled={rows.length === 0} onChange={(event) => selectAll(event.target.checked)} />
          <span>すべて選択</span>
        </label>
        <span className="count">
          {selected.size}件を選択中 / {rows.length}件
        </span>
        <span className="spacer" />
        <button type="button" className="btn" onClick={resetToAdopted}>
          採用した記事だけに戻す
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="no-results">この週に送れる記事がありません。週や「対象の取り方」を変えてお試しください。</div>
      ) : (
        sortBusinesses(businesses).map((def) => {
          const business = def.key;
          const items = rows.filter((row) => row.article.business === business);
          if (items.length === 0) return null;
          const picked = items.filter((row) => selected.has(row.article.id)).length;
          return (
            <section className="news-section" key={business}>
              <div className="section-heading section-line">
                <div className="section-title">
                  <i className={def.color === "teal" ? "" : def.color} />
                  <h2>{def.label}</h2>
                  <span>
                    {items.length}件中 {picked}件を選択
                  </span>
                </div>
                <p>{def.hint}</p>
              </div>
              <div className="news-list">
                {items.map((row) => (
                  <MailCard key={row.article.id} row={row} range={range} checked={selected.has(row.article.id)} onToggle={toggle} />
                ))}
              </div>
            </section>
          );
        })
      )}

      <div className="newsmail-card">
        <div className="newsmail-block">
          <div className="newsmail-block-head">
            <h2>件名</h2>
            <span>先頭の {SUBJECT_PREFIX} は固定です</span>
          </div>
          <div className="subject-input-row">
            <span className="subject-fixed">{SUBJECT_PREFIX}</span>
            <input
              type="text"
              value={subjectBody}
              maxLength={MAX_SUBJECT_BODY_LENGTH}
              onChange={(event) => {
                setSubjectBody(event.target.value);
                resetOutcome();
              }}
              placeholder="例）8月30日 — 9月5日 の業界ニュース"
            />
          </div>
        </div>

        <div className="newsmail-block">
          <div className="newsmail-block-head">
            <h2>送る内容のプレビュー</h2>
            <span>選択中の{selected.size}件・HTMLとテキストの両方を送ります</span>
          </div>
          <div className="mail-preview">
            <div className="bar">受信側で見える形</div>
            {/* 差し込む値は buildNewsMailHtml() 側でエスケープ済み。ここで組み立てたHTMLは
                そのまま送信本文にもなるため、プレビュー専用の別実装は持たない。 */}
            <div className="mail-frame" dangerouslySetInnerHTML={{ __html: previewHtml }} />
          </div>
        </div>

        <p className="dest-note">宛先・BCCは設定済みの社用アドレス固定です（画面からは変更できません）。同じ内容を続けて押しても二重には送りません。</p>
        <button type="button" className="cta full big" disabled={!canSend} onClick={() => void send()}>
          {busy === "send" ? "送信中…" : "この内容で送信する"}
        </button>

        {sendResult &&
          (sendResult.ok ? (
            <div className="success-banner">
              <div className="dot">✓</div>
              <div>
                <p>送信しました。Gmailで受信を確認してください。</p>
                <small>
                  {sendResult.articleCount}件{sendResult.hasBrief ? "・AIの総括あり" : "・総括なし"}
                </small>
              </div>
            </div>
          ) : (
            <div className="success-banner error">
              <div className="dot">!</div>
              <div>
                <p>{sendResult.message}</p>
              </div>
            </div>
          ))}
      </div>
    </>
  );
}

function MailCard({ row, range, checked, onToggle }: { row: NewsMailRow; range: { start: Date; end: Date }; checked: boolean; onToggle: (articleId: string, checked: boolean) => void }) {
  const article = toNewsMailArticle(row.article);
  const published = article.publishedAt ?? article.occurredAt;
  const collectedOnly = isCollectedOnly(article, range);
  return (
    <article className={`news-card triage ${checked ? "" : "unpicked"}`}>
      <label className="pick">
        <input type="checkbox" checked={checked} aria-label={`「${article.title}」を送る`} onChange={(event) => onToggle(article.id, event.target.checked)} />
      </label>
      <div className="card-body">
        <div className="news-head">
          <div>
            <h3>{article.title}</h3>
            <p className="meta">
              {published ? formatDate(published) : "公開日不明"}　·　{article.sourceName}　·　{article.isPrimarySource ? "一次情報" : "関連記事"}
            </p>
          </div>
          <span className={`badge ${article.importance === "HIGH" ? "high" : ""}`}>重要度 {IMPORTANCE_LABELS[article.importance]}</span>
        </div>
        <p className="summary">{article.summary ?? "要約は登録されていません。"}</p>
        {article.implications && <p className="mail-implication">企画への示唆: {article.implications}</p>}
        <div className="mail-chips">
          <span className={`chip ${TRIAGE_CLASS[row.triage]}`}>{TRIAGE_LABELS[row.triage]}</span>
          {collectedOnly ? <span className="chip collected">取得のみ {formatIsoDate(article.collectedAt)}</span> : <span className="chip plain">取得 {formatIsoDate(article.collectedAt)}</span>}
          {!article.analyzed && <span className="chip noai">AI解析なし</span>}
          <a href={article.originalUrl} target="_blank" rel="noreferrer">
            元記事 ↗
          </a>
        </div>
      </div>
    </article>
  );
}
