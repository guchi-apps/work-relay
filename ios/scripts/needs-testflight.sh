#!/usr/bin/env bash
# 前回のTestFlightアップロード成功以降に、iOSバイナリへ影響する変更があるかを判定する（#317）。
# Webだけの変更（src/ など）では再配布しないための判定で、subpc 上のリポジトリで実行する。
#
#   ios/scripts/needs-testflight.sh [対象ref。既定 origin/main]
#
# 終了コード: 0＝配布が要る（初回・iOS変更あり）／1＝不要／2＝判定できない
#
# 「前回成功したSHA」は ${XDG_STATE_HOME:-~/.local/state}/work-relay/testflight-last-sha に持ち、
# remote-upload-testflight.sh が **アップロード成功後にだけ** 書き込む。失敗した配布は記録されないので、
# 次回の判定にその変更が残り続け、漏れない。
# バイナリに入るもの: ios/WorkRelay/ と ios/WorkRelay.xcodeproj と ios/ExportOptions.plist
set -euo pipefail

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/work-relay"
LAST_FILE="$STATE_DIR/testflight-last-sha"
TARGET="${1:-origin/main}"
cd "$(git rev-parse --show-toplevel)"

head_sha="$(git rev-parse --verify "$TARGET^{commit}" 2>/dev/null)" || { echo "対象 $TARGET が見つかりません（git fetch origin してください）。" >&2; exit 2; }

if [ ! -s "$LAST_FILE" ]; then
  echo "配布が要る: 成功の記録がありません（初回）。対象 ${head_sha:0:7}"
  exit 0
fi
last_sha="$(cat "$LAST_FILE")"
git cat-file -e "$last_sha^{commit}" 2>/dev/null || { echo "前回の配布SHA ${last_sha:0:7} がこのリポジトリにありません。" >&2; exit 2; }

changed="$(git diff --name-only "$last_sha" "$head_sha" -- ios/WorkRelay ios/WorkRelay.xcodeproj ios/ExportOptions.plist)"
if [ -n "$changed" ]; then
  echo "配布が要る: 前回 ${last_sha:0:7} 以降にiOSの変更があります。"
  echo "$changed" | sed 's/^/  /'
  exit 0
fi
echo "配布は不要: 前回 ${last_sha:0:7} 以降、iOSバイナリへ影響する変更はありません（Webは本番デプロイで反映済み）。"
exit 1
