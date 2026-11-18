"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * 新着記事から開いた未解析の記事で、開いた時点で解析ジョブを積む（#467）。
 *
 * サーバーの描画中に積むと`Link`のprefetchでも走ってしまうため、実際に画面が開いた
 * マウント時にクライアントから1回だけ呼ぶ。二重実行はサーバー側の`activeKey`のUNIQUE制約で
 * 1本に絞られる（409は「すでに積まれている」ので無視する）。
 */
export default function AutoAnalyzeOnOpen({ articleId }: { articleId: string }) {
  const router = useRouter();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void fetch("/api/analysis/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ articleId }) })
      .then(() => router.refresh())
      .catch(() => undefined);
  }, [articleId, router]);

  return null;
}
