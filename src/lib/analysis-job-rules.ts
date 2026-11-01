/**
 * 記事AI解析（#79）のジョブ判定ルール。
 *
 * DB・Prismaに触れない純粋な関数だけを置き、`node --test`で直接読めるようにしてある
 * （`src/lib/article-analysis.ts`はPrismaを読み込むため、テストから直接importできない）。
 * 「認証切れなのか」「利用枠なのか」「重複ジョブなのか」といった判断はここが唯一の正で、
 * ポーラー（VPS常駐）は判定条件を持たない。
 */

export type JobStatusValue = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "AUTH_REQUIRED";
export type FailureKindValue = "AUTH_REQUIRED" | "RATE_LIMITED" | "INVALID_OUTPUT" | "EXECUTION_FAILED" | "TIMEOUT";

/** 失敗メッセージとして保存する長さの上限。実行ログをそのまま溜め込まないため切る。 */
export const FAILURE_MESSAGE_LIMIT = 600;

/** ポーラーがジョブを保持できる時間（秒）。これを過ぎた`RUNNING`は落ちたとみなして再取得できる。
 * 記事の解析（`src/lib/article-analysis.ts`）と収集ジョブ（`src/lib/collection-search.ts`）が同じ
 * ポーラーに実行されるため、値はここ1か所に置く。 */
export const LEASE_SECONDS = 15 * 60;

/** 1回のclaimで渡せるジョブ数の上限。1件ずつ順に流す前提で小さくしてある。 */
export const MAX_CLAIM_JOBS = 3;

export type FailureSignal = { exitCode: number | null; stderrTail: string | null; codexAuthMode: string | null; timedOut?: boolean };
export type FailureClassification = { status: "FAILED" | "AUTH_REQUIRED"; failureKind: FailureKindValue; message: string };

/** ログイン切れ・未ログインを表すCodexの出力。`codex login`をやり直せば復帰できる。 */
const AUTH_PATTERNS = [/not logged in/i, /please run `?codex login/i, /login required/i, /unauthorized/i, /\b401\b/, /invalid[_ ]api[_ ]key/i, /token (?:has )?expired/i, /refresh token/i];

/** ChatGPTの利用枠に達したことを表す出力。記事は保持し、後から再実行すればよい。 */
const RATE_LIMIT_PATTERNS = [/rate limit/i, /usage limit/i, /quota/i, /too many requests/i, /\b429\b/, /利用.*上限/];

export function truncateFailureMessage(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > FAILURE_MESSAGE_LIMIT ? `${collapsed.slice(0, FAILURE_MESSAGE_LIMIT)}…` : collapsed;
}

/**
 * ポーラーからの失敗報告を、画面に出す状態へ分類する。
 *
 * 認証方式の判定を最優先にしている。ChatGPT以外（APIキー等）で動いていた場合、実行自体は
 * 成功しうるが**従量課金で回り続けてしまう**ため、内容にかかわらず止めて人へ知らせる。
 */
export function classifyFailure(signal: FailureSignal): FailureClassification {
  const tail = signal.stderrTail ?? "";

  if (signal.codexAuthMode && signal.codexAuthMode !== "chatgpt") {
    return { status: "AUTH_REQUIRED", failureKind: "AUTH_REQUIRED", message: `CodexがChatGPTアカウント以外の認証方式（${signal.codexAuthMode}）で動いています。VPSで codex login を実行し、ChatGPTアカウントでログインし直してください。` };
  }
  if (AUTH_PATTERNS.some((pattern) => pattern.test(tail))) {
    return { status: "AUTH_REQUIRED", failureKind: "AUTH_REQUIRED", message: truncateFailureMessage(`CodexがChatGPTアカウントでログインできていません。VPSで codex login status を確認してください。 / ${tail}`) };
  }
  if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(tail))) {
    return { status: "FAILED", failureKind: "RATE_LIMITED", message: truncateFailureMessage(`ChatGPTの利用枠に達したため中断しました。枠が回復してから再実行してください。 / ${tail}`) };
  }
  if (signal.timedOut) {
    return { status: "FAILED", failureKind: "TIMEOUT", message: truncateFailureMessage(`解析が時間内に終わりませんでした。 / ${tail}`) };
  }
  // 画面は`FAILURE_KIND_LABELS`（「Codexの実行に失敗しました」）に続けてこの文を並べるため、
  // ここで同じ文を繰り返さない（#90。同じ一文が二重に出ていた）。
  return { status: "FAILED", failureKind: "EXECUTION_FAILED", message: truncateFailureMessage(`終了コード ${signal.exitCode ?? "不明"}。 / ${tail}`) };
}

/**
 * 同一記事に未完了のジョブが既にあることを表すエラーかどうか。
 *
 * `ArticleAnalysisJob.activeKey`のUNIQUE制約違反（PrismaのP2002）で判定する。アプリ側で
 * 「実行中のジョブがあるか」を先に読んでから作る方式だと、PM2の複数プロセスから同時に押された
 * ときに両方とも「無い」と読んで2本積んでしまう。
 */
export function isDuplicateJobError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/**
 * 結果の報告を受け付けてよいジョブかどうか。
 *
 * `RUNNING`のときだけ受け付ける。リースが切れて`QUEUED`へ戻ったジョブへ遅れて結果が届いた
 * 場合は捨てる（次の実行の結果が正になる）。
 */
export function canAcceptReport(status: JobStatusValue): boolean {
  return status === "RUNNING";
}

/** リース切れ（ポーラーが落ちた・VPSが再起動した）かどうか。 */
export function isLeaseExpired(leaseExpiresAt: Date | null, now: Date): boolean {
  return leaseExpiresAt !== null && leaseExpiresAt.getTime() < now.getTime();
}

/**
 * AIが対象外と判定した記事を、週報候補から自動で外してよいか。
 *
 * 人が一度でも確定している記事（`reviewedAt`が入っている）はその判断を優先し、AIの判定で
 * 書き換えない。
 */
export function shouldAutoExcludeFromWeekly(relevance: string, reviewedAt: Date | null): boolean {
  return relevance === "OUT_OF_SCOPE" && reviewedAt === null;
}
