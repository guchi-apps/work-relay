# research-desk 固有ルール

このリポジトリで作業するClaude Codeエージェント向けのルール。

**このファイルはissue-deckの画面の「新規アプリを立ち上げる」が置いた雛形である**
（`guchi-apps/issue-deck#2247`）。アプリ固有の前提（構成・認証・検証コマンド・
デプロイの注意点）は、初期化を進めながらここへ書き足していく。

ローカル実行ではユーザー個人環境のグローバルルール（`~/.claude/CLAUDE.md`）も読み込まれるが、
**GitHub Actions上での無人実行はリポジトリをチェックアウトしたワークツリーしか参照できない**
ため、それらは読み込まれない。無人実行でも守られる必要があるルールは、このファイルに
明文化しておく必要がある。

## アプリ概要

| 項目 | 値 |
|---|---|
| 公開URL | https://research-desk.gucchii.com/ |
| 種別 | Next.js + DB |
| 本番ポート | `3115` |
| プロセス管理 | PM2 |
| データベース | `app_research_desk`（共有MariaDB） |

決めた条件で自動収集しつつクリップを溜め、AIアプリ（Claude／ChatGPT）に要約させ、資料として書き出す個人用ツール

**画面に出る名前は「ワークリレー（work·relay）」**（#139）。URL・DB名・PM2のプロセス名・
AIDE連携の識別子（`source: "research-desk"`等）は`research-desk`のまま。表示名は`src/app/layout.tsx`・
`src/app/manifest.ts`・ロゴ（`src/components/BrandMark.tsx`を`AppShell`・`SplashScreen`・`login/page.tsx`が使う）・
アイコン原本`public/brand/*.svg`にある（#225）。
GitHubリポジトリ名は`guchi-apps/work-relay`（#263。旧`research-desk`は自動でリダイレクトされる）。

技術構成・認証フロー・DBスキーマの現状は [docs/architecture.md](docs/architecture.md) を参照。

**本番のPM2にはプロセスが2つある**（#86）。Next.js本体（`research-desk`）と、記事AI解析の
ポーラー（`research-desk-analysis-worker`。VPS上のCodex CLIを起動する）で、どちらも
`deploy/ecosystem.config.js`に居る。本番デプロイはVPSの`app-deploy-gate`が行い（#302）、gateは
`pm2 delete deploy/ecosystem.config.js`で**ecosystemが宣言するプロセスをすべて**止めてから起動し直すため、
`ecosystem.config.js`へアプリを足しても`deploy.yml`側で名前を並べる必要は無い（gate導入前は`deploy.yml`の
`pm2 delete`に名前を並べており、足し忘れるとそのプロセスだけ古い配布物のまま動き続けた）。
**ecosystemから外したプロセスはgateが止めない**ので、消すときはVPSで`pm2 delete <名前>`と`pm2 save`が要る。
**Next.js本体は1プロセス（fork）のままにする**（#144）。共有された写真はそのプロセスのメモリに
一時的に置いており（`src/lib/share-inbox.ts`）、`instances`を増やすと受け取ったプロセスと読み出す
プロセスが食い違って写真が消える。

## 本番デプロイ（app-deploy-gate）

`main`へのpushで`.github/workflows/deploy.yml`が動き、**VPS上の手順はすべてVPSの`app-deploy-gate`
（guchi-apps/vps#275）が行う**（#302）。ワークフローがSSHで送れるのは`upload`（配布物）・`env`
（`KEY=VALUE`を標準入力で1行1変数）・`deploy`の3語だけで、任意のシェルコマンドは実行できない。
gateは旧配布物の削除・展開・`.env`更新・`pnpm install --prod --frozen-lockfile`・
`prisma migrate deploy`（`MIGRATE_DATABASE_URL`で。`.env`へは書かない）・PM2の再起動・
`/api/app-version`の`sha`と`APP_COMMIT_SHA`の照合までを行う。

