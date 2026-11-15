"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import type { TriageDecision } from "@/lib/triage";

type Props = {
  /** 一覧に出ている記事の件数。「すべて選択」の判定に使う。 */
  total: number;
  children: React.ReactNode;
};

/**
 * 新着記事画面で、チェックした記事をまとめて採用／不採用にするバー（#94）。
 *
 * カード側のチェックは`<input type="checkbox" name="ids" value={記事ID}>`のままサーバーで描画し、
 * この`<form>`にバブルしてくる`change`で件数を数え直す。カードそのものはサーバーコンポーネントの
 * ままにしたいので、選択状態をReactのstateで持たず、送信時に`FormData`から読む。
 * バーはPC・iPadでは一覧の上に貼り付き、スマホでは画面下に固定する（`globals.css`）。
 *
 * **採用・不採用は1タップで確定し、それぞれの右の「▾」から根拠（任意・選択した全件に共通）を
 * 書いて送れる**（#451）。`TriageActions`と同じく`reviewNote`へ保存し、収集ジョブの
 * プロンプト自動修正の参考にする。
 */
export default function TriageInbox({ total, children }: Props) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [openFor, setOpenFor] = useState<TriageDecision | null>(null);
  const [reason, setReason] = useState("");

  function selectedIds(): string[] {
    const form = formRef.current;
    if (!form) return [];
    return new FormData(form).getAll("ids").filter((value): value is string => typeof value === "string");
  }

  function recount() {
    setSelected(selectedIds().length);
  }

  function toggleAll(checked: boolean) {
    formRef.current?.querySelectorAll<HTMLInputElement>('input[name="ids"]').forEach((input) => { input.checked = checked; });
    recount();
  }

  async function decide(decision: TriageDecision, note?: string) {
    const articleIds = selectedIds();
    if (articleIds.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/articles/triage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ articleIds, decision, ...(note ? { note } : {}) }) });
      if (response.ok) {
        toggleAll(false);
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

  const disabled = selected === 0 || busy || pending;
  return (
    <form ref={formRef} className="triage-form" onChange={recount} onSubmit={(event) => event.preventDefault()}>
      <div className="bulk-bar" role="toolbar" aria-label="まとめて仕分ける">
        <label>
          <input type="checkbox" checked={total > 0 && selected === total} disabled={total === 0} onChange={(event) => toggleAll(event.target.checked)} />
          <span>すべて選択</span>
        </label>
        <span className={`count ${selected === 0 ? "dim" : ""}`}>{selected === 0 ? "チェックした記事をまとめて仕分けます" : `${selected}件を選択中`}</span>
        <span className="spacer" />
        <span className={`tri-split adopt ${openFor === "adopt" ? "open" : ""}`}>
          <button className="btn adopt" type="button" disabled={disabled} onClick={() => void decide("adopt")}>✓ 採用</button>
          <button className="btn adopt tri-more" type="button" disabled={disabled} aria-expanded={openFor === "adopt"} aria-label="採用の根拠を入力する" onClick={() => toggleOption("adopt")}>{openFor === "adopt" ? "▴" : "▾"}</button>
        </span>
        <span className={`tri-split reject ${openFor === "reject" ? "open" : ""}`}>
          <button className="btn reject" type="button" disabled={disabled} onClick={() => void decide("reject")}>✕ 不採用</button>
          <button className="btn reject tri-more" type="button" disabled={disabled} aria-expanded={openFor === "reject"} aria-label="不採用の根拠を入力する" onClick={() => toggleOption("reject")}>{openFor === "reject" ? "▴" : "▾"}</button>
        </span>
        {openFor && (
          <>
            <input className="bulk-reason-input" type="text" maxLength={500} placeholder={`${openFor === "adopt" ? "採用" : "不採用"}の根拠（任意）`} value={reason} disabled={disabled} onChange={(event) => setReason(event.target.value)} />
            <button className="btn adopt-send" type="button" disabled={disabled} onClick={() => void decide(openFor, reason)}>{openFor === "adopt" ? "採用" : "不採用"}として送信</button>
            <button className="btn quiet" type="button" disabled={disabled} onClick={() => { setOpenFor(null); setReason(""); }}>キャンセル</button>
          </>
        )}
        {error && <span className="ai-error">{error}</span>}
      </div>
      {children}
    </form>
  );
}
