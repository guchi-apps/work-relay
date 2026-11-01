"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { BusinessDef } from "@/lib/business-defs";
import type { AnalysisImportanceValue, AnalysisRelevanceValue } from "@/lib/analysis-prompt";

type Props = {
  articleId: string;
  businesses: BusinessDef[];
  /** 現在の実効値（人が確定済みならその値、まだなら登録時の値）。 */
  relevance: AnalysisRelevanceValue;
  importance: AnalysisImportanceValue;
  weeklyCandidate: boolean;
  note: string | null;
};

/**
 * 人が事業区分・重要度・週報候補への採否を確定する欄（#79）。
 *
 * AIの判定は`ArticleAnalysis`にそのまま残り、ここで確定した内容が表示と週報候補に効く。
 * 誤判定（無関係な記事が高重要度で並ぶ等）はここで直す。
 */
export default function AnalysisReviewForm({ articleId, businesses, relevance, importance, weeklyCandidate, note }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ relevance, importance, weeklyCandidate, note: note ?? "" });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    const response = await fetch("/api/analysis/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ articleId, relevance: form.relevance, importance: form.importance, weeklyCandidate: form.weeklyCandidate, note: form.note }),
    });
    if (!response.ok) {
      setError("保存できませんでした。しばらくしてからもう一度お試しください。");
      return;
    }
    setSaved(true);
    startTransition(() => router.refresh());
  }

  return (
    <form className="review-form" onSubmit={submit}>
      <label className="field">
        <span>事業区分</span>
        <select value={form.relevance} onChange={(event) => setForm({ ...form, relevance: event.target.value as AnalysisRelevanceValue })}>
          {businesses.map((def) => (
            <option key={def.key} value={def.key}>
              {def.label}
            </option>
          ))}
          <option value="OUT_OF_SCOPE">対象外</option>
        </select>
      </label>
      <label className="field">
        <span>重要度</span>
        <select value={form.importance} onChange={(event) => setForm({ ...form, importance: event.target.value as AnalysisImportanceValue })}>
          <option value="HIGH">高</option>
          <option value="MEDIUM">中</option>
          <option value="REFERENCE">参考</option>
        </select>
      </label>
      <label className="check">
        {/* 対象外を選ぶと週報候補からは必ず外れるため、チェックは操作できないようにする。 */}
        <input type="checkbox" checked={form.relevance !== "OUT_OF_SCOPE" && form.weeklyCandidate} disabled={form.relevance === "OUT_OF_SCOPE"} onChange={(event) => setForm({ ...form, weeklyCandidate: event.target.checked })} />
        <span>採用する（週報の候補に含める）</span>
      </label>
      <label className="field">
        <span>メモ（任意）</span>
        <textarea rows={3} value={form.note} maxLength={500} placeholder="判断の理由を残せます" onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </label>
      <button className="cta full" type="submit" disabled={pending}>確定して保存</button>
      {saved && <p className="review-saved">確定しました。</p>}
      {error && <p className="ai-error">{error}</p>}
      <p className="review-note">確定してもAIの生成内容は上書きされません。表示と週報の候補には確定した内容が使われます。</p>
    </form>
  );
}
