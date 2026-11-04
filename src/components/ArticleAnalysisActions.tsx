"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import TriageActions from "@/components/TriageActions";
import { isAnalysisInFlight } from "@/lib/analysis-display";
import type { JobStatusValue } from "@/lib/article-analysis";
import type { TriageState } from "@/lib/triage";

type Props = {
  articleId: string;
  status: JobStatusValue | null;
  triage: TriageState;
  /** 記事詳細画面では「詳細を見る」を出さない。 */
  showDetailLink?: boolean;
  /** 採用済みの一覧カードでは再解析・採用／不採用のボタンを出さない（#395）。 */
  hideActions?: boolean;
};

/**
 * カード・記事詳細から解析を要求する操作（#79）と、採用／不採用の仕分け（#94）。
 *
 * 実行するのはVPS上のポーラーなので、押した直後に結果は出ない。押した時点でジョブが
 * 「解析待ち」として残り、画面を開き直すか自動更新で状態が進む。二重実行は
 * `QUEUED`／`RUNNING`の間ボタンを無効にするだけでなく、サーバー側でも`activeKey`のUNIQUE制約で
 * 弾く（同時に押されても1本しか積まれない）。
 *
 * 仕分けのボタンは新着記事画面と同じ`TriageActions`で、「週報候補から外す／戻す」という
 * 以前の文言は「採用／不採用」に揃えた（意味は同じで、`weeklyCandidate`を切り替える）。
 */
export default function ArticleAnalysisActions({ articleId, status, triage, showDetailLink = true, hideActions = false }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const inFlight = isAnalysisInFlight(status);

  async function enqueue() {
    setError(null);
    const response = await fetch("/api/analysis/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ articleId }) });
    if (response.status === 409) {
      setError("この記事の解析はすでに実行中です。");
    } else if (!response.ok) {
      setError("操作できませんでした。しばらくしてからもう一度お試しください。");
    }
    startTransition(() => router.refresh());
  }

  return (
    <span className="ai-actions">
      {!hideActions && (
        <>
          <button className={`btn ${status === null ? "primary" : "quiet"}`} type="button" disabled={inFlight || pending} onClick={() => void enqueue()}>
            {status === null ? "AI解析" : "再解析"}
          </button>
          <TriageActions articleId={articleId} state={triage} showDetailLink={false} />
        </>
      )}
      {showDetailLink && <Link className="btn quiet" href={`/dashboard/articles/${articleId}`}>詳細を見る</Link>}
      {error && <span className="ai-error">{error}</span>}
    </span>
  );
}
