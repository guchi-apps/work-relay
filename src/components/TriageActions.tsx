"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { TriageDecision, TriageState } from "@/lib/triage";

type Props = {
  articleId: string;
  state: TriageState;
  /** 記事詳細画面では「詳細」を出さない。 */
  showDetailLink?: boolean;
};

/**
 * 記事1件を採用／不採用にするボタン（#94）。
 *
 * 新着記事画面・業界ニュース画面のカードと記事詳細に付く。押した状態は塗りつぶしで示し、
 * 押し直せば戻せる（不採用は削除ではなく隠すだけ）。保存先は`POST /api/articles/triage`で、
 * 新着記事画面・業界ニュース画面・記事詳細画面から1件ずつ呼ぶ。
 *
 * **採用・不採用は1タップで確定する**（#451）。それぞれの右の「▾」を押したときだけ根拠（任意）の
 * 入力欄が開き、「採用として送信」「不採用として送信」で保存する。入力した根拠は`reviewNote`
 * （記事詳細画面の「メモ」欄と共用）に保存され、収集ジョブが次回の検索・判定基準を自動修正する際の
 * 参考にする（`src/lib/collection-search.ts`）。
 */
export default function TriageActions({ articleId, state, showDetailLink = true }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openFor, setOpenFor] = useState<TriageDecision | null>(null);
  const [reason, setReason] = useState("");

  async function decide(decision: TriageDecision, note?: string) {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/articles/triage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ articleIds: [articleId], decision, ...(note ? { note } : {}) }) });
      if (response.ok) {
        setOpenFor(null);
        setReason("");
      } else {
        setError("保存できませんでした。しばらくしてからもう一度お試しください。");
      }
    } catch {
      setError("保存できませんでした。通信状態を確認してください。");
    } finally {
      setBusy(false);
    }
    startTransition(() => router.refresh());
  }

  function toggleOption(decision: TriageDecision) {
    setReason("");
    setOpenFor((current) => (current === decision ? null : decision));
  }

  const disabled = busy || pending;
  const label = openFor === "adopt" ? "採用" : "不採用";

  return (
    <span className="tri-actions">
      <span className={`tri-split adopt ${openFor === "adopt" ? "open" : ""}`}>
        <button className={`btn adopt ${state === "adopted" ? "on" : ""}`} type="button" disabled={disabled} aria-pressed={state === "adopted"} onClick={() => void decide("adopt")}>
          {state === "adopted" ? "✓ 採用済み" : "✓ 採用"}
        </button>
        <button className={`btn adopt tri-more ${state === "adopted" ? "on" : ""}`} type="button" disabled={disabled} aria-expanded={openFor === "adopt"} aria-label="採用の根拠を入力する" onClick={() => toggleOption("adopt")}>{openFor === "adopt" ? "▴" : "▾"}</button>
      </span>
      <span className={`tri-split reject ${openFor === "reject" ? "open" : ""}`}>
        <button className={`btn reject ${state === "rejected" ? "on" : ""}`} type="button" disabled={disabled} aria-pressed={state === "rejected"} onClick={() => void decide("reject")}>
          {state === "rejected" ? "✕ 不採用済み" : "✕ 不採用"}
        </button>
        <button className={`btn reject tri-more ${state === "rejected" ? "on" : ""}`} type="button" disabled={disabled} aria-expanded={openFor === "reject"} aria-label="不採用の根拠を入力する" onClick={() => toggleOption("reject")}>{openFor === "reject" ? "▴" : "▾"}</button>
      </span>
      {showDetailLink && <Link className="btn quiet" href={`/dashboard/articles/${articleId}`}>詳細</Link>}
      {openFor && (
        <span className="tri-reason">
          <textarea className="tri-reason-input" rows={2} maxLength={500} placeholder={`${label}の根拠（任意）`} aria-label={`${label}の根拠`} value={reason} disabled={disabled} onChange={(event) => setReason(event.target.value)} />
          <span className="tri-reason-buttons">
            <button className={`btn ${openFor} on`} type="button" disabled={disabled} onClick={() => void decide(openFor, reason)}>{label}として送信</button>
            <button className="btn quiet" type="button" disabled={disabled} onClick={() => { setOpenFor(null); setReason(""); }}>キャンセル</button>
          </span>
        </span>
      )}
      {error && <span className="ai-error">{error}</span>}
    </span>
  );
}
