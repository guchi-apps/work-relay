/**
 * 記事カードに出す要約を選ぶ（#405）。
 *
 * 記事自体の`summary`はAI解析で取り込まれた記事では空のことがあり、要約は解析結果
 * （`ArticleAnalysis.summary`）側にだけある。詳細画面は解析結果を表示するため、一覧も
 * 「最新の解析結果の要約 → 記事自体の要約」の順で選び、どちらも空ならnullを返す。
 * DB・Prismaに触れない純粋関数にして、`node --test`から読めるようにしている。
 */
export function pickDisplaySummary(item: { summary: string | null; analyses: { summary: string }[] }): string | null {
  const fromAnalysis = item.analyses[0]?.summary.trim();
  if (fromAnalysis) return fromAnalysis;
  const own = item.summary?.trim();
  return own ? own : null;
}

/**
 * 要約が無いときに出す文言（#466）。解析待ち・実行中は取り込み時に自動で積まれた解析の結果を
 * 待っている状態なので、登録漏れに見えないよう「生成中」と出す。
 */
export function summaryPlaceholder(analysisStatus: string | null | undefined): string {
  return analysisStatus === "QUEUED" || analysisStatus === "RUNNING" ? "要約を生成中です。" : "要約は登録されていません。";
}