- **gateのアプリ名は`research-desk`**（リポジトリ名の`work-relay`ではない）。gateは置き場を
  `/home/github-user/apps/<アプリ名>`に固定し、PM2のプロセス名もアプリ名で止めるため、旧名のままの
  置き場・PM2のプロセス名（`research-desk`）に合わせる。鍵はアプリ専用の`SSH_PRIVATE_KEY`
  （`op://apps/work-relay/deploy-ssh-key`）で、VPSの`authorized_keys`の`command=`がアプリ名を固定する
- **gateの外の処理はデプロイで動かせない。** マイグレーション直前の処理だけは`deploy/pre-migrate.sh`に
  置ける。記事AI解析のポーラーが`online`かの確認（gate導入前は警告のみ）はデプロイでは行わなくなった
- `TARGET_DIR`は使わなくなった（マニフェストには移行確認まで残している）

## 出力言語

エージェントの出力は日本語で書く。対象は成果物（コミットメッセージ・PR・Issueコメント）
だけでなく、**応答本文・作業の要約・TODO・提示する計画・ツール実行時の説明といった画面に
出る文章も含む**。コード・識別子・ファイルパス・コマンド・設定値・ログやエラーメッセージの
引用は原文（英語）のままでよい。

## 検証コマンド

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build:ci
```

**worktreeの起動プロンプトに「依存インストール済み」とあっても`node_modules`が無いことがある**（#94）。
`pnpm lint`が`eslint: not found`で落ちたら、新しい依存の追加ではないので確認を取らずに
`pnpm install --frozen-lockfile --prefer-offline`を実行してよい（`postinstall`の`prisma generate`も
一緒に走るため、その後の`typecheck`も通る）。`pnpm test`だけはNode標準の`node --test`なので
`node_modules`が無くても通り、そこで気付きにくい。

**`pnpm test`は`node --test 'src/**/*.test.ts'`で、DBに繋がない純粋なロジックだけを対象にする**
（#79）。Node 24が型を剥がしてTypeScriptのまま実行するため、テスト用の依存もビルド手順も要らない。
テストから読めるのは**Prismaをimportしないモジュールだけ**なので、テストしたいロジックは
`src/lib/analysis-job-rules.ts`のようにDB操作から切り離した場所へ置く。テストは対象を`./x.ts`と
拡張子つきでimportするため、`tsconfig.json`に`allowImportingTsExtensions`が要る。

**`typecheck` は `next typegen && tsc --noEmit` にしておくこと**（guchi-apps/issue-deck#2378）。
Next.js 16の `PageProps` / `LayoutProps` / `RouteContext` は `.next/types` へ生成される
グローバル型で、生成前は `Cannot find name 'LayoutProps'` になる。`next build` は内部で
型生成するため、**ビルドは通るのに `typecheck` だけが落ちる**という分かりにくい形になる。

**依存を足したら `pnpm approve-builds` を実行し、`pnpm-workspace.yaml` の差分をコミットする。**
pnpm 10系は依存のビルドスクリプトを既定で実行せず、警告だけ出して終了コード0で素通りする。

**`package.json` に `"postinstall": "prisma generate"` を持たせ、`prisma` は
`devDependencies` ではなく `dependencies` に置く**（#3）。`typecheck`（`tsc --noEmit`）は
Prisma Clientの生成物を型として読むが、生成しているのは `build:ci`（`prisma generate && next build`）
だけなので、生成前に `typecheck` を回すと
`Module '"@prisma/client"' has no exported member 'PrismaClient'` と、そこから派生した
`implicitly has an 'any' type` で落ちる。`pnpm install` の副作用で生成が残っているかどうかに
結果が左右されるため、**同じコミットでCIが通ったり落ちたりする**という分かりにくい形になる。
`prisma` をdependencies側に置くのは、VPSの`app-deploy-gate`が走らせる
`pnpm install --prod --frozen-lockfile` からもCLIを見えるようにするため（devDependenciesのままだと
本番のpostinstallが `prisma: not found` で落ちる）。

**`eslint.config.mjs` は `eslint-config-next` のサブパスエクスポート
（`eslint-config-next/core-web-vitals` / `eslint-config-next/typescript`）を直接importする。**
`@eslint/eslintrc` の `FlatCompat().extends("next/core-web-vitals", ...)` という旧パターンを
使うと、eslint-config-next 16系では `TypeError: Converting circular structure to JSON` という
原因が分かりにくいエラーで落ちる（eslint-config-next 16はflat configをネイティブにexportして
いるため、legacy config resolverを経由する必要が無い）。

**`eslint.config.mjs` に `.shared-context/`・`.shared-prompts/` のignoreを必ず持たせる。**
Flat configは既定でリポジトリ全体を対象にするため、GitHub Actions実行時にチェックアウトされる
これらのディレクトリ（他リポジトリ由来）もlint対象に入り、無関係なコードのエラーでCIが落ちる。
ローカルでは`.shared-context/`が無いことが多く再現しにくい。

**型チェック・Lintが通ることと、実際の動作が正しいことは別。** 振る舞いが変わる変更では
両方を確かめる。

**ソースに制御文字のエスケープ（`\u0000`・`\u001f`・`\u007f`等）を書くと、エージェントの
ファイル書き込み（Write・Editツール）で生の制御バイトに化けることがある**（#149）。正規表現の
文字クラスが壊れて制御文字を除去しなくなり、ファイル自体もgit上バイナリ扱いになってPRで差分を
読めなくなる。lint・型チェック・ビルドはすべて通るので気付けない。制御文字を扱う処理は既存実装
（`news-mail.ts`の`sanitizeSubjectBody`）を再利用し、テストの入力は`String.fromCharCode()`で
組み立てる。コミット前に`git diff develop --numstat`で追加・削除行数が`-`（バイナリ）になって
いるファイルが無いことを確かめる。

## 依存関係の追加

新しい依存関係（パッケージ・ライブラリ・ツール）を追加する前には、必ずユーザーに確認を取る。

GitHub Actions上の無人実行では、その場で確認を取る相手がいない。追加が必要だと判断した場合は
追加せずに作業を止め、`00.check-user`ラベル（と理由を表す`01.check-blocked`）を付与した
うえで、なぜ必要かをIssueコメントで相談する。

## シークレットの扱い

- APIキー・トークン・パスワード等の実シークレットをコミットしない。コミットしてよいのは、
  値を空にしたサンプル（`.env.example`）と、1Passwordの`op://vault/item/field`形式の
  参照だけを書いた対応表（`.github/secrets-manifest.tsv`）に限る
