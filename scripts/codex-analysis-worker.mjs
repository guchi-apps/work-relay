#!/usr/bin/env node
/**
 * 記事AI解析の常駐ポーラー（#79・#86）。**アプリと同じVPS上でPM2が常駐させる**
 * （`deploy/ecosystem.config.js`の`research-desk-analysis-worker`）。
 *
 * Research Deskの `POST /api/internal/analysis/claim` からジョブを取り、ChatGPTアカウントで
 * ログイン済みの Codex CLI（`codex exec`）へ流し、結果を `.../report` へ返すだけの実行役。
 * **解析の観点・出力スキーマ・失敗の分類はすべてResearch Desk側が持つ**ので、プロンプトを
 * 変えてもこのスクリプトを配り直す必要はない。
 *
 * ChatGPTの契約枠を使うため、`OPENAI_API_KEY`は子プロセスの環境から必ず取り除く
 * （残っているとCodexがAPIキー認証へ切り替わり、従量課金で回り続けてしまう）。
 *
 * 設定は環境変数か、リポジトリ直下の`.env`（アプリ本体と同じファイル）から読む。
 * **PM2は`.env`を読まない**ので、共有シークレットをPM2のダンプ（`~/.pm2/dump.pm2`）へ
 * 持ち出さずに済むよう、このスクリプト自身が`.env`を読む。環境変数のほうが優先。
 *
 *   RESEARCH_DESK_URL              既定 http://127.0.0.1:<PORT>（同じホストのアプリを叩く）
 *   ANALYSIS_WORKER_SECRET         Research Desk側の同名の環境変数と同じ値
 *   ANALYSIS_WORKER_HOST           既定はホスト名
 *   ANALYSIS_POLL_INTERVAL_SECONDS 既定 60
 *   ANALYSIS_MAX_JOBS              1回のclaimで取る件数。既定 1
 *   ANALYSIS_JOB_TIMEOUT_SECONDS   1件あたりの実行上限。既定 600
 *   CODEX_BIN                      既定 codex
 *   CODEX_MODEL                    省略可。指定するとcodexへ -m で渡す。ChatGPTアカウントのCodexが
 *                                  そのモデルを受け付けなかったときは、-m を外して既定のモデルで
 *                                  やり直し、以後このプロセスでは -m を付けない（#436）
 *
 * ログには記事本文・原典URL・プロンプト・シークレットを一切出さない（ジョブIDと状態だけ）。
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** このスクリプトから見たリポジトリ（VPSでは配布先ディレクトリ）の直下。 */
const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * アプリ本体と同じ`.env`から設定を読む（すでに環境にある値は上書きしない）。
 *
 * `node --env-file`を使わないのは、VPSのNodeのバージョンに依存させないため。
 * 値の引用符だけを外す簡素な実装で、`export`や複数行の値は扱わない（この用途には要らない）。
 */
function loadEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // 無ければ環境変数だけで動く（開発時・systemd運用時）
  }
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(join(APP_DIR, ".env"));

