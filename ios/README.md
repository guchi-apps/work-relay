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
| Associated Domains / Push / App Group / 共有拡張 | 使わない（共有拡張は後続Issue。WebのWeb Pushはネイティブ内でそのまま動くとは見なさない） |

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
- [ ] GitHubのsecret`ASC_KEY_ID`・`ASC_ISSUER_ID`・`ASC_KEY_P8`が入っている（`scripts/sync-github-secrets.sh --only ASC_KEY_ID,ASC_ISSUER_ID,ASC_KEY_P8`。下の「TestFlightへの配布」）
- [ ] 本番にマイグレーション（`native_auth_handoffs`）と`NATIVE_AUTH_ENCRYPTION_KEY`が入っている（`main`へのリリース後）
- [ ] 実機で最初のログインが通る（Supabaseの許可リダイレクトURLが`/auth/callback?native=1&…`のクエリ付きを弾く場合は、`https://research-desk.gucchii.com/auth/callback**`のようにワイルドカードを足す）

App Store Connect API キーは**新しく作らず**、他のiOSアプリと共用（1Passwordの`apps/AppStoreConnect`の`key-id`・`issuer-id`・`key-p8`）。`.github/secrets-manifest.tsv`の対応表どおりGitHubのsecretへ同期して使う。実値はどこにも書かない。

## ビルド方法（Mac + Xcode）

**subpcにはXcodeが無い**ため、ビルド・実機確認はMacで行います（subpcからのビルド検証は`/home/guchi/apps/issue-deck/scripts/ios-precheck.sh`）。

1. `open ios/WorkRelay.xcodeproj`（Xcode 27系）
2. スキーム`WorkRelay`・実行先を自分のiPhoneにし、Signing & CapabilitiesのTeamを確かめて ⌘R
3. 初回はiPhoneの 設定 → プライバシーとセキュリティ → デベロッパモード をオン

開発サーバーへ向けるときは`WorkRelay/AppConfig.swift`の`baseURL`だけを変えます（LAN IPの`http://`ではSupabase Authのリダイレクトが戻れないため`sslip-io-lan-dev`の手順でホスト名化）。
**戻し忘れてコミットしないこと**（`node ios/scripts/check-consistency.mjs`と`pnpm test`が本番URLかを確かめます）。

## TestFlightへの配布・再配布

**GitHub Actions（macOSランナー）が自動で配る**（#336。IssueDeck等の他アプリと同じ流れ）。以前のsubpcからMacへSSHする
手動方式（#317）は、SSH経由だとログインキーチェーンが閉じていて署名が`errSecInternalComponent`で失敗するため廃止した。

`deploy.yml`（Deploy to Production）が`main`で成功 → `ios-testflight-trigger.yml` → `ios-testflight.yml`

1. **判定**（`ios/scripts/ios-changes.mjs`）：最後に配布し終えたコミットのタグ`ios-testflight/<ビルド番号>`以降に、
   `ios/WorkRelay`・`ios/WorkRelay.xcodeproj`・`ios/WorkRelay-Info.plist`・`ios/scripts/ExportOptions.plist`の実質的な差分があるときだけ配る
   （Markdownと、pbxprojの版番号の行だけの差分は数えない）。Webだけの変更ではスキップする。タグが無ければ初回として配る
2. **署名・アーカイブ・アップロード**（`xcode-27`ランナー）：APIキーによるクラウド署名（`-allowProvisioningUpdates`）。キーチェーンは使わない
3. **ビルド処理待ち → 内部テストグループへ配布 → タグ`ios-testflight/<ビルド番号>`を打つ**（`ios/scripts/asc-api.mjs`）

- ビルド番号は`run_number*100+run_attempt`。版番号は`package.json`の`version`をアーカイブ時に`MARKETING_VERSION`へ注入する
  （pbxprojの値はリリースのバンプに追従しなくてよい）
- 認証情報はGitHubのsecret`ASC_KEY_ID`・`ASC_ISSUER_ID`・`ASC_KEY_P8`。値を変えたときだけ
  `scripts/sync-github-secrets.sh --only ASC_KEY_ID,ASC_ISSUER_ID,ASC_KEY_P8`で1Passwordから同期する。内部グループが複数あるときだけ
  repository variable`TESTFLIGHT_GROUP`にグループ名を入れる
- **再実行**：失敗したrunは「Re-run failed jobs」か、Actionsから`iOS TestFlight`を同じ`sha`で手動実行する（`dry_run`で判定だけ見られる）。
  印は配布し終えたときだけ進むので、失敗した変更は次の判定にも残る
- **TestFlightのビルドは90日で期限切れ**：変更が無くても上げ直すときは、最新の`ios-testflight/*`タグを（本人の判断で）削除してから
  手動実行する。タグが無い扱いになり、初回として配る
- 失敗はSignaly・Discordへ通知される。iOSの失敗はWebのデプロイの成否とは別のrunで赤くなる（Webの本番反映は済んでいる）
- 署名鍵・APIキー・IPAはリポジトリにも公開artifactにも含めない（IPAは同じジョブ内でアップロードして捨てる）

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

## 共有拡張について

iPhoneの共有メニューから写真・URL・文章を直接渡す機能（Share Extension）は、App ID・App Group・拡張と本体の受け渡し・認証の設計が別論点のため後続Issueで扱います。それまでは`docs/share-shortcut.md`のショートカットを使います。
