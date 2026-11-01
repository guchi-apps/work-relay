# ワークリレー iOSアプリ

本番のワークリレー（`https://research-desk.gucchii.com/`）をiPhoneのアプリとして開く、SwiftUI + WKWebView の薄い殻です（#317）。
**画面と機能はすべてWeb版が正本**で、ここには「Web版を開く・Googleログインを認証シートで往復させる・通信できないときに再試行させる」ことしか書いていません。
Web/PWA・ショートカット・AndroidのWeb Share Targetはそのまま残ります。実装の方式は[docs/architecture.md](../docs/architecture.md)の「iOSアプリ」を参照。

| 項目 | 値 |
|---|---|
| 表示名 | workRelay |
| Bundle ID | `com.gucchii.workrelay`（既存アプリ: issuedeck・kurashio・morrow・yoteiflow・AIDEiosと重ならない） |
| 署名 | Automatic（Apple Developer Program のチーム `6AA3WFTR94`。他のiOSアプリと同じ） |
| 対応 | iPhone・縦向き・iOS 18以上 |
| 認証シートの戻り先 | `workrelay://auth-callback`（Supabase・Googleの許可リダイレクトには**登録しない**。サーバーだけが返す） |
| 共有拡張 | `WorkRelayShare`（Bundle ID `com.gucchii.workrelay.ShareExtension`）。共有シートの「workRelay」から写真・URL・文章を渡す（#318） |
| App Group | `group.com.gucchii.workrelay`（アプリと共有拡張が取り込み待ちの内容を受け渡す。トークン・Cookieは置かない） |
| Associated Domains / Push | 使わない（WebのWeb Pushはネイティブ内でそのまま動くとは見なさない） |

## 更新が要る場所

| 変えたもの | Web/PWA | iOSアプリ |
|---|---|---|
| 画面・機能（`src/`） | mainへマージ → 自動デプロイ | 何もしなくてよい（次に開いたとき新しい画面が出る） |
| アプリの殻（`ios/WorkRelay`・`ios/WorkRelay.xcodeproj`・`ios/WorkRelay-Info.plist`） | 影響なし | TestFlightへ新しいビルドを上げる |

**画面にカメラ・マイク・位置情報などを使う機能を足したら、`ios/WorkRelay-Info.plist`へ対応する利用目的
（`NSCameraUsageDescription`等）も足す**（#326）。`src/`だけの変更でもWKWebViewはOSの権限を使うため、
キーが無いとiOSはその操作の瞬間にアプリを強制終了する（PWA・Safariでは起きないので気付きにくい）。
カメラのキーは`ios/scripts/check-consistency.mjs`（`pnpm test`）が照合する。

## 手作業（人の認証・判断が要るもの）

実装とは別に、次は本人が行います（初回だけ）。

