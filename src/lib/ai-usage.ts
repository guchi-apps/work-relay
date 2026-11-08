/**
 * AI使用量API（`GET /api/internal/ai-usage`、#243）の集計ロジック。
 *
 * Prismaをimportしない純粋関数にしてあり、`node --test`で直接テストできる。
 * トークン数は`codex exec --json`の`turn.completed`が返す値（#415）。ChatGPT認証のCodexは
 * 請求が発生しないが、StatusHubが単価表で概算金額（API換算）を出すために記録する。
 * 入力はキャッシュ読出・書込を除いた分（Anthropicの`input_tokens`と同じ意味）で保存する。
 */

const HOUR_MS = 60 * 60 * 1000;
export const LAST_24H_MS = 24 * HOUR_MS;
export const LAST_7D_MS = 7 * 24 * HOUR_MS;

/** `model`が未記録（`CODEX_MODEL`未設定でCodex既定のモデルを使った場合）の行に付ける固定ID。 */
export const UNKNOWN_MODEL = "codex";

export type TokenUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

export type UsageRecord = { model: string | null; at: Date; tokens?: TokenUsage | null };

export type UsagePeriod = { calls: number } & Partial<TokenUsage>;

export type UsageFeature = {
  label: string;
  model: string;
  last24h: UsagePeriod;
  last7d: UsagePeriod;
};

const TOKEN_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;

/** ワーカーが送るusageを検証する。1つでも負でない整数でなければnull（部分的な値は使わない）。 */
export function parseTokenUsage(value: unknown): TokenUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const source = value as Record<string, unknown>;
  const out = {} as TokenUsage;
  for (const key of TOKEN_KEYS) {
    const n = source[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return null;
    out[key] = n;
  }
  return out;
}

/** DBの保存列へ展開する。usageが無ければ全列null。 */
export function tokenColumns(usage: TokenUsage | null | undefined): Record<(typeof TOKEN_KEYS)[number], number | null> {
  return {
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    cacheReadTokens: usage?.cacheReadTokens ?? null,
    cacheWriteTokens: usage?.cacheWriteTokens ?? null,
  };
}

/** DB行のトークン列をUsageRecordへ。4列そろっていなければnull。 */
export function tokensFromColumns(row: { [K in (typeof TOKEN_KEYS)[number]]: number | null }): TokenUsage | null {
  return parseTokenUsage(row);
}

export function normalizeModel(model: string | null): string {
  const trimmed = model?.trim();
  return trimmed ? trimmed : UNKNOWN_MODEL;
}

type Accumulator = { calls: number; sum: TokenUsage; allCounted: boolean };

const newAccumulator = (): Accumulator => ({ calls: 0, sum: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, allCounted: true });

function add(acc: Accumulator, tokens: TokenUsage | null | undefined) {
  acc.calls++;
  if (!tokens) {
    acc.allCounted = false;
    return;
  }
  for (const key of TOKEN_KEYS) acc.sum[key] += tokens[key];
}

/** 全記録がトークン付きのときだけ数値を出す。1件でも欠けると、実際より少ない値を出さないため省く。 */
function toPeriod(acc: Accumulator): UsagePeriod {
  return acc.allCounted && acc.calls > 0 ? { calls: acc.calls, ...acc.sum } : { calls: acc.calls };
}

/** 1機能ぶんの完了記録を、モデル別の呼出回数・トークン数へ集計する。直近7日に1件も無いモデルは出さない。 */
export function summarizeFeature(label: string, records: UsageRecord[], now: Date): UsageFeature[] {
  const since24h = now.getTime() - LAST_24H_MS;
  const since7d = now.getTime() - LAST_7D_MS;
  const byModel = new Map<string, { d1: Accumulator; d7: Accumulator }>();

  for (const record of records) {
    const at = record.at.getTime();
    if (at < since7d || at > now.getTime()) continue;
    const model = normalizeModel(record.model);
    let row = byModel.get(model);
    if (!row) {
      row = { d1: newAccumulator(), d7: newAccumulator() };
      byModel.set(model, row);
    }
    add(row.d7, record.tokens);
    if (at >= since24h) add(row.d1, record.tokens);
  }

  return [...byModel.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([model, row]) => ({ label, model, last24h: toPeriod(row.d1), last7d: toPeriod(row.d7) }));
}
