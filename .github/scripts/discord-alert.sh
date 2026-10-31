#!/usr/bin/env bash
# GitHub Actions の異常だけをDiscordへ送る通知スクリプト（Signaly廃止の代替経路。#5057）
#
# 方針: **失敗・明確な異常だけ送る。** 成功・通常リリース・通常収集・キャンセルは送らない。
# リリース完了のDiscord通知はissue-deck側の別経路が持つため、ここでは重複させない。
#
# Requires: DISCORD_ALERT_WEBHOOK_URL, NOTIFY_STATUS
#   NOTIFY_STATUS … `failure`（ジョブ失敗）か `anomaly`（ワークフローは成功でも異常を表す。
#   ドリフト検知など）だけを送る。それ以外（success・cancelled・skipped・不明）は何もせず0で返す。
# Optional: NOTIFY_APP, NOTIFY_KIND（CI / デプロイ / リリース 等）, NOTIFY_JOB, NOTIFY_VERSION,
#   NOTIFY_DETAIL（anomalyの説明1行）, NOTIFY_RUN_URL（別のrunについて通知するときだけ）
#
# **失敗を隠すためにジョブ結果を改変しない。** 呼び出し側は元のジョブの結果をそのまま
# NOTIFY_STATUSへ渡し、このスクリプトは**どう転んでも終了コード0**で返す（通知先の停止で
# runを赤くしない。#2237と同じ）。呼び出しステップには`continue-on-error: true`を付ける。
#
# **webhook URLは秘密。** このリポジトリのActionsログは誰でも読めるため、curlのstderrは
# 捨て（接続失敗時にホスト名が載る）、HTTPコードとcurlの終了コードだけを出す。
set -euo pipefail

status="${NOTIFY_STATUS:-unknown}"

case "$status" in
  failure|anomaly) ;;
  *)
    echo "NOTIFY_STATUS=${status}: 異常ではないためDiscordへは通知しません"
    exit 0
    ;;
esac

webhook_url="${DISCORD_ALERT_WEBHOOK_URL:-}"
if [[ -z "$webhook_url" ]]; then
  echo "::warning::DISCORD_ALERT_WEBHOOK_URL が未設定のため、異常通知を送れません"
  exit 0
fi

repository="${GITHUB_REPOSITORY:-}"
server_url="${GITHUB_SERVER_URL:-https://github.com}"
export NOTIFY_STATUS="$status"
export REPOSITORY="$repository"
export RUN_URL="${NOTIFY_RUN_URL:-${server_url}/${repository}/actions/runs/${GITHUB_RUN_ID:-}}"

payload=$(python3 - <<'PY'
import json
import os

status = os.environ["NOTIFY_STATUS"]
app = os.environ.get("NOTIFY_APP", "") or os.environ.get("REPOSITORY", "").split("/")[-1]
kind = os.environ.get("NOTIFY_KIND", "")
workflow = os.environ.get("NOTIFY_WORKFLOW") or os.environ.get("GITHUB_WORKFLOW", "GitHub Actions")
job = os.environ.get("NOTIFY_JOB") or os.environ.get("GITHUB_JOB", "")
version = os.environ.get("NOTIFY_VERSION", "")
detail = os.environ.get("NOTIFY_DETAIL", "")
sha = os.environ.get("GITHUB_SHA", "")[:7]
label = "失敗" if status == "failure" else "異常"
emoji = "❌" if status == "failure" else "⚠️"

title = f"{emoji} [{app}] {kind or workflow} {label}"
if version:
    title += f" {version}"

fields = []
def add(name, value, inline=True):
    if value:
        fields.append({"name": name, "value": value, "inline": inline})

add("Repository", f"`{os.environ.get('REPOSITORY', '')}`")
add("Workflow", workflow)
add("Job", job)
add("Branch", os.environ.get("GITHUB_REF_NAME", ""))
add("Commit", f"`{sha}`" if sha else "")
add("Actor", os.environ.get("GITHUB_ACTOR", ""))
add("Detail", detail[:500], inline=False)
add("Run", f"[Workflow Run]({os.environ['RUN_URL']})", inline=False)

print(json.dumps({
    "username": "GitHub Actions",
    "allowed_mentions": {"parse": []},
    "embeds": [{
        "title": title[:250],
        "color": 0xED4245 if status == "failure" else 0xFEE75C,
        "fields": fields,
    }],
}))
PY
)

http_code=""
curl_status=0
http_code="$(curl -fsS -o /dev/null -w '%{http_code}' \
  --max-time 10 --retry 2 --retry-delay 2 \
  -H "Content-Type: application/json" \
  -d "$payload" \
  "$webhook_url" 2>/dev/null)" || curl_status=$?

if [[ "$curl_status" -eq 0 ]]; then
  echo "Discordへ異常を通知しました (HTTP ${http_code})"
  exit 0
fi

echo "::warning::Discordへの異常通知に失敗しました (HTTP ${http_code:-000} / curl exit ${curl_status})。このrunの結果は変えません"
exit 0