- **1Passwordは「人が管理する唯一の正」だが、GitHub Actionsの実行時の取得先ではない。**
  1Passwordサービスアカウントには日次レート制限（アカウント全体で1,000リクエスト/日）が
  あり、実行のたびに読むとフリート全体のデプロイが止まる。`ci.yml`・`deploy.yml`は
  GitHubのsecret/variableから取得する。対応表は`.github/secrets-manifest.tsv`、同期は
  `scripts/sync-github-secrets.sh`（値を変更したときだけ実行する）
- `.github/secrets-manifest.tsv`で**`scope`が`repo`の行に`SOURCE`が`-`のものを
  作らない。** 同期スクリプトが`op read -`を実行して必ず失敗し、GitHub側に値が
  作られないままワークフローの参照が空で通る（`guchi-apps/aide-bot#5`）
- **環境変数を1つ足すときに触る場所は5つある**（#31・#302）。`.env.example`に書いただけでは本番へ
  入らない。`.github/secrets-manifest.tsv`の行、`deploy.yml`の`deploy`ジョブの`env:`、
  `Send environment variables`ステップの`env:`・改行チェックの`for name in`・`printf`の行を揃えて
  初めて本番の`.env`に入る（gateが標準入力の`KEY=VALUE`を`.env`へ書く。`MIGRATE_DATABASE_URL`だけは
  `.env`へ書かれずマイグレーションに使われる）。`printf`に並べ忘れるとその変数は本番の`.env`に入らない。
  **ローカルでは動くのに本番だけ401**という形で出るため気付きにくい
  （`COLLECTION_MCP_SECRET`・`COLLECTION_CRON_SECRET`が実際にこの状態で、`/api/mcp`も
  `/api/collection/weekly`も本番では一度も通っていなかった）。**過不足は
  `.env.example`のキーと`deploy.yml`の`printf`の差分で機械的に拾える**
  （`grep -oP '^\w+(?==)' .env.example` と `grep -oP "printf '%s\\\\n' \"\K\w+(?==)" .github/workflows/deploy.yml`
  を`comm`で突き合わせる。`DB_*`など組み立て元だけの変数は除く）。**gateは改行を含む値を送れない**ので、
  複数行の値はbase64の1行にしてアプリ側で戻す
