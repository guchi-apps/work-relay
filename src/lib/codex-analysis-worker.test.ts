// ポーラー（scripts/codex-analysis-worker.mjs）を、偽のcodexと偽のサーバーで実際に動かして確かめる（#440）。
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const WORKER = join(import.meta.dirname, "../../scripts/codex-analysis-worker.mjs");

type Report = Record<string, unknown>;

async function runScenario(stdoutOnModelRun: string): Promise<{ reports: Report[]; invocations: string[][] }> {
  const dir = await mkdtemp(join(tmpdir(), "worker-test-"));
  const logPath = join(dir, "calls.jsonl");
  const fake = join(dir, "codex");
  // `-m`付きの起動はモデル拒否を標準出力のJSONLだけへ出して失敗し、`-m`なしは最終応答を書いて成功する。
  await writeFile(
    fake,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-fake 0"); process.exit(0); }
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => {
  if (args.includes("-m")) { process.stdout.write(${JSON.stringify(stdoutOnModelRun)} + "\\n"); process.exit(1); }
  fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ ok: true }));
  process.exit(0);
});
`,
  );
  await chmod(fake, 0o755);

  const reports: Report[] = [];
  let claimed = false;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/internal/analysis/claim") {
        const jobs = claimed ? [] : [{ jobId: "j1", prompt: "p", outputSchema: { type: "object" } }];
        claimed = true;
        res.end(JSON.stringify({ jobs }));
      } else {
        reports.push(JSON.parse(body));
        res.end(JSON.stringify({ status: "ok" }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const child = spawn(process.execPath, [WORKER], {
    env: {
      ...process.env,
      HOME: dir,
      CODEX_HOME: dir,
      CODEX_BIN: fake,
      CODEX_MODEL: "gpt-6-luna",
      RESEARCH_DESK_URL: `http://127.0.0.1:${port}`,
      ANALYSIS_WORKER_SECRET: "s",
      ANALYSIS_POLL_INTERVAL_SECONDS: "1",
    },
    stdio: "ignore",
  });
  try {
    const deadline = Date.now() + 15_000;
    while (reports.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    // 重複報告が無いことを見るため、少し待ってから止める。
    await new Promise((r) => setTimeout(r, 1500));
    const calls = (await readFile(logPath, "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
    return { reports: [...reports], invocations: calls };
  } finally {
    child.kill("SIGTERM");
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("ポーラーのモデル拒否時の再試行（#440）", () => {
  it("error.message・error.codeだけを持つJSONLのerrorイベントでも、-mなしでやり直して報告は1回だけ", async () => {
    const event = JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account.", code: "model_not_found" } });
    const { reports, invocations } = await runScenario(event);
    assert.equal(invocations.length, 2);
    assert.ok(invocations[0].includes("-m"));
    assert.ok(!invocations[1].includes("-m"));
    assert.equal(reports.length, 1);
    assert.equal(reports[0].status, "completed");
  });

  it("文言が違ってもerror.codeがmodel_not_foundなら、-mなしでやり直す", async () => {
    const event = JSON.stringify({ type: "error", error: { message: "unknown", code: "model_not_found" } });
    const { reports, invocations } = await runScenario(event);
    assert.equal(invocations.length, 2);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].status, "completed");
  });

  it("モデル拒否でない失敗は再試行せず、失敗として1回だけ報告する", async () => {
    const event = JSON.stringify({ type: "error", error: { message: "boom", code: "server_error" } });
    const { reports, invocations } = await runScenario(event);
    assert.equal(invocations.length, 1);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].status, "failed");
  });
});