- [ ] [App Store Connect](https://appstoreconnect.apple.com/) → マイApp →「+」→ 新規App：iOS・名前「workRelay」・言語 日本語・Bundle ID `com.gucchii.workrelay`・SKU 例 `workrelay`（Bundle IDが一覧に無ければ先に Developer サイトで Identifiers に登録）
- [ ] TestFlight →「内部テスト」にグループを作り、自分を追加。暗号化の質問は「いいえ（標準の暗号化のみ）」
- [ ] Macに`$HOME/apps/work-relay`のチェックアウト・Xcode 27系・1Password CLI（`op`）のサインインがある（別の場所なら`MAC_REPO_DIR`）
- [ ] 本番にマイグレーション（`native_auth_handoffs`）と`NATIVE_AUTH_ENCRYPTION_KEY`が入っている（`main`へのリリース後）
- [ ] 実機で最初のログインが通る（Supabaseの許可リダイレクトURLが`/auth/callback?native=1&…`のクエリ付きを弾く場合は、`https://research-desk.gucchii.com/auth/callback**`のようにワイルドカードを足す）

App Store Connect API キーは**新しく作らず**、kurashioと共用（1Passwordの`apps/AppStoreConnect`の`key-id`・`issuer-id`・`key-p8`。`asc.env.tpl`が`op://`参照だけを持つ）。実値はどこにも書かない。

## ビルド方法（Mac + Xcode）

**subpcにはXcodeが無い**ため、ビルド・実機確認はMacで行います（subpcからのビルド検証は`/home/guchi/apps/issue-deck/scripts/ios-precheck.sh`）。

1. `open ios/WorkRelay.xcodeproj`（Xcode 27系）
2. スキーム`WorkRelay`・実行先を自分のiPhoneにし、Signing & CapabilitiesのTeamを確かめて ⌘R
3. 初回はiPhoneの 設定 → プライバシーとセキュリティ → デベロッパモード をオン

開発サーバーへ向けるときは`WorkRelay/AppConfig.swift`の`baseURL`だけを変えます（LAN IPの`http://`ではSupabase Authのリダイレクトが戻れないため`sslip-io-lan-dev`の手順でホスト名化）。
**戻し忘れてコミットしないこと**（`node ios/scripts/check-consistency.mjs`と`pnpm test`が本番URLかを確かめます）。

## TestFlightへの配布・再配布

Webが`main`へデプロイされた後に、subpcから1コマンドです（Macへ Tailscale 越しにSSHして Archive → アップロード）。

```bash
node ios/scripts/sync-version.mjs          # 版番号を package.json に揃える（差分があればコミットして main へ）
ios/scripts/remote-upload-testflight.sh    # iOSの変更があるときだけ配布する
IOS_FORCE=1 ios/scripts/remote-upload-testflight.sh   # 変更が無くても配布する
```

- **要否の判定**（`needs-testflight.sh`）：前回の成功SHA以降に`ios/WorkRelay`・`ios/WorkRelay.xcodeproj`・`ios/ExportOptions.plist`の差分があるときだけ配布する。Webだけの変更では何もしない
- **結果の可視化と再実行**：成功したときだけ`~/.local/state/work-relay/testflight-last-sha`を更新し、成功/失敗は`testflight.log`に1行ずつ残る。**失敗した変更は記録されないので次回の判定に残る**（そのまま再実行すればよい）
- ビルド番号は日時（`YYYYMMDDHHMM`）でArchive時に上書き（pbxprojは触らない）。版番号（`MARKETING_VERSION`）は`sync-version.mjs`で`package.json`に揃え、配布スクリプトが食い違いを検出して止める
- Mac側の前提：ログインキーチェーンが開いている（codesignが失敗したらMacで`security unlock-keychain ~/Library/Keychains/login.keychain-db`を一度）。**終了コードをパイプで隠さない**（`| tee`を付けない）
- TestFlightのビルドは90日で期限切れ。そのたびに`IOS_FORCE=1`で上げ直す
- 署名鍵・APIキー・IPAはリポジトリにも公開artifactにも含めない

## 実機確認（TestFlightのビルドで）

- [ ] TestFlightからインストールでき、新しいビルドを上げると更新できる
- [ ] 起動してGoogleでログインでき、アプリを終了して開き直してもログインしたまま
- [ ] 許可外のGoogleアカウントは「このGoogleアカウントは利用が許可されていません」と出て入れない
- [ ] ログアウトすると保護された画面（`/dashboard`）に入れずログイン画面に戻る
- [ ] 業界ニュースの閲覧・仕分け、画像・記事・文章のメール送信画面が動く（`alert`/`confirm`含む）
- [ ] 外部リンクはSafariで開く／機内モードで再試行画面が出て、復帰すると自動で読み直す
- [ ] Safari・PWAのログイン、ショートカット（`docs/share-shortcut.md`）が従来どおり動く

## 仕組み（ログインの引き継ぎ）

1. Webの`/login`の「Googleでログイン」（素の`<a href="/auth/signin">`）をアプリが`decidePolicyFor`で捕まえ、WebView内では開かない
2. アプリがPKCEの`verifier`/`challenge`を作り、認証シート（毎回エフェメラル）で`/auth/native/start`を開く
3. Google → Supabase → `/auth/callback?native=1`。許可判定（`decideAccess`）を通ったときだけ一度限り・60秒のコードを`workrelay://auth-callback?code=…`で返す。許可外は`?error=not_allowed`
4. アプリがWebView内から`POST /auth/native/consume`（本文に`code`と`verifier`）を呼び、通常のSupabase SSR Cookieを受け取って`next`を開く

トークンはURL・ログ・Swiftのコードに出ません。`workrelay://`を他アプリが横取りしても、`verifier`が無ければコードを消費できません。
ログイン状態はWKWebViewの既定データストアに残り、再起動しても維持されます。

## 共有拡張（Share Extension、#318）

共有シートの「workRelay」から写真（最大20枚・合計10MB）・記事のURL・文章を渡せます。拡張は確認画面を出して端末へ保存するだけで、
**何も送信しません**。アプリが開くと保存分を取り込み、既存の「画像を送る」「共有された記事／文章」を開きます（送信は本人が押す）。
仕組みは[docs/architecture.md](../docs/architecture.md)の「共有メニュー（Share Extension）からの取り込み」。ショートカット・Safari・
AndroidのWeb Share Targetは従来どおり使えます（[docs/share-shortcut.md](../docs/share-shortcut.md)）。

- コードは`ios/WorkRelayShare/`（拡張）・`ios/Shared/`（アプリと共通）・`ios/WorkRelay/ShareImporter.swift`（アプリ側の取り込み）
- **App ID `com.gucchii.workrelay.ShareExtension`とApp Group `group.com.gucchii.workrelay`**は、自動署名（`-allowProvisioningUpdates`と
  App Store ConnectのAPIキー）で初回のArchive時に登録される想定。登録されずに署名で止まったら、Developerサイトの Identifiers で
  上記のApp IDとApp Groupを作り、両方のApp IDにApp Groups機能を付ける
- 失敗時の動き: ログイン切れは内容を端末に残してログイン後に続きから取り込む／通信失敗はやり直しか破棄／上限超過・24時間超過は破棄して理由を表示

### 実機確認（TestFlightのビルドで）

- [ ] 写真アプリで複数枚（例: 4枚）を選んで共有 →「workRelay」が出て、確認画面に枚数・サイズが出る →「ワークリレーで開く」でアプリが開き、「画像を送る」に写真が入る（メールは送信されない）
- [ ] 21枚以上を選んで共有 → 先頭の20枚だけ渡すと案内される
- [ ] Safariで記事を共有 →「共有された記事」にURLが入る。メモ等の文章だけを共有 →「共有された文章」に入る
- [ ] アプリがアプリスイッチャーから消えている状態、バックグラウンドにある状態の両方で動く
- [ ] ログアウトした状態で共有 → ログイン切れの案内が出て、ログインすると続きから取り込まれる
- [ ] 機内モードで共有 → 「取り込めませんでした」と端末に残っている旨が出て、復帰後に「もう一度取り込む」で取り込める
- [ ] 拡張からアプリが自動で開かない場合でも、手でworkRelayを開くと取り込まれる
- [ ] ショートカット（`docs/share-shortcut.md`）とAndroidの共有メニューが従来どおり動く