- **定期実行のワークフローが動くのはデフォルトブランチ（`develop`）のファイルだけ**（#33）。
  `.github/workflows/collection-daily.yml`（旧`collection-weekly.yml`）のcronは`develop`へマージした時点で**本番に対して**
  動き始めるが、本番の`.env`へ値が入るのは`develop`→`main`のリリースがデプロイされたとき。
  シークレットを使う定期実行を足すときは、その間だけ401で落ちることを織り込む
- **AIDEから呼ばれるサーバー間APIは`/api/internal/*` + 環境変数`INTERNAL_API_KEY`に揃える**（#31）。
  dayspan・myroom・subscription-lists・ops-dashboardが全てこの形で、AIDE側も
  `AIDE_<APP>_URL` / `AIDE_<APP>_TOKEN`で揃っている。アプリごとに独自のパス・独自のenv名を作ると、
  AIDE側の実装とデプロイ設定だけがそのアプリ用に分岐する。**環境変数が未設定のときは素通りではなく
  503を返す**（設定漏れが認証なしの公開に化けるのを防ぐ）。`src/lib/internal-auth.ts`
- **待受ポートは1Passwordでもマニフェストでも管理しない。** `deploy.yml`に平文で持つ
  （`guchi-apps/docs`の`standards/ports.md`）

## 全アプリ共通の共有知識（shared context）

複数アプリで再利用できる知識は共有知識リポジトリ（`guchi-apps/docs`）で管理する。
GitHub Actions実行では`.shared-context/`へcheckoutされ、ローカル実行では`~/apps/_docs`を
参照できる。**`.shared-context/`配下は読み取り専用として扱い、編集・`git add`・
コミットを行わない。**

読む順序は、`CLAUDE.md`（索引）→ 自分の役割の`agent-rules/` → 必要に応じて
`knowledge/` → 設計判断が要るときだけ`standards/` → 手作業の設定手順が要るときだけ
`guides/`。内容が矛盾する場合はこのファイルを優先する。

実装中に得た知見は、このリポジトリの`docs/`か`CLAUDE.md`へ書くのと、同じ内容を
「知見メモ」コメント（`<!-- knowledge-candidate -->`）としてIssueへ投稿するのを**両方**行う。
共有知識へ格上げすべきかどうかは判定しない。

# Issueごとの複数Claude Codeエージェント運用

## ブランチ運用

- `main`は本番環境と一致するリリース用ブランチで、直接コミット・pushしない。`develop`が
  日常の開発ブランチで、本番へ反映する変更は`develop`→`main`のPull RequestをCI通過後に
  マージする
- Issue単位の作業ブランチは`develop`から作成し、**ブランチ名は`issue-<Issue番号>`とする**
  （例: `issue-123`）。進捗の遷移とcloseはこの命名だけを見ているため、違う命名では
  進捗が一切動かない

## Issueの進捗

**進捗はGitHub ProjectsのStatusで管理する。唯一の正はStatusで、進捗ラベルは存在しない。**
Statusを進めるのはissue-deckだけで、各ワークフローは進捗報告API（`POST /api/progress`）へ
報告する。`gh issue edit`で進捗を付け替えることはできない。

`Ready` → `Planning`（`21.plan-required`のときだけ）→ `Implementation` →
`Develop PR` → `Develop` → `Release` → `Done`（mainへマージ完了。この時点でclose）。

`00.check-user`（ユーザーのチェックが必要）はどの段階でも併用でき、**付けるときは理由を
表す`01.check-*`ラベルも1枚あわせて付ける**（そのリポジトリに定義が無ければ付けなくてよい）。
`11.local`が付いている間は無人実行がそのIssueに対して何も行わない。

## 実装エージェントの禁止事項

