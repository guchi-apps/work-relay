import Link from "next/link";
import { formatElapsed, isWorkerStale } from "@/lib/analysis-display";
import type { AnalysisOverview } from "@/lib/article-analysis";

/** 帯のクリック先（#137）。 */
export const ANALYSIS_STATUS_PATH = "/dashboard/analysis";

/**
 * 画面上部に出す解析の実行環境（#79）。
 *
 * 「いまChatGPTアカウント認証で動いているか」「ポーラーが生きているか」「待ちが溜まっていないか」を
 * ひと目で分かるようにする。APIキー認証へ切り替わっていたらここで警告する（Issueの
 * 「APIキー認証に切り替わっていないことを検知または明示できるようにする」に対応）。
 *
 * 帯全体が解析状況画面へのリンクになる（#137）。待ち・実行中は、解析状況画面の一覧と数が合うよう
 * 週の総括も含めて数える。解析状況画面自身に置くときは`linked={false}`。
 */
export default function AnalysisStatusStrip({ overview, now = new Date(), linked = true }: { overview: AnalysisOverview; now?: Date; linked?: boolean }) {
  const worker = overview.worker;
  const stale = isWorkerStale(worker, now);
  const chatgptAuth = worker?.codexAuthMode === "chatgpt";
  const warn = stale || !chatgptAuth || overview.authRequired > 0;

  const body = (
    <>
      <i className={`lamp ${warn ? "warn" : ""}`} />
      <strong>ChatGPT 解析</strong>
      <span className="auth-tag">{worker ? (chatgptAuth ? "ChatGPTアカウント認証" : `認証方式 ${worker.codexAuthMode ?? "不明"}`) : "未接続"}</span>
      <i className="sep" />
      <span>
        {worker ? `${worker.host} · 最終応答 ${formatElapsed(worker.lastSeenAt, now)}` : "解析を実行するポーラーがまだ接続していません"}
        {worker && stale ? "（停止中）" : ""}
      </span>
      <span className="queue">
        待ち <b>{overview.queued}</b> 件　·　実行中 <b>{overview.running}</b> 件
        {overview.authRequired > 0 && <>　·　認証待ち <b>{overview.authRequired}</b> 件</>}
        {overview.failed > 0 && <>　·　失敗 <b>{overview.failed}</b> 件</>}
      </span>
      {linked && <span className="more">詳細を見る ›</span>}
    </>
  );

  return linked ? <Link className="codex-strip linked" href={ANALYSIS_STATUS_PATH}>{body}</Link> : <div className="codex-strip">{body}</div>;
}