// 実行役はアプリと同じホストに居る（#86）。既定の接続先をlocalhostにして、解析の要求が
// インターネットとApacheのリバースプロキシを経由しないようにする。
const DEFAULT_BASE_URL = `http://127.0.0.1:${process.env.PORT || 3115}`;
const BASE_URL = (process.env.RESEARCH_DESK_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
const SECRET = process.env.ANALYSIS_WORKER_SECRET ?? "";
const HOST = process.env.ANALYSIS_WORKER_HOST ?? hostname();
const POLL_INTERVAL_MS = Number(process.env.ANALYSIS_POLL_INTERVAL_SECONDS ?? 60) * 1000;
const MAX_JOBS = Number(process.env.ANALYSIS_MAX_JOBS ?? 1);
const JOB_TIMEOUT_MS = Number(process.env.ANALYSIS_JOB_TIMEOUT_SECONDS ?? 600) * 1000;
const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const CODEX_MODEL = process.env.CODEX_MODEL ?? "";

/**
 * `CODEX_MODEL`がChatGPTアカウントのCodexに拒否されたか（#436）。
 *
 * 本番は概算金額の単価表に合わせて`CODEX_MODEL`を送っている（#418）が、VPSのCodex CLIや
 * アカウント側がそのモデルに対応していないと、`-m`を付けた実行が毎回400で落ち、解析も収集も
 * すべて止まる。拒否されたら`-m`を外して既定のモデルでやり直し、以後はこのプロセスの間
 * `-m`を付けない（デプロイ等で再起動すれば、もう一度指定どおりに試す）。
 */
let modelRejected = false;

/** 指定したモデルをChatGPTアカウントのCodexが受け付けなかったことを表す出力。 */
const MODEL_REJECTED_PATTERNS = [/model is not supported when using Codex/i, /"code"\s*:\s*"model_not_found"/i];

function isModelRejected(text) {
  return typeof text === "string" && MODEL_REJECTED_PATTERNS.some((pattern) => pattern.test(text));
}

/** モデル拒否後の再試行に最低限必要な残り時間（ミリ秒）。これを下回るなら再試行せず失敗として報告する。 */
const MIN_RETRY_MS = 5_000;

/** サーバーへ送る標準エラーの末尾の長さ。失敗の分類に足りるぶんだけ。 */
const STDERR_TAIL = 600;

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

/**
 * 足りない設定の一覧。**足りなくてもプロセスは終わらせない**（#86）。
 *
 * PM2が常駐させるため、起動直後に`exit(1)`すると再起動ループになる。共有シークレットが
 * 本番の`.env`へ入るのはデプロイ時なので、入るまでは待つだけにして、入った後の再起動で
 * そのまま動き出せるようにする。
 */
function missingConfig() {
  return SECRET ? [] : ["ANALYSIS_WORKER_SECRET"];
}

/** 設定が足りないときの待ち時間。ログを埋めないよう、通常のポーリングより長く空ける。 */
const IDLE_INTERVAL_MS = Math.max(POLL_INTERVAL_MS, 600_000);

async function api(path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    // 本文にはシークレットも記事本文も含まれないが、長さは切ってログを汚さないようにする。
    throw new Error(`${path} が ${response.status} を返しました: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : {};
}

/**
 * Codexの認証方式を`~/.codex/auth.json`から読む。
 *
 * `codex login status`の文言に頼らず、`auth_mode`をそのまま返す（`chatgpt`以外だと
 * Research Desk側が`auth_required`として扱い、APIキー認証で回り続けるのを止める）。
 */
async function readCodexAuthMode() {
  const codexHome = process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex");
  try {
    const parsed = JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8"));
    if (typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY !== "") return "api_key";
    return typeof parsed.auth_mode === "string" ? parsed.auth_mode : "unknown";
  } catch {
    return "not_logged_in";
  }
}

async function readCodexVersion() {
  return new Promise((resolve) => {
    const child = spawn(CODEX_BIN, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(out.trim() || null));
  });
}

/**
 * このジョブの実行上限（ミリ秒）。サーバーがジョブに`timeoutSeconds`を付けたとき（Web検索で
 * 集める収集ジョブ。記事1件の解析より長くかかる）はそれに従い、無ければ既定値を使う。
 * サーバー側で保持期限（リース）より短い値にしてあるので、ここでは検証しない。
 */
function jobTimeoutMs(job) {
  return Number.isFinite(job.timeoutSeconds) && job.timeoutSeconds > 0 ? job.timeoutSeconds * 1000 : JOB_TIMEOUT_MS;
}

/**
 * `turn.completed`のusageを、保存形式（入力はキャッシュ分を除く。Anthropicの`input_tokens`と同じ意味）へ足し込む。
 * Codexの`input_tokens`はキャッシュ読出を含むため、`cached_input_tokens`を引く。形が違えばnull（記録しない）。
 */
function addUsage(total, raw) {
  const num = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  const input = num(raw?.input_tokens);
  const output = num(raw?.output_tokens);
  if (input === null || output === null) return total;
  const cacheRead = num(raw.cached_input_tokens) ?? 0;
  const cacheWrite = num(raw.cache_write_input_tokens) ?? 0;
  const next = { inputTokens: Math.max(0, input - cacheRead - cacheWrite), outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
  if (!total) return next;
  return Object.fromEntries(Object.keys(next).map((key) => [key, total[key] + next[key]]));
}

/**
 * `error`・`turn.failed`イベントから失敗の文を取り出す。形は2通りある（#440）:
 * `{"type":"error","message":"..."}`と、`{"type":"error","error":{"message":"...","code":"..."}}`
 * （モデル拒否など。`turn.failed`も`error`の下に持つ）。コードは再試行判定
 * （`isModelRejected`）が読めるよう`{"code":"..."}`の形で文末へ足す。
 */
function eventErrorText(event) {
  if (event?.type !== "error" && event?.type !== "turn.failed") return null;
  const nested = event.error && typeof event.error === "object" ? event.error : null;
  const raw = event.type === "error" ? (typeof event.message === "string" && event.message !== "" ? event.message : nested?.message) : nested?.message;
  const message = typeof raw === "string" ? raw : "";
  const code = typeof nested?.code === "string" && nested.code !== "" ? JSON.stringify({ code: nested.code }) : "";
  return [message, code].filter(Boolean).join(" ") || null;
}

/**
 * サーバーへ送る失敗の文。イベントのエラー文があれば先頭を、続けて標準エラーの末尾を並べる。
 * サーバーは末尾`STDERR_TAIL`文字だけを保存するため、合計がその長さに収まるよう両方を切る。
 */
function failureText(eventError, stderr) {
  if (!eventError) return stderr;
  const head = eventError.slice(0, Math.floor(STDERR_TAIL / 2));
  const rest = STDERR_TAIL - head.length - 3;
  return rest > 0 && stderr ? `${head} / ${stderr.slice(-rest)}` : head;
}

/**
 * 1件のジョブをCodexで実行する。
 *
 * `--output-schema`で最終応答の形を縛り、`-o`でその応答だけをファイルへ書かせる
 * （標準出力を解析すると、進捗表示が混ざったときに壊れるため）。
 */
async function runCodex(job, workDir, model, timeoutMs) {
  const schemaPath = join(workDir, "schema.json");
  const outputPath = join(workDir, "result.json");
  await writeFile(schemaPath, JSON.stringify(job.outputSchema), "utf8");

  const args = [
    "exec",
    "--sandbox", "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--color", "never",
    // 標準出力をJSONLにして、`turn.completed`のトークン数だけを読む（最終応答は`-o`のファイルから読む）。
    "--json",
    // 関連情報の追加調査（一次情報の裏取り）にWeb検索を使う。`codex exec`は`--search`を
    // 受け付けないため、設定の上書きで有効にする。
    "-c", "tools.web_search=true",
    "--output-schema", schemaPath,
    "-o", outputPath,
    "-C", workDir,
  ];
  if (model) args.push("-m", model);
  // プロンプトは引数ではなく標準入力から渡す。記事本文がプロセス一覧（ps）に出ないようにするため。
  args.push("-");

  // ChatGPTの契約枠だけを使う。APIキーが環境に残っていてもCodexへ渡さない。
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;

  return new Promise((resolve) => {
    const child = spawn(CODEX_BIN, args, { env, cwd: workDir, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);

    // 標準出力は最終応答と同じ内容を含むため保持しない（ログにも残さない）。
    // 行ごとに見て、`turn.completed`のusageだけを拾う（複数ターンなら合算）。
    let usage = null;
    // 失敗時のエラー文（`error`・`turn.failed`イベント）。標準エラーは末尾しか送らないため、
    // 先頭にある「unexpected status 403」のような肝心の部分が切れる（#432）。こちらは先頭を残す。
    let eventError = null;
    let pending = "";
    const readLine = (line) => {
      if (!line.includes("turn.completed") && !line.includes("error") && !line.includes("turn.failed")) return;
      try {
        const event = JSON.parse(line);
        if (event.type === "turn.completed") usage = addUsage(usage, event.usage);
        const message = eventErrorText(event);
        if (message) eventError = message;
      } catch { /* 進捗行などJSONでない行は無視する */ }
    };
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      lines.forEach(readLine);
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-STDERR_TAIL); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ exitCode: null, stderr: String(error.message).slice(-STDERR_TAIL), timedOut, usage: null }); });
    child.on("close", (code) => { clearTimeout(timer); readLine(pending); resolve({ exitCode: code, stderr: failureText(eventError, stderr), timedOut, outputPath, usage }); });

    child.stdin.end(job.prompt);
  });
}

async function handleJob(job, codexAuthMode) {
  const startedAt = Date.now();
  const workDir = await mkdtemp(join(tmpdir(), "research-desk-analysis-"));
  try {
    let model = modelRejected ? "" : CODEX_MODEL;
    // 上限はジョブ全体で1回だけ数える（#440）。再試行に同じ上限をもう一度与えると、最初の実行の
    // 所要時間ぶんだけサーバー側のリース（15分）を超え、別のポーラーに同じジョブを横取りされる。
    const deadline = startedAt + jobTimeoutMs(job);
    let run = await runCodex(job, workDir, model, deadline - Date.now());
    if (model && run.exitCode !== 0 && !run.timedOut && isModelRejected(run.stderr)) {
      modelRejected = true;
      const remainingMs = deadline - Date.now();
      if (remainingMs >= MIN_RETRY_MS) {
        log(`job ${job.jobId}: モデル ${model} がCodexに拒否されたため、既定のモデルでやり直します（以後このプロセスでは -m を付けません）`);
        model = "";
        run = await runCodex(job, workDir, model, remainingMs);
      } else {
        log(`job ${job.jobId}: モデル ${model} が拒否されましたが、残り時間が足りないためやり直さず失敗として報告します（以後このプロセスでは -m を付けません）`);
      }
    }
    const durationMs = Date.now() - startedAt;

    if (run.exitCode !== 0 || run.timedOut) {
      log(`job ${job.jobId}: 失敗（終了コード ${run.exitCode ?? "なし"}${run.timedOut ? " / 時間切れ" : ""}）`);
      await api("/api/internal/analysis/report", { jobId: job.jobId, host: HOST, status: "failed", exitCode: run.exitCode, stderrTail: run.stderr, timedOut: run.timedOut, codexAuthMode, durationMs });
      return;
    }

    let result;
    try {
      result = JSON.parse(await readFile(run.outputPath, "utf8"));
    } catch (error) {
      log(`job ${job.jobId}: 出力を読み取れませんでした`);
      await api("/api/internal/analysis/report", { jobId: job.jobId, host: HOST, status: "failed", exitCode: 0, stderrTail: `最終応答をJSONとして読めませんでした: ${String(error.message).slice(0, 200)}`, codexAuthMode, durationMs });
      return;
    }

    const reported = await api("/api/internal/analysis/report", { jobId: job.jobId, host: HOST, status: "completed", result, model: model || null, codexAuthMode, durationMs, usage: run.usage });
    log(`job ${job.jobId}: 完了（${reported.status ?? "?"}・${Math.round(durationMs / 1000)}秒）`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function tick(codexVersion) {
  const codexAuthMode = await readCodexAuthMode();
  const { jobs } = await api("/api/internal/analysis/claim", { host: HOST, maxJobs: MAX_JOBS, codexAuthMode, codexVersion });
  if (!Array.isArray(jobs) || jobs.length === 0) return;
  log(`${jobs.length}件のジョブを取得しました（認証方式 ${codexAuthMode}）`);
  for (const job of jobs) {
    await handleJob(job, codexAuthMode);
  }
}

async function main() {
  const codexVersion = await readCodexVersion();
  log(`ポーラーを開始します（host=${HOST} / 接続先=${BASE_URL} / codex=${codexVersion ?? "不明"} / 間隔${POLL_INTERVAL_MS / 1000}秒）`);

  let running = true;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => { running = false; log(`${signal}を受け取りました。現在のジョブを終えてから停止します。`); });
  }

  while (running) {
    const missing = missingConfig();
    if (missing.length > 0) {
      log(`設定が足りないため待機します（${missing.join(", ")}）。値が入ったら再起動してください。`);
    } else {
      try {
        await tick(codexVersion);
      } catch (error) {
        // 1回の失敗で常駐を止めない（Research Deskの再起動・一時的な通信断で落ちないようにする）。
        log(`ポーリングに失敗しました: ${String(error.message).slice(0, 300)}`);
      }
    }
    if (!running) break;
    await new Promise((resolve) => setTimeout(resolve, missing.length > 0 ? IDLE_INTERVAL_MS : POLL_INTERVAL_MS));
  }
  log("停止しました。");
}

main();
