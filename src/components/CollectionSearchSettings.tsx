"use client";

import { useState } from "react";

export type BusinessPolicyProps = {
  business: string;
  label: string;
  policy: string;
  updatedAt: string;
  pendingInstruction: string | null;
  scope: string;
  feedQueries: string[];
};

function BusinessPolicyCard({ business, label, policy, updatedAt, pendingInstruction, scope, feedQueries }: BusinessPolicyProps) {
  const [instruction, setInstruction] = useState("");
  const [notice, setNotice] = useState(pendingInstruction ? "AIへの調整依頼を次回の自動収集で反映します。" : "");
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/collection-search/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ business, instruction }) });
      if (!response.ok) throw new Error();
      setInstruction("");
      setNotice("AIへの調整依頼を保存しました。次回の自動収集で基準を見直します。");
    } catch {
      setNotice("依頼を保存できませんでした。しばらくしてからもう一度お試しください。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-card policy-card">
      <h2>{label}の検索・判定基準</h2>
      <p className="desc">AIが不採用記事とあなたの指示をもとに、次回の収集で使う基準を調整します。</p>
      <div className="policy-current">
        <strong>いまの判定基準</strong>
        <time>最終更新: {new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(updatedAt))}</time>
        <p>{policy}</p>
      </div>
      <label className="policy-label" htmlFor={`policy-instruction-${business}`}>AIへ調整を依頼</label>
      <textarea id={`policy-instruction-${business}`} value={instruction} maxLength={1000} onChange={(event) => setInstruction(event.target.value)} placeholder="不自然な検索結果や、採用／不採用の判断について具体的に指示します。" />
      <p className="policy-help">検索語を直接編集せず、気になる記事の傾向を伝えてください。AIが基準へ整理します。</p>
      {notice && <p className="policy-notice" role="status">{notice}</p>}
      <button className="cta" type="button" disabled={busy || instruction.trim() === ""} onClick={submit}>{busy ? "保存しています…" : "AIに調整を依頼"}</button>
      <div className="policy-keywords">
        <strong>登録されているキーワード（AIの基準とは別に固定・変更不可）</strong>
        <p className="policy-keywords-desc">対象範囲: {scope}</p>
        <ul>
          {feedQueries.map((query) => <li key={query}>{query}</li>)}
        </ul>
      </div>
    </div>
  );
}

export default function CollectionSearchSettings({ businesses }: { businesses: BusinessPolicyProps[] }) {
  return <>{businesses.map((business) => <BusinessPolicyCard key={business.business} {...business} />)}</>;
}