- `main` / `develop` への直接コミット・push
- 他Issueのブランチ・worktreeの編集
- **担当Issue以外の実装。** 作業中に別件を新規Issueとして起票するのはよいが、そのIssueを
  このセッション・このブランチで実装しない
- 不要なforce push
- 自分が作成したPull Requestの自己マージ

## 自動マージ不可カテゴリ（`00.check-user`付与対象）

認証・認可／DBスキーマ変更・マイグレーション／本番環境の設定／GitHub Actionsやデプロイ設定／
Secretsや環境変数／課金・決済／大規模な依存関係の更新／`develop`→`main`のマージ。

## PR本文テンプレート

`develop`宛のPRには次を記載する。対応Issueは`closes #番号`を使わず`#番号`のみ
（developマージ時点ではissueをcloseしない運用のため）。

- 対応Issue
- 実装内容
- テスト内容
- 確認方法
- 注意点

## ワークフローの構成

`.github/workflows/`のうち`uses:`で`guchi-apps/issue-deck`を参照しているものは
**トリガー定義だけを持つ薄いcaller**で、ジョブ本体はissue-deck側にある。参照は
`@workflows/vN`のタグ固定で、**`uses:`のタグと`prompts-ref`は必ず同じ値にする。**
タグを上げるPull Requestはissue-deckの画面（設定＞フリート運用）から配られる。

- `issue-labels.yml` … 進捗の状態遷移をイベント駆動で報告する
- `claude-issue-dispatch.yml` … Issue起点の無人実行。**このファイルがデフォルトブランチに
  あることがissue-deckの盤面へ載る条件**なので消さない
- `release-develop-to-main.yml` … バージョンbump PRと develop→main のPR作成。
  **バンプPRの自動マージは`develop`のブランチ保護（必須チェック`lint-and-build`）が前提**（#238）。
  保護が無いと共有workflowの`gh pr merge --auto`が`Pull request is in clean status`で失敗し、
  バンプPRが手動マージ待ちのまま止まる（run自体は成功するため気付きにくい）。バンプPRは対応Issueが
  無いので`claude-review-develop.yml`側の自動マージも働かない。CIのジョブ名を変えたら保護の
  必須チェック名も合わせる。設定値は`docs/architecture.md`の「バンプPRの自動マージ」を参照
- `version-tag-check.yml` … バージョンの上げ忘れをmain宛PRで落とす。**消さないこと**——
  初回の`main`マージが作った`vX.Y.Z`タグと同じバージョンのまま2回目のリリースを出すと、
  `deploy.yml`のタグ作成が落ちて本番デプロイが止まる（guchi-apps/issue-deck#2378）
- `sync-secrets.yml` … 1Passwordから`.github/secrets-manifest.tsv`のとおりに同期する

自動修復系（`claude-ci-fix.yml`・`claude-conflict-resolve.yml`・`claude-pr-repair.yml`・
`claude-review-develop.yml`・`deploy-retry.yml`）も置かれており、いずれも同じ`uses:`のタグ固定
（`@workflows/vN`）に従う。タグの引き上げは他のcallerと同じくissue-deckの画面
（設定＞フリート運用）から配られる。

**callerに書ける`with:`は、参照しているタグ時点の再利用ワークフローが持つ入力だけ。**
宣言されていない入力を渡すとワークフローの読み込み自体が失敗する。

## リダイレクト先・外部へ渡すURLの組み立て

**`new URL(request.url).origin`でoriginを組み立てない。** Next.js 16の`request.url`は待受アドレス
（`http://localhost:<PORT>`）を返し、ブラウザが送った`Host`ヘッダーを反映しない。Apacheの
リバースプロキシ配下にある本番では`https://localhost:3115`になり、Supabaseへ渡すOAuthの
`redirect_to`が実在しないURLになる（#14）。`src/lib/request-origin.ts`の`getRequestOrigin()`を
使う。クエリ由来の戻り先（`?next=`）は同ファイルの`safeNextPath()`を通す。
ローカルでは`localhost`しか使わないため再現しにくく、**本番でだけログインが失敗する**という
形で出る。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
