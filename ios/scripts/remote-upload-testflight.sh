#!/usr/bin/env bash
# subpc から Tailscale 越しに Mac へ入って、ワークリレーを TestFlight へアップロードする（#317）。
# subpc に Xcode が無いため、ビルドとアップロードだけ Mac 側で行う。
#
#   ios/scripts/remote-upload-testflight.sh           # iOSの変更があるときだけ配布する
#   IOS_FORCE=1 ios/scripts/remote-upload-testflight.sh   # 変更が無くても配布する
#
# 配布が要るかは needs-testflight.sh が判定する。成功したときだけ、そのSHAと時刻を
# ${XDG_STATE_HOME:-~/.local/state}/work-relay/ に記録する（結果は testflight.log に1行ずつ残る。
# 失敗は記録されないので、次回の判定でその変更がもう一度対象になる）。
#
# 環境変数（すべて任意）:
#   MAC_HOST      SSH先（既定 guchimac-mini）
#   MAC_REPO_DIR  Mac 上のチェックアウト（既定 $HOME/apps/work-relay）。チルダ付きで渡さない
#                 （subpc のシェルが先に展開するため）。'$HOME/x' のようにシングルクォートで渡す
#   IOS_BRANCH / IOS_SKIP_PULL / IOS_BUILD_NUMBER は upload-testflight.sh へそのまま渡す
#
# Mac 側の前提: Xcode・1Password CLI（op）にサインイン済み・ログインキーチェーンが開いている
# （SSH 経由の署名は自動で開かないため、codesign が失敗したら Mac で
#  `security unlock-keychain ~/Library/Keychains/login.keychain-db` を一度実行する）。
set -euo pipefail

HOST="${MAC_HOST:-guchimac-mini}"
REPO_DIR="${MAC_REPO_DIR:-\$HOME/apps/work-relay}"
BRANCH="${IOS_BRANCH:-main}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/work-relay"
mkdir -p "$STATE_DIR"

cd "$(git rev-parse --show-toplevel)"
git fetch origin "$BRANCH" --quiet
target_sha="$(git rev-parse "origin/$BRANCH")"

if [ "${IOS_FORCE:-}" != "1" ]; then
  # 0＝要る／1＝不要／2＝判定不能（判定できないときは配布しない。IOS_FORCE=1 で明示する）
  set +e
  bash ios/scripts/needs-testflight.sh "origin/$BRANCH"
  verdict=$?
  set -e
  [ "$verdict" -eq 0 ] || exit "$((verdict == 1 ? 0 : 2))"
fi

pass=""
for name in IOS_BRANCH IOS_SKIP_PULL IOS_BUILD_NUMBER; do
  if [ -n "${!name:-}" ]; then
    pass+="$name=$(printf '%q' "${!name}") "
  fi
done

log() { printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${target_sha:0:7}" "$1" >> "$STATE_DIR/testflight.log"; }

# 終了コードをパイプで隠さない（| tee 等を付けない）。-t は op のサインイン要求・キーチェーンの入力用
if ssh -t "$HOST" "cd \"$REPO_DIR\" 2>/dev/null || { echo \"$REPO_DIR が Mac に無いため中止します。MAC_REPO_DIR で場所を指定してください。\" >&2; exit 1; }; ${pass}op run --env-file=ios/asc.env.tpl -- bash ios/scripts/upload-testflight.sh"; then
  printf '%s' "$target_sha" > "$STATE_DIR/testflight-last-sha"
  log success
  echo "TestFlightへの配布に成功しました（${target_sha:0:7}）。記録: $STATE_DIR"
else
  log failed
  echo "TestFlightへの配布に失敗しました（${target_sha:0:7}）。成功の記録は更新していないため、次回の判定にこの変更が残ります。" >&2
  exit 1
fi
