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
 * **「✕ 不採用」は即送信せず、理由（任意）を書ける欄をいったん開く**（#194）。入力した理由は
 * `reviewNote`（記事詳細画面の「メモ」欄と共用）に保存され、収集ジョブが次回の検索・判定基準を
 * 自動修正する際の参考にする（`src/lib/collection-search.ts`）。空のまま送っても従来どおり動く。
 */
export default function TriageActions({ articleId, state, showDetailLink = true }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");

  async function decide(decision: TriageDecision, note?: string) {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/articles/triage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ articleIds: [articleId], decision, ...(note ? { note } : {}) }) });
      if (response.ok) {
        setReasonOpen(false);
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

  const disabled = busy || pending;

  if (reasonOpen) {
    return (
      <span className="tri-actions tri-reason">
        <textarea className="tri-reason-input" rows={2} maxLength={500} placeholder="不採用の理由（任意）" value={reason} disabled={disabled} onChange={(event) => setReason(event.target.value)} />
        <span className="tri-reason-buttons">
          <button className="btn reject on" type="button" disabled={disabled} onClick={() => void decide("reject", reason)}>不採用にする</button>
          <button className="btn quiet" type="button" disabled={disabled} onClick={() => { setReasonOpen(false); setReason(""); }}>キャンセル</button>
        </span>
        {error && <span className="ai-error">{error}</span>}
      </span>
    );
  }

  return (
    <span className="tri-actions">
      <button className={`btn adopt ${state === "adopted" ? "on" : ""}`} type="button" disabled={disabled} aria-pressed={state === "adopted"} onClick={() => void decide("adopt")}>
        {state === "adopted" ? "✓ 採用済み" : "✓ 採用"}
      </button>
      <button className={`btn reject ${state === "rejected" ? "on" : ""}`} type="button" disabled={disabled} aria-pressed={state === "rejected"} onClick={() => setReasonOpen(true)}>
        {state === "rejected" ? "✕ 不採用済み" : "✕ 不採用"}
      </button>
      {showDetailLink && <Link className="btn quiet" href={`/dashboard/articles/${articleId}`}>詳細</Link>}
      {error && <span className="ai-error">{error}</span>}
    </span>
  );
}
