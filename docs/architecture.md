# アーキテクチャ概要

このリポジトリの初期化（#1）で決めた構成のメモ。以降のIssueで機能を足すときの前提として参照する。

## 技術スタック

`guchi-apps/docs` の `standards/tech-stack.md` に沿う。Next.js 16 App Router + React 19 +
TypeScript + Tailwind CSS v4 + Prisma 6（MariaDB）+ Supabase Auth（Google）。

- Prisma は7系ではなく6系に固定している（7系はdriver adapterが必須になり、既存アプリと構成が
  分かれるため）
- shadcn/ui・Framer Motionは初期化時点では導入していない。UIが複雑になった時点で必要なら足す

## 認証（Supabase Auth）

ルート構成は他アプリ（car-care・asset-manager・db-console）と揃えている
（同一セグメントに`page.tsx`と`route.ts`を共存できないため）。

| パス | 役割 |
|---|---|
| `/login` | ログイン画面（`/auth/signin`への素のリンクのみ。JS不要） |
| `/auth/signin` | Route Handler。サーバー側でOAuth認可URLを組み立てて302 |
| `/auth/callback` | Route Handler。`code`をセッションと交換し`/dashboard`（業界ニュース画面）へ |
| `/auth/signout` | Route Handler（POST）。このアプリのセッションだけを破棄し`/login`へ（`signOut({ scope: "local" })`。引数なしはglobalで、共有Supabaseの他アプリ・他端末まで失効させる。`src/lib/auth-signout.ts`） |
| `/api/dev/login` | CI・ローカル開発専用のバイパス（`NODE_ENV!=="production"`かつ`CI_LOGIN_BYPASS_SECRET`設定時のみ有効） |

- `src/proxy.ts`（Next.js 16の`middleware.ts`相当）は`/`と`/dashboard`配下だけを保護対象に
  している。全経路を対象にすると静的アセット（アイコン等）の除外漏れを踏みやすいため、
  保護範囲を絞って回避した（`matcher: ["/", "/dashboard/:path*"]`）。`/dashboard/:path*`は
  0個以上にマッチするため、`/dashboard`配下に新設した`/dashboard/inbox`（#124）もこのmatcherの
  変更なしで保護対象に入る
- ログイン可否はStatusHubの共通アクセス設定（`POST /api/access/v1/decision`）で判定する（#281）。
  `src/lib/access/`が30秒キャッシュ、取得失敗時は最大5分だけ直前の判定を使い、超過・未判定は拒否する。
  **旧`ALLOWED_GOOGLE_EMAILS`は判定にもフォールバックにも使わない**（残るのは検証後に整理する旧設定）。
  アプリ別トークンはissue-deckの共有トークン`RESEARCH_DESK_ACCESS_APP_TOKEN`から読み、401なら読み直して
  1回再試行する。`src/instrumentation.ts`が4分ごとにハートビートを送る（管理画面の「反映済み」の根拠）。
  DBにユーザーテーブルは持たない。管理画面に入れないときの復旧はstatus-hubの`scripts/access-recover.mjs`
- `src/lib/auth.ts` の `getCurrentUser()` は「未ログイン」と「Supabaseへ疎通できず今は確認できない
  （`AuthRetryableFetchError` / 429）」を区別する。後者をログイン画面へ差し戻すと、電波の悪い
  場所で開いただけの利用者がログインし直しになるため。`src/proxy.ts`も同じ基準
  （`src/lib/auth-error.ts`の`isRetryableAuthError`）で、この2種類のエラーのときは`/login`へ
  リダイレクトせず素通しする（#169）。proxyが先に差し戻すと、matcher対象の`/`と`/dashboard`配下では
  ページ側の`unavailable`分岐（「認証状態を確認できませんでした」）に届かない

### リダイレクト先のoriginは`request.url`から作らない

**Next.js 16の`request.url`は待受アドレス（`http://localhost:<PORT>`）を返し、ブラウザが送った
`Host`ヘッダーを反映しない。** `next dev -p 27014`に`Host: research-desk.gucchii.com`を付けて
リクエストしても`request.url`は`localhost:27014`のままになる（#14で実測）。

そのため`new URL(request.url).origin`でoriginを組み立てると、Apacheのリバースプロキシ配下に
ある本番では`https://localhost:3115`になる。Supabaseへ渡す`redirect_to`がこの値になると、
Redirect URLsに載っていないURLとして扱われ、GoTrueはSite URL（`https://gucchii.com/`）へ
フォールバックする。利用者からは**ログインすると`https://gucchii.com/?error=invalid_request&
error_code=flow_state_already_used`へ飛ばされる**という形で見える。

外部へ渡すURL・リダイレクト先は`src/lib/request-origin.ts`の`getRequestOrigin()`で組み立てる。
`Host`（Apacheの`ProxyPreserveHost On`で保持）と`X-Forwarded-Proto`から作る形で、
car-care・db-consoleと同じ。`?next=`のようなクエリ由来の戻り先は同ファイルの`safeNextPath()`を
通す（`//evil.example`はブラウザに別オリジンとして解釈されるため、先頭が`/`かどうかだけでは
オープンリダイレクトを防げない）。

**`?next=`未指定時の既定の遷移先は`safeNextPath()`の`fallback`引数1箇所で管理している**（#42）。
`/auth/callback`・`/auth/signin`・`/api/dev/login`の3ルートがこの関数を共通で呼んでおり、
ログイン後の既定の遷移先を変える（#124で`/`から`/dashboard`へ変えた）ときは、この1箇所を
直せば3ルートすべてに一貫して効く。ルートごとに個別のフォールバック値を持たせていないため、
一部のルートだけ直し忘れるということが起きない。

## データベース

`Clip` は汎用クリップの配線確認用として残し、業界情報は `IndustryInformation` に分離する。
業界情報には `DELIVERY`（宅配）または `LOCKER`（ロッカー）を必須で持たせ、情報区分、重要度、
公開日／発生日、収集日時、本文、要約、取得数値、企画への示唆、対象企業・商品、キーワード／タグ、
対象期間の区分を保存する。数値とキーワード／タグは、後続の収集処理で項目が増えても移行なしで
保持できるよう JSON とする。

元 URL は `originalUrl` に保持し、収集処理が計算した URL 正規化値 (`normalizedUrl`) と SHA-256
ハッシュ (`urlHash`) に一意制約を付ける。同じ URL の登録は DB で拒否する。一次情報かどうかは
`isPrimarySource` で明示し、元 URL と情報源を失わない。

同一発表が別 URL で配信された場合の統合は、`mergedSources`（統合元 URL の JSON 配列）・
`updateReason`（直近の更新理由）・`updatedByRunId`（最後に統合・更新した `CollectionRun`）で
表現する（#43）。`canonicalId`/`canonical`/`relatedReprints` はこの用途と重複し、かつ表示側
（`listIndustryInformation()`・`dashboard/page.tsx`）で一切参照されず実効性が無かったため、
**#43 以降は書き込みに使わない**（過去データ互換のため列・リレーションのみ残す）。

事業区分・情報区分、重要度・公開日、対象期間・公開日、転載グループには複合／検索用インデックスを
付けている。これにより、後続の検索・フィルター・週報生成は公開日を基準に必要な情報を絞り込める。

## AIDE向けサーバー間連携API（週報登録）

`POST /api/internal/weekly-report` は、AIDEのMCPツール
（`aide_research_desk_import_weekly_report`）から週報を受け取るNode.js Route Handler（#31）。

当初（#27）はChatGPTが直接繋ぐ独立MCPサーバー（`/api/mcp`）として作ったが、静的Bearer認証の
独立MCPはChatGPT側のMCP認証方式と運用が合わず、アプリごとにChatGPT接続を増やすことにもなる。
既にChatGPTと接続・認証済みのAIDEを共通窓口にする方針へ変え、`/api/mcp`（JSON-RPCの
`initialize`・`tools/list`・`tools/call`）は削除した。ChatGPTはAIDEまでしか繋がらないため、
Research Deskの認証情報はChatGPTへ露出しない。

認証は`src/lib/internal-auth.ts`の`requireInternalApiKey()`で、環境変数`INTERNAL_API_KEY`との
タイミングセーフ比較1本。**未設定のときは素通りではなく503を返す**——設定漏れがそのまま
認証なしの公開に化けるのを防ぐ。不一致は401。パス・環境変数名はフリートの他アプリ
（dayspan・myroom・subscription-lists・ops-dashboard）の`/api/internal/*` + `INTERNAL_API_KEY`に
揃えてあり、AIDE側も`AIDE_<APP>_URL` / `AIDE_<APP>_TOKEN`で揃う。呼び出し元は同一VPS上のAIDE
（`127.0.0.1`）だけを想定しており、外部公開は要らない。`src/proxy.ts`のmatcherは`/dashboard`
配下だけなので、このパスはSupabaseへ問い合わせずに素通しされる。

週報の登録は`src/lib/collection.ts`の`importWeeklyReport()`が担当する（#27から流用）。1回あたり
全体10件、各事業5件までを入力検証する（#47。当初は全体6件・各事業3件で、AIDE側が広げた上限
（guchi-apps/aide#226）にここも揃えた）。`extractedMetrics`（主要数値のオブジェクト）はAIDE側の
制限（30項目・JSONにして2000文字まで）と同じ上限で受け付ける。事業あたりの入力上限（5件）は
`upsertIndustryInformationEvent()`側の週あたり保持上限（`BUSINESS_WEEKLY_LIMIT`＝15件/事業）とは
別の値で、AIDE側との契約として据え置いている（#94で保持上限だけを広げた）。1回のリクエストの
5件では週の保持上限に届かないため、置換／除外は同じ週に複数回登録したり、自動収集の記事が
先に枠を使っていたりして、保持上限に達したときに働く。記事の取り込みは
`upsertIndustryInformationEvent()`（#43。自動収集の`runDailyCollection()`とも共通）に委ね、
完全URL一致は従来どおり冪等に扱い、URLが異なっていても同一イベントと判定した記事は新規作成せず
既存記事へ統合・上書き更新する。登録結果は`CollectionRun`に保存し、新規・統合更新・重複・除外の
件数と`DELIVERY`／`LOCKER`別の件数を返す（`mergedCount`・`excludedCount`はレスポンスへの追加
フィールドで、AIDE側の契約は後方互換）。レート制限はプロセス内で認証済みクライアントごとに1分20回
までとするため、複数プロセス環境ではリバースプロキシ側の制限も併用する。シークレットと入力本文は
ログへ出さない。

初回マイグレーション（`prisma/migrations/20260830000000_init/`）は、CI環境にライブDBが無い状態で
`pnpm exec prisma migrate diff --from-empty --to-schema-datamodel=prisma/schema.prisma --script`
を使って生成した（`prisma migrate dev`と違いDB接続を必要としない）。

**2回目以降の増分マイグレーションも、DB接続なしで生成できる。** `--from-migrations`は
シャドウDBを要求するので使わず、**変更前のスキーマをgitから取り出して`--from-schema-datamodel`に
渡す**（#37）。ローカルに`.env.local`が無い環境でも生成でき、`prisma migrate dev`のように
開発用DBを作らずに済む。

```bash
git show HEAD:prisma/schema.prisma > /tmp/schema-old.prisma
pnpm exec prisma migrate diff --from-schema-datamodel /tmp/schema-old.prisma \
  --to-schema-datamodel prisma/schema.prisma --script \
  > prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql
```

出力先はリダイレクトで作る（`prisma.config.ts`の`quiet: true`が効いているのでstdoutにSQL以外は
混ざらない。混ざったときの実害は`guchi-apps/aide-bot#9`）。**`2>&1`でstderrも一緒にリダイレクト
すると、`Loaded Prisma config from prisma.config.ts.`やアップデート通知のバナーがSQLファイルへ
混入する**（#43で実際に発生し、`prisma/migrations/20260831120000_daily_event_merge_and_weekly_cap/`
を作り直した）。`> file`だけにし、`2>&1`は付けない。

**worktreeには`.env.local`が置かれないため、DBを伴う動作確認は「まずローカルDBを用意する」
ところから始まる**（#47・#110）。1PasswordのDB共通アイテム（`db-host`＝`localhost`）は本番（VPS）上で
接続する前提の値で、そのままでは使えない。SSHトンネル（`database.md`）で本番相当のDBへ
繋ぐ手もあるが、テスト用の書き込みで本番データを汚す危険がある。

**ただしサブPCにはローカルのMariaDBが動いている**（127.0.0.1:3306。#110で確認。#47の時点の
「ローカルMariaDBもDocker/Podmanも無い」という記述は現状と合わない）。他のアプリは
`app_<アプリ名>_dev`のデータベースを各自の`.env.local`から使っている。research-desk用の
ローカルDBは常設していないので、画面の実地確認が要るときは一時的に用意する。

```bash
# .env.local に DATABASE_URL（ローカルの app_research_desk_dev）を書いてから
pnpm exec prisma migrate deploy
DATABASE_URL=... pnpm db:seed:ci   # seed-ci.mjs は Prisma CLI 経由ではないので明示的に渡す
```

**DBと接続ユーザーは`sudo -n mysql`（unix_socket認証。パスワード入力なし）で作れる**（#137で確認）。
`mysql -u guchi`は拒否される。パスワードはその場で`openssl rand -hex 16`で作り、`.env.local`
（gitignore済み）にだけ書く。`127.0.0.1`で繋ぐため、ユーザーは`'localhost'`と`'127.0.0.1'`の両方に作る。

```bash
PW=$(openssl rand -hex 16)
sudo -n mysql -e "CREATE DATABASE IF NOT EXISTS app_research_desk_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  CREATE USER IF NOT EXISTS 'research_desk_dev'@'localhost' IDENTIFIED BY '$PW';
  CREATE USER IF NOT EXISTS 'research_desk_dev'@'127.0.0.1' IDENTIFIED BY '$PW';
  GRANT ALL ON app_research_desk_dev.* TO 'research_desk_dev'@'localhost';
  GRANT ALL ON app_research_desk_dev.* TO 'research_desk_dev'@'127.0.0.1';"
```

ユーザーが既にある（前回の検証で作った）場合は`CREATE USER IF NOT EXISTS`がパスワードを変えないので、
`ALTER USER ... IDENTIFIED BY '$PW'`も続けて流す。

**auto mode（`--permission-mode auto`）のセッションでは、`CREATE USER ... IDENTIFIED BY`・
`ALTER USER ... IDENTIFIED BY`がauto modeの分類器に`Secret-Store Writes`として拒否される**
（#154で確認）。ユーザーが既に居るがパスワードが分からない（worktreeをまたいで前回のセッションが
作った等）場合、この手順でのDB確認は詰む。手作業モードへの切り替えを頼むか、確認方法を
DBに依存しない形（コードレビュー・curlでの入力検証確認）に切り替える。

ダミーの`DATABASE_URL`のままでも`requireInternalApiKey()`・入力検証までは到達できるため、
**バリデーションの単体的な挙動はcurlだけで確認できる**。Prismaを呼ぶ画面（`/dashboard`・
`/dashboard/inbox`・`/dashboard/news-mail`）は`PrismaClientInitializationError`が`loading.tsx`のSuspense境界内で
起きるため、**レスポンスは200のまま起動画面（`splash-shell`）で止まって見える**（ステータス
コードだけでは気付けない）。

**DBに依存しない画面（`/settings`等）は、`/api/dev/login`のバイパスCookie経由でcurlのまま
確認できる**（#67）。`getCurrentUser()`はバイパスCookieがあればSupabaseへ問い合わせずに
即座に認証済みを返すため（`src/lib/auth.ts`の`getDevLoginEmail()`が先に評価される）、
`NEXT_PUBLIC_SUPABASE_URL`が未設定でも到達できる。一方、Prismaを呼ぶ画面は`DATABASE_URL`が無い・繋がらないと
起動画面で止まって見える（前掲「データベース」の節）。

## 新着記事の仕分け画面（`/dashboard/inbox`。元は`/`、#42）

直近で収集された業界情報（`IndustryInformation`）を`collectedAt`降順で最大`RECENT_LIMIT`（60）件
取得し、JSTの日付基準で「今日」「昨日」「それ以前」に区分して表示する
（`src/lib/industry-information.ts`の`listRecentIndustryInformation()`・`getRecencyLabel()`）。

収集は日次（`collection-daily.yml`。`COLLECTION_LIMIT`は1回30件）だが、新規の記事が無い日もあり、
「今日・昨日」だけに絞ると空になる日がある。そのため常に直近の記事を件数上限で取得し、区分ラベルは
表示上の見出しとしてのみ使う
（0件になる区分の見出しは出さない）。

**#124でログイン後の初期画面を業界ニュース画面（`/dashboard`）に変えたのにともない、この画面は
`/`から`/dashboard/inbox`へ移した。** `/`（`src/app/(app)/page.tsx`）は認証チェックのあと
`/dashboard`へ`redirect()`するだけの薄いページになっている。業界ニュース画面からこの画面への
遷移は、未判定の記事が1件以上あるときだけ出る強調バナー（`.new-banner`）と、サイドバーnavの
「新着記事」リンクの2経路。事業別の絞り込みや週送りはこれまでどおり`/dashboard`が担う。

## 業界ニュース画面（`/dashboard`）

画面は`industry_information`の表示専用で、書き込みはAIDE経由の`POST /api/internal/weekly-report`
だけが行う（#32）。クエリの組み立てと表示用の整形は`src/lib/industry-information.ts`に置き、
`src/app/dashboard/page.tsx`はその結果を描くだけにしてある。1週ぶんは全体6件・各事業3件までなので、
絞り込み後の件数はそのまま描画してよい大きさに収まる。

**ログイン後の初期画面（#124）。** 未判定の新着記事（`countTriage()`の`pending`）が1件以上あるときだけ、
画面上部に仕分け画面（`/dashboard/inbox`）への強調バナー（`.new-banner`）を出す。0件のときは
バナー自体を出さない——常時出すと「未判定が無い週」の方が多いため、無条件のバナーはノイズになる。

### 週の区切りはJSTの日曜0時

`?week=`は今週を`0`とするオフセットで、`-8`まで遡れる。週の範囲は**JST（UTC+9）の日曜0時**から
7日間で（#216）、サーバーのタイムゾーン設定に結果を左右させないため`Date`のローカルメソッドは
使わず、オフセットを足してUTCとして扱う（`getWeekRange()`）。境界変更にともなう既存データの
再集計・移行は不要（`weekCondition()`は公開日・発生日・収集ランの期間重なりで判定するロジックの
ままで、境界がずれるだけのため）。`weekCondition()`は`src/lib/collection.ts`のイベント統合・
週あたり上限判定からも再利用する。

**この境界は#43で一度日曜0時にし、#125でカレンダーピッカーの表示（月曜始まり）に合わせて月曜0時へ
戻し、#216でChatGPT定期タスクの週報仕様（JSTの日曜00:00〜土曜23:59を1週とする）に揃えるため
再び日曜0時へ戻したもの。** #216ではカレンダーピッカー（後述）自体も日曜始まりの行へ変更しており、
「画面のこの週に出ているのに週あたり上限は別の週の枠で数えられている」という#125が避けようとした
食い違いは、表示・カレンダーの行・日次収集の対象期間・週あたり掲載上限・週報メールの既定週・
週の総括AIジョブが共有する`getWeekRange()`を揃えることで今回も維持している。**どの日付項目を
優先して週を判定するか（公開日→発生日→収集期間、後述）という#43の判断基準はこれと無関係で
変えていない。** 週選択カレンダーピッカー自体は「業界ニュース画面（`/dashboard`）」の節を参照。

どの週に出すかは公開日（`publishedAt`）で決める。`periodScope`（`IN_SCOPE`／補足の
`PAST_30_DAYS_SUPPLEMENT`）による分岐はない——以前は補足だけ常に登録した収集ランの週に
出していたが、公開日が入っている補足記事が実際の公開週ではなく登録週（例:「30日以内」バッジ
付きで8/3公開の記事が8/30週に表示される）に出てしまい、利用者からは「正しい週に表示されて
いない」と映っていた（#59）。公開日が入っている記事はその公開日どおりの週に出すのが期待どおり
の挙動のため、`periodScope`に関わらず次の優先順位に統一した。

- **公開日が未設定の記事は、発生日（`occurredAt`）が入っていればそちらで判定する（#52）。**
  発生日も未設定の場合のみ、収集ランの対象期間（無ければ収集日）にフォールバックする。
  公開日未設定の記事を機械的に「登録した日」の週へ出すと、記事の内容と表示週がズレるため
  （AIDE経由の週報登録では公開日を付けない記事もあり、これが実際に起きていた）

`src/lib/collection.ts`側のイベント統合判定（`findEventMatch()`・`upsertIndustryInformationEvent()`
の`referenceDate`）は、これとは別の理由で**発生日→公開日**の優先順位を使っている。転載記事は
発行元により公開日がバラつくため、同一イベントかどうかの判定には事象そのものが起きた日を優先する
方が適切という別の関心事によるもの。表示側（`weekCondition()`）は「読者が見る週」を決める基準、
統合側は「同一イベントかどうか」を決める基準であり、意図的に優先順位が異なる（統一はしていない）。

`IndustryInformation.collectionRunId`は`importWeeklyReport()`・`runDailyCollection()`（#43で
`runWeeklyCollection()`から改名）が登録時に埋める（#37）。**公開日・発生日がどちらも未設定の
記事だけ**、収集ランの対象期間（**期間の重なり**——`targetFrom < 週の終わり` かつ
`targetTo > 週の始まり`。`targetTo`が翌週の日曜0時ちょうどでも翌週へはみ出さない）にフォール
バックする。収集ランに紐付いていない記事（#37より前に登録したもの、あるいはランに紐付いていても
公開日・発生日がどちらも未設定の記事）は、従来どおり収集日（`collectedAt`）の週で拾う。

### 週選択のカレンダーピッカー（#125）

`.week-nav`の週表示は`WeekCalendarPicker`（クライアントコンポーネント）で、クリックすると
選べる9週間（今週〜8週間前）を日曜始まりの月カレンダーで表示するポップオーバーを開く。日付を
クリックするとその週へ遷移し、今日の日付は二重丸で強調、各行には週番号（ISO 8601週番号）を表示する。

**日付計算はすべてサーバー側（`src/lib/jst-week.ts`の`buildWeekCalendarMonths()`）で完結させ、
クライアントには計算済みのグリッドデータ（月ごとの週の行・各日のISO日付文字列・所属する
`weekOffset`・今日かどうか）だけを渡す。** クライアントコンポーネントは開閉・ホバー状態だけを持ち、
`Date`を作り直さない（`jst-week.ts`の「Prismaに触れない純粋関数へ日付計算を寄せる」方針をそのまま
UIの計算にも適用したもの）。週の境界が日曜0時始まりに揃っているため、選べる範囲は常に週の境界
ちょうどで切れており、月をまたぐ週（例: 8/31〜9/6）もカレンダーの1行の中で自然に表現できる。
選べる範囲より先（今週より後ろ）は、直近月をカレンダーとして見やすくするため、選択不可の行で
当月末まで埋める。

ISO週番号は業界情報の週判定には使わない、カレンダー上の目印表示専用（`getIsoWeekNumber()`）。

### 絞り込みはクエリ側で行う

事業区分・情報区分（`isPrimarySource`）・重要度・キーワードは、すべてPrismaの`where`へ渡す。
並び順はMySQL/MariaDBのENUMが**定義順**で並ぶ性質に乗せており、`periodScope`（IN_SCOPE→補足）・
`importance`（HIGH→MEDIUM→REFERENCE）をそのまま`asc`で指定すると「補足は後ろ・重要度順」になる
（`prisma/migrations/*/migration.sql`のENUM定義順が正）。

キーワードは、文字列列（タイトル・要約・対象企業・対象商品・情報源・発行元）が**部分一致**、
JSON列の`keywords`・`tags`が**要素の完全一致**（`array_contains` = `JSON_CONTAINS`）になる。
Prismaが出せるJSON列の条件が完全一致までのためで、`ロッカー`では`ロッカー事業`というタグに
当たらない。タグは登録時の語をそのまま入れる前提で使う。

### 「NEW／更新」バッジと統合元の開閉パネル（#43）

カードには、直近の収集ラン（`getLatestCollectionRunId()`）と比べて新規追加・内容更新された
ものだけに「NEW」「更新」バッジを出す。`collectionRunId`（作成時のラン、週判定に使うため不変）が
直近ランと一致すれば「NEW」、`updatedByRunId`（最後に統合・更新したラン）が一致すれば「更新」。
`mergedSources`（統合元URLのJSON配列）を1件以上持つ記事だけ、カード下部に「更新履歴を見る」の
開閉パネルを出し、統合元URL一覧・`updatedAt`（最終更新日時）・`updateReason`（更新理由）を表示する。

## 日次収集とイベント統合（#43）

宅配・ロッカー業界情報の自動収集は`src/lib/collection.ts`の`runDailyCollection()`
（元は週次のみの`runWeeklyCollection()`）が担当し、毎日05:00 JSTの`collection-daily.yml`が
`POST /api/collection/daily`を叩く（元は20:00 JSTだったが、#216でChatGPT定期タスクが動いていた
時刻に揃えた）。`targetFrom`は「今週（JST日曜0時始まり）の開始」に固定する
——ローリング7日窓のままだと日次実行のたびに週境界をまたぐランが発生し、日次差分を週内へ集約する
前提が崩れるため。

AIDE経由の週報登録（`importWeeklyReport()`）と自動収集（`runDailyCollection()`）は、どちらも
記事1件の取り込みを`upsertIndustryInformationEvent()`に委ねる。

1. 完全URL一致は従来どおり冪等（`duplicate`、何も更新しない）
2. 同じ週・同じ事業のレコードと比較し、発表主体（対象企業→発行元→情報源の優先順）が一致し、かつ
   「対象製品/サービスが一致」または「タイトルが緩く類似し、発表日が近い（5日以内）か情報区分が
   一致」する場合は同一イベントとみなして新規行を作らず統合・上書き更新する（`findEventMatch()`）。
   統合元URL・変更内容から生成した`updateReason`・`updatedByRunId`を記録する
3. マッチしなければ新規イベントとして扱い、**事業ごと週15件（合計30件）**の上限を適用する
   （#94で5件／10件から広げた）。上限に達している場合、重要度→一次情報かどうか→公開日時の順で
   新規候補が既存の最弱記事より優先度が高ければ最弱記事を置換、そうでなければ新規候補を
   除外する。**置換は行を削除せず、`weeklyCandidate: false`（`reviewedAt`は`null`のまま＝「AIが
   対象外と判定」と同じ扱い）にして隠し、`updateReason`に置き換えた旨を残す**（#171）。行を消すと
   `ArticleAnalysis`・`ArticleAnalysisJob`がカスケードで消え（実行中のジョブならポーラーの報告が
   404になる）、`normalizedUrl`の一意制約も消えて、翌日のRSSに同じ記事が残っていれば未判定として
   登録し直される。**不採用の記事は上限に数えず、人が採用した記事は置換の対象にしない**
   （`src/lib/triage.ts`の`decideWeeklyCap()`。後述「記事の仕分け」）。置換/除外は必ず
   `CollectionRun.excludedArticles`（JSON配列）・`excludedCount`に記録してから実行する

**記事1件の登録失敗で実行全体を止めない**（#170）。`runDailyCollection()`のループは
`importWeeklyReport()`と同じく記事単位で`try/catch`し、失敗は`errors`へ`ARTICLE_INSERT_FAILED`として
積んで`PARTIAL`にする（フィード全滅、または登録しようとした候補が全滅のときだけ`FAILED`。
`src/lib/collection-rules.ts`の`decideDailyRunStatus()`）。ループが例外で抜けると`CollectionRun`が
`RUNNING`のまま残り、新着通知も飛ばない。**Prismaの生のエラー文は`errors`にも応答にも載せず、
サーバーログへ出す**（`/api/collection/daily`の500応答も固定の`collection_failed`）。
`normalizedUrl`（`VarChar(512)`）に収まらないURL（Google NewsのリダイレクトURLは長くなりやすい）は、
`parseFeed()`の段階で候補から落とす（`fitsNormalizedUrlColumn()`。`/api/articles/shared`と共通）。

イベント判定はヒューリスティック（LLMを使わない単語一致・日付近さ）のため、発表主体名の
表記揺れ等で誤統合・未統合が起こり得る。より高精度な判定が要るときは別Issueで検討する。

## 記事の仕分け（採用／不採用、#94）

新着記事画面（`/dashboard/inbox`。#124以前は`/`）は#42では直近10件を眺めるだけの画面だったが、無関係な記事（検索語
「ポスト」に当たった政治記事、「置き配」が題材のドラマ等）が混ざるため、#94で**仕分けの
受け皿**にした。タブ「未判定／採用／不採用／すべて」（既定は未判定）、カードごとの
「採用」「不採用」ボタン（`src/components/TriageActions.tsx`）、左のチェックとまとめて仕分ける
バー（`src/components/TriageInbox.tsx`）を持つ。保存先はどちらも`POST /api/articles/triage`
（`{ articleIds: string[], decision: "adopt" | "reject" }`、Supabaseセッション認証）。

- **仕分けの状態は専用の列を持たず、#79の`weeklyCandidate`と`reviewedAt`から導出する**
  （`src/lib/triage.ts`の`getTriageState()`）。未判定＝`reviewedAt`が`null`、採用＝人が判断して
  `weeklyCandidate`が`true`、不採用＝人が判断して`false`。AIが対象外と判定して自動で外した記事
  （`reviewedAt`が`null`のまま`weeklyCandidate`が`false`）は「AIが対象外と判定」の未判定として
  出し、人の確認待ちにする。`triageStatus`のような列を足すと`weeklyCandidate`と二重の正になり、
  AIの自動除外（`shouldAutoExcludeFromWeekly()`）との整合を取り直すことになるため採らなかった。
  業界ニュース画面の「週報候補から外す／戻す」は同じ列を切り替える操作なので、文言を
  「採用／不採用」に揃えた（`ArticleAnalysisActions`が`TriageActions`を内包する）
- **不採用は削除ではなく隠すだけ。** 行を消すと`normalizedUrl`の一意制約も消え、翌日の日次収集が
  同じ記事を未判定として登録し直す。「不採用」タブからいつでも戻せる。業界ニュース画面は
  従来どおり不採用（人・AIどちらでも）を既定で隠し、**未判定はそのまま出す**（仕分けが終わる
  まで週報の材料が見えないと困るため）
- **収集の上限を「1回10件・事業ごと週5件」から「1回30件・事業ごと週15件」へ広げた**
  （`src/lib/collection.ts`の`COLLECTION_LIMIT`・`BUSINESS_WEEKLY_LIMIT`）。週あたり上限の
  判定は`decideWeeklyCap()`（`src/lib/triage.ts`、純粋関数で`pnpm test`の対象）に寄せ、
  **不採用の記事は上限に数えず、人が採用した記事は置換で外さない**。数えると無関係な記事が
  枠を埋め続け、上限を広げた意味が無くなる。置き換えてよい記事（未判定）が1件も無ければ新規
  候補を除外する。同一イベント判定（`findEventMatch()`）は不採用の記事も含めて行うため、
  不採用にした発表の転載は不採用の記事へ統合されたまま隠れ、新しい未判定として出直してこない
- RSSの検索語（`FEEDS`）は変えていない。「広め」は上限の緩和によるもので、検索語の拡張は
  別Issueで検討する。AIDE経由の週報登録の入力上限（1回10件・各事業5件）はAIDE側との契約なので
  そのまま
- カード側のチェックは`<input type="checkbox" name="ids">`のままサーバーで描画し、
  `TriageInbox`（クライアント）の`<form onChange>`にバブルしてくる`change`で件数を数え直す。
  選択状態をReactのstateで持たないのは、カードをサーバーコンポーネントのまま保つため。
  チェック中のカードの強調は`.news-card.triage:has(.pick input:checked)`（CSSのみ）
- **「✓ 採用」ボタンで採用した記事のうち、まだ一度もAI解析していないもの（`analysisStatus`が
  `null`）は、`setTriageDecision()`（`src/lib/article-analysis.ts`）が自動で解析ジョブも積む**
  （#154）。採用した記事は週報の材料として扱われるため、「AI解析」ボタンを押し忘れたまま
  週報を作る手戻りを防ぐ。既に解析済み・実行中・失敗済みの記事は対象外（再解析は従来どおり
  手動の「再解析」ボタン）。「✓ 採用」ボタン（`TriageActions`）は新着記事画面
  （1件・まとめての両方）だけでなく、業界ニュース画面（`/dashboard`。`ArticleAnalysisBlock`が
  `ArticleAnalysisActions`経由で内包）・記事詳細画面にも出ており、どれも同じ
  `POST /api/articles/triage`を経由するため、共通の保存関数に判定を寄せている。記事詳細
  画面の「人による確定」フォーム（`AnalysisReviewForm`）経由の採用（`applyHumanReview()`）は
  別の保存経路のため対象外

## アイコン・PWA起動画面・ログイン画面（#46）

初期化時（issue-deck#2247）が置いた単色プレースホルダのアイコンと、暫定のTailwind slateデザインの
ログイン画面を、実際のブランドトークン（`globals.css`の`--navy`/`--teal`/`--paper`）へ揃えた。

- **アイコンはSVGを直接手書きし、PNG化はホストのシステムツール（`rsvg-convert`）で行った。**
  `pnpm-workspace.yaml`の`allowBuilds`に`sharp`が載っているが、これはNext.jsが画像最適化で
  使う任意の依存で`package.json`には現れず、アイコン生成用に新規導入したものではない。
  新規npm依存を増やさずに済むため、SVG→PNGの変換はNext.jsのビルド作業に含めず、リポジトリには
  生成済みのPNGもコミットしている。**#225でブランドを刷新し、原本とPNGは`public/brand/`へ移した**
  （下の「ブランドロゴ・PWAアイコンの刷新（#225）」を参照）
- **起動画面（スプラッシュ）は`src/app/loading.tsx`（App Routerのファイル規約）で実装した。**
  当初はルート直下のこの1枚だけが唯一の`loading.tsx`で、遷移のたびにサイドバーごと全画面が
  これに置き換わっていたが、#73でルートグループ（`(app)`）ごとの`loading.tsx`へ役割を分けた。
  詳細は「ページ遷移中のスケルトン表示（#73）」を参照。Service Worker等によるオフライン対応は
  `guchi-apps/docs`の`standards/tech-stack.md`のとおり必須ではないため、今回は追加していない
- **ログイン画面は`login-shell`/`login-card`等の専用クラスで、トップ画面・業界ニュース画面と
  同じトークンに揃えた。** 元は`bg-slate-950`等のTailwind暫定スタイルで、`src/app/layout.tsx`の
  `body`にも同じくTailwindの`bg-slate-950 text-slate-100`が付いていたため、`globals.css`の
  `body{background:#eef4f1}`（クラスセレクタがタグセレクタより詳細度で勝つ）が上書きされ、
  ブランドの配色ではなく暗い既定色が効いていた。`body`からTailwindの色クラスを外し、
  `globals.css`側の基本配色に一本化した

## ブランドロゴ・PWAアイコンの刷新（#225）

「情報を、仕事へつなぐ。」を表すマーク（記事・写真・メモを表す2枚のカードを、ティールのリレーラインで
つなぐ。オレンジの点は拾い上げた重要情報）へ差し替えた。ブランドカラーはNavy `#1D3440`・
Teal `#087F78`・Orange `#D97735`・Paper `#F7FAF8`・濃色背景用Mint `#70D6BF`。

- **原本は`public/brand/*.svg`、PNGは`scripts/generate-brand-icons.sh`（`rsvg-convert`）で作って
  コミットする。** ビルドやCIでは生成しない。原本は用途ごとに分かれている
  - `icon.svg` … 通常版（角丸つき・角は透明）。`icon-192.png`・`icon-512.png`の元
  - `icon-maskable.svg` … マスク対応版。図形を80%に縮め、円形・角丸クロップの安全域（中心から半径40%）に収める
  - `apple-icon.svg` … iOSホーム画面用。角丸はiOSが掛けるため付けない（二重角丸を避ける）
  - `favicon.svg` … 32px以下向けの簡略版。カード内の本文の線を省き、2枚のカード・流線・起点だけにする
  - `logo-horizontal-light.svg`・`logo-horizontal-dark.svg`・`mark-mono.svg` … 配布用（アプリからは参照しない）
- **原本との差は1点。** Issue添付の原本では2枚のカードが同じ色で接していて、小さいサイズでは1枚の
  塊に見える。手前のカードに背景色のフチ（512座標で12px）を足して重なりを読ませている
- **PNGを旧アイコン（`public/icon-*.png`）と別のURLにした。** インストール済みPWAはmanifestの
  アイコンURLが変わったときに差し替えを検知するため、同じURLのまま中身だけ替えると古いアイコンが
  残りやすい。iOSのホーム画面アイコンは追加時に保存されるため、再追加しないと変わらない
- **アプリ内のマークは`src/components/BrandMark.tsx`がインラインSVGで描く。** 背景の明暗で配色を
  切り替える（サイドバーは濃色用、スマホ上部バー・ログインは明色用、スプラッシュはタイル無し）ため、
  `<img>`では置かない。横長ロゴもSVG内の`<text>`ではなくHTMLの文字で組み、ページと同じフォントにする

## CI撮影の認証バイパス

`24.screenshot-required`向け。`/api/dev/login`にアクセスするとCookieが発行され、`src/proxy.ts`と
`src/lib/auth.ts`の両方がそのCookieを検証する（片方だけだとデータが引けず画面が空になるため対で
実装している）。ダミーデータは `pnpm db:seed:ci`（`prisma/seed-ci.mjs`）で投入する。

## 設定画面（`/settings`, #67）

スマホ幅（767px以下）ではヘッダー右上のログアウトボタンが元々`.user button{display:none}`で
隠れており、アバターも`font-size:0`で非活性表示のままだった（モバイルからログアウトする手段が
実質無かった）。この画面を新設し、アカウント情報（メールアドレス）・ログアウト・更新履歴
（`src/lib/changelog.ts`の`APP_CHANGELOG`。バージョンbump時に自動更新される配列で、それまで
どの画面からも参照されていなかった）をまとめた。

トップ画面・業界ニュース画面・画像を送る画面の3箇所で重複していたヘッダー右上（アバター＋
ログアウト）は`src/components/HeaderUserMenu.tsx`に共通化し、あわせて設定画面への⚙ボタンを
追加した。⚙ボタンは`globals.css`側で`display:none`が既定で、`@media(max-width:767px)`の
中でだけ`display:grid`に切り替える（PC・iPadでは従来どおりアバター＋ログアウトのまま）。
**この⚙ボタンは#80でスマホ用の固定バー（後述）へ移した。**

## スマホのメニュー（#80）

サイドバー（`src/app/(app)/layout.tsx`）は`globals.css`の`@media(max-width:767px)`で
`display:none`にしていたため、**スマホでは画面上のどこからも「画像を送る」（#64）へ
たどり着けなかった。** サイドバーに`📷　画像を送る`のリンクはあり、PC・iPadでは開けていた
ぶん、Issueとしても気づきにくい形で残っていた。iPad（横1180px）は767pxを超えるのでPCと同じ
配置になり、**スマホでだけ導線が消える**。

- **サイドバーは非表示にせず、引き出し（ドロワー）へ切り替える。** `src/components/AppShell.tsx`
  （クライアント）が`app-shell`の外殻を持ち、スマホ幅では`.sidebar`を`position:fixed`＋
  `transform:translateX(-100%)`にして、`.app-shell.nav-open`が付いたときだけ出す。
  `(app)/layout.tsx`はこの外殻を呼ぶだけのサーバーコンポーネントのままで、`children`は
  propsとして渡すので配下の`page.tsx`はサーバー側で描画される（#73の前提を崩さない）
- **ドロワーは上部バーの下（`top:56px`）から出す。** 全高にすると☰／✕がドロワーの下に隠れ、
  開いた後にボタンで閉じられなくなる
- **⚙（設定）と📷（画像を送る）はスマホ専用の固定バーが持つ。** `HeaderUserMenu`は
  PC・iPad向けのアバター＋ログアウトだけになった。バーのリンクは現在の画面と同じ行き先の
  ものを出さない（`/settings`では⚙、`/dashboard/image-mail`では📷を描画しない）
- **左端からの右スワイプでも開く。業界ニュースの週送りスワイプ（#53）と奪い合うため、
  境界を`src/lib/nav-swipe.ts`に置いている。** 週送り（`SwipeWeekNav`）がマウントされる
  `/dashboard`だけ狭い境界（`EDGE_ZONE_PX`＝24px）を使い、それ以外の画面は開きやすさを
  優先して広い境界（`WIDE_EDGE_ZONE_PX`＝48px）を使う（#123。24pxでは指でつかみにくいと
  実機確認で指摘されたが、週送りと取り合う`/dashboard`だけは境界を広げられないため、画面
  ごとに使い分けた）。境界内から始まったスワイプはドロワー、それ以外は週送りが受け取る。
  両方が反応すると「メニューが開きながら前週へ飛ぶ」ことになる。なおiOS Safariでは左端
  スワイプがブラウザの「戻る」と競合し得るため、☰ボタンを確実な導線として必ず併置する
- **境界内の`touchmove`で「横方向のドラッグ」と確定した時点でだけ`event.preventDefault()`を
  呼び、iOS Safariのエッジバック（「戻る」）ジェスチャーを抑える**（#123）。`touchstart`の
  時点で境界内なら即座に`preventDefault()`する実装を最初に試したが、タップ・縦スクロールと
  区別が付かないため、☰ボタンの左側やドロワー内リンク、本文の縦スクロールまで巻き込んで
  押せなくなった（計画レビューで指摘）。`DIRECTION_LOCK_PX`（10px）分動くまでは様子を見て、
  横移動が縦移動を上回った時点で初めて止める。`preventDefault()`を効かせるには`touchmove`の
  リスナー登録を`{ passive: false }`にする必要がある（`touchstart`自体は`passive: true`の
  まま）。この回避策はSafariでは概ね有効だがChrome for iOSでは効果が不安定という報告があり、
  仕様化された挙動ではないため、☰ボタンという確実な代替導線は引き続き必須
- **画面が変わったときの後始末はクリック側で行う。** `usePathname()`の変化を`useEffect`で見て
  `setOpen(false)`する書き方はeslintの`react-hooks/set-state-in-effect`で落ちるため、
  ドロワー内の`<a>`クリックを拾って閉じている

## 画像を社用メールに送る（#64）

`/dashboard/image-mail`は、撮影・選択した写真をブラウザ内でJPEG圧縮・ZIP化し、
`POST /api/image-mail/send`経由でAIDEへ転送する画面。**このIssueはResearch DeskとAIDEの
2リポジトリにまたがるが、実装エージェントは担当リポジトリ以外を編集できないため、AIDE側
（Gmail送信・件名/宛先固定・idempotency処理・履歴記録）は`guchi-apps/aide`へ別Issueとして
切り出した。** Research Desk側は「AIDEへ送信リクエストを送るところまで」が実装範囲で、
AIDE側がマージされるまでエンドツーエンドの送信は動かない。

- **画像圧縮・ZIP化はいずれも追加依存を最小限にしている。** リサイズ・JPEG化は
  `createImageBitmap()` + `<canvas>.toBlob()`というブラウザ標準APIのみで完結し、追加依存は
  ZIP化の`fflate`1つだけ（`src/lib/image-mail-client.ts`）。横幅の自動段階縮小（1200→900→600px）は、
  ZIP作成後のサイズを見てから次の横幅で作り直す素朴なループで、事前見積もりはしない
- **送信APIは`/api/internal/*`と違う認証にしている。** `/api/internal/weekly-report`はAIDE→
  Research Desk方向（共有シークレット）だが、`/api/image-mail/send`はブラウザ→Research Desk
  サーバー方向のため`getCurrentUser()`によるSupabaseセッション認証を使う。Research Desk→AIDE
  方向の送信先設定は`AIDE_IMAGE_MAIL_URL`/`AIDE_IMAGE_MAIL_TOKEN`で、`src/lib/aide-bot-notice.ts`
  （aide-bot＝通知窓口、`AIDE_BOT_*`）とは別のAIDE本体向けの環境変数。名前が紛らわしいので、
  「aide-bot」と「AIDE本体（Gmail送信等を持つ側）」を混同しないこと
- 画像・ZIPはRoute Handler側でもメモリ上のFormDataのまま中継するだけで、ディスク・DBへは
  一切書き込んでいない（受け入れ条件「画像は送信後も保存されない」に対応）

## 共有メニュー・ショートカットからの受け取り（#144）

他のアプリから写真・記事を渡す受け口は`POST /api/share/inbox`の1つだけで、Androidの
共有メニュー（manifestの`share_target`）とiPhoneのショートカットの両方がここを呼ぶ。
ショートカットの作り方は[share-shortcut.md](share-shortcut.md)。

- **iPhoneのホーム画面アプリはWeb Share Targetに対応していない**（2026-09時点）。manifestに
  `share_target`を書いてもiPhoneの共有メニューには出ないため、ショートカットから同じ受け口を呼ぶ。
  **ショートカットの「URLを開く」は必ずSafariで開く**（ホーム画面アプリを開く手段は無い）。
  iOSではSafariとホーム画面アプリのCookieが別なので、Safariでもログインが要る
- **写真はサーバーのメモリにだけ置く**（`src/lib/share-inbox.ts`）。ショートカットはページを開く前に
  写真を送り終える必要があり、URLに載せるには大きすぎるため。#64の「保存しない」方針に合わせ、
  ディスク・DBには書かず、画面が一度受け取るか10分経つと消す。上限は20枚・合計10MB・同時3件で、
  **本番のNodeはヒープ128MB・320MBで再起動**（`deploy/ecosystem.config.js`）なのでこれ以上は
  上げない。PM2がforkの1プロセスであることが前提で、複数プロセスにすると受け取ったプロセスと
  読み出すプロセスが食い違う。**上限は`formData()`で本文を読む前に`Content-Length`でも見る**
  （#172。`isRequestBodyTooLarge()`。合計10MB＋フォームの余白1MBを超えたら413／`shareError=too_large`）。
  `formData()`は本文を全部メモリへ読み込み、さらに`arrayBuffer()`でコピーするため、読んだ後の判定では
  Androidが縮小前の写真をまとめて送ったときに`max_memory_restart`へ近づき、再起動で置き場の他の共有も
  消える。`Content-Length`が無い（チャンク転送）リクエストは判定できず、従来どおり読んだ後の
  `validateSharedFiles()`で断る
- **iPhoneのショートカットは複数枚を1回のリクエストで送れない**（#163）。フォームの「ファイル」
  フィールドは、リストを渡しても先頭の1枚しか送らない（キーを`files[]`にしても同じ）。そのため
  ショートカットは「繰り返す」で1枚ずつ送り、共通の`batch`（まとめ用ID）をフォームに付ける。同じ
  `batch`の写真は`putShareEntry()`が1つの置き場へ追記し、`openUrl`・`id`は最初の1枚で決まった
  ものを返す（`count`は追記後の合計）。20枚・10MBの上限と10分の期限はまとめた単位で守り、期限は
  最初の1枚を置いた時点から数える。上限を超える追記は断り、それまでの写真は残す。`batch`を
  付けない呼び出し（Androidの共有メニュー・既存のショートカット）は従来どおり1回で1つの置き場
- **Service Workerは使わない**（#68の方針のまま）。`share_target`のPOSTはSWで受ける例が多いが、
  サーバーのRoute Handlerが直接受けて303で画面へ飛ばしても動く。写真はメモリの置き場を経由するので、
  ショートカットとAndroidで受け取り側（「画像を送る」）の処理が1つで済む
- **認証は呼び出し元で分ける。** `Authorization`ヘッダーがあればショートカットとみなし、
  `SHARE_SHORTCUT_TOKEN`（未設定なら503）で照合してJSONで`openUrl`を返す。無ければ共有メニューからの
  ページ遷移とみなし、Supabaseのセッションで認証して303で飛ばす（未ログインは`/login`へ。送られた内容は
  失われる）。トークンはスマホに置く値なので、AIDE・ポーラー用のシークレットとは分けている
- 「画像を送る」は表示のたびに`GET /api/share/inbox`を一度呼ぶ。`?shared=`が無くても最新の1件を
  拾うのは、Safariでログインし直してから開いた場合にも写真を読み込むため
- **記事（URL）は「ニュースを送る」へ直接は流し込めない。** あの画面は週単位でDBの記事を選ぶ画面で、
  URLの入力欄が無い。共有された記事は`/dashboard/share`で新着記事へ登録し（`src/lib/shared-article.ts`）、
  「この記事だけ送る」で`/dashboard/news-mail?pick=<記事ID>`を開く。登録は自動収集の週あたり上限・
  同一イベント統合を通さず、人が選んだ記事として「採用」（`reviewedAt`あり）で置き、AI解析を積む。
  ページ本文は取得しない（解析は本文が無くても原典URLから判断する）
- **文章だけの共有（URLを含まない）は、`/dashboard/share`から社用メールへ直接送れる（#149）。**
  記事メール・画像メールと同じ構成で、件名（`[メモ]`固定＋編集可能部分）・本文は
  `src/lib/text-mail.ts`（Prisma非依存の純粋関数、`SharePanel.tsx`のプレビューと
  `POST /api/text-mail/send`の両方から使う）で組み立てる。送る文章はDBに保存されていない
  （URLと違い記事として登録しない）ため、ブラウザが持つ`text`をそのままサーバーへ渡す
  （画像メールの`title`と同じ扱い）。AIDE側の受け口（`POST /api/text-mail/send`）は
  `guchi-apps/aide`へ別Issueとして切り出しており、マージされるまでは502になる
- **`url`パラメータは必ずしもURLとは限らない。** iPhoneのショートカット「ワークリレーへ記事」は
  受け取った入力（URL・Webページ・テキストのいずれでも）を`url=`パラメータへそのまま載せて
  `/dashboard/share`を開く（`docs/share-shortcut.md`）。`normalizeSharedText()`はこれを踏まえ、
  `url`が`isHttpUrl()`で弾かれたときは捨てずに`text`・`rawUrl`の順でURLを探し、見つからなければ
  `rawUrl`自体を文章として採用する（#149で修正するまでは、この経路の文章共有がまるごと
  失われていた）。クエリを介した共有の受け口を増やすときは、パラメータ名と実際に入り得る
  値の形が一致するとは限らないことに注意する

## PWAアップデート通知（#68）

PWAとしてホーム画面から起動されたままだと、ブラウザを再訪しない限り新しいデプロイに
気づけない。`src/components/AppUpdateChecker.tsx`が`/api/app-version`（`package.json`の
`version`を`force-dynamic`＋`no-store`で返すだけのRoute Handler）を10分間隔と
`visibilitychange`復帰時にポーリングし、現在のバージョンと異なれば画面下部にバナーを表示する。

**Service Workerは使わない。** issue-deckも同名の`AppUpdateChecker`コンポーネントを持つが、
アップデート検知にService Workerは使っておらず（`public/sw.js`はPush通知の受信専用）、
同じバージョンポーリング方式を踏襲した。オフライン対応（Service Workerによるキャッシュ）は
`guchi-apps/docs`の`standards/tech-stack.md`のとおり必須ではないため、今回もあわせて導入は
していない。

**issue-deck側と違い、バックグラウンド復帰時に自動リロードはしない。** issue-deckの元実装は
「復帰直後は未保存入力を失う心配がない安全なタイミング」として自動リロードするが、
`/dashboard/image-mail`（#64）は画像選択・件名入力という未保存状態を持つ画面のため、
気づかないうちにリロードされると入力が消える。更新は必ずバナーの「更新する」ボタン経由の
ユーザー操作でのみ行う。今後、フォーム状態を持つ画面を追加する場合も、この前提（自動リロード
なし）を崩さないよう注意する。

## ページ遷移中のスケルトン表示（#73）

`/`・`/dashboard`・`/dashboard/image-mail`・`/settings`の4画面は、当初は各`page.tsx`が
サイドバー込みの`app-shell`全体をそれぞれ描画していた（共通レイアウトが無かった）。そのため
Next.jsのSuspense境界（`src/app/loading.tsx`）がサイドバーごと丸ごと全画面のネイビースプラッシュ
（`SplashScreen`）に置き換えており、遷移のたびに画面全体が一瞬別物に切り替わって見えていた。

- **サイドバーを`src/app/(app)/layout.tsx`（ルートグループ）へ切り出した。** 同期的
  （`await`を含まない）コンポーネントなので遷移時にSuspenseへ引っかからず、配下の`page.tsx`が
  持つ非同期処理（DB取得等）の間もサイドバーは再マウントされない。4画面は`(app)`配下へ移動した
  だけでURLは変わらない（Next.jsのルートグループはURLパスに現れない）
- **各ルートに専用の`loading.tsx`を置き、コンテンツ部分だけをそのページの形に合わせた
  スケルトン（`src/components/skeletons.tsx`）に差し替えた。** Next.jsは最も近い`loading.tsx`を
  使うため、`(app)/dashboard/loading.tsx`のようにネストした`loading.tsx`があれば、より外側の
  `(app)/loading.tsx`はそのサブツリーには使われない
- **`loading.tsx`はクライアント側の`<Link>`遷移だけでなく、`<form method="get">`送信や
  素の`<a>`によるハードナビゲーションでも効く。** Next.jsのストリーミングSSRは、フルページ
  ナビゲーションでも非同期なページ本体の代わりに`loading.tsx`をまず送出し、データが揃い次第
  差し替える。業界ニュース画面のフィルター送信・週送りリンクは元々素の`<a>`/`<form>`だが
  （#73では変更していない）、この仕組みにより移行後もスケルトンが機能する

**#124で新着記事仕分け画面が`/`から`/dashboard/inbox`へ移ったのにともない、専用の`loading.tsx`
（`HomeSkeleton`）もそちらへ移した。** `/`は認証チェック後に`redirect()`するだけになったため、
`(app)/loading.tsx`のフォールバックは行き先（業界ニュース画面）に合わせて`DashboardSkeleton`に
差し替えてある。
- **CSSコメント中に`*/`を構成する文字列（例: `(app)/**/loading.tsx`のような二重引用）を
  書かない。** Turbopackのビルド用CSS最適化がコメントを字句レベルで終端してしまい、
  以降のコメント本文がCSSとして解釈されてビルド警告（`Unexpected token`）になる
  （`pnpm build:ci`で顕在化、`pnpm dev`では気づきにくい）

## 記事のAI解析（ChatGPT / Codex CLI、#79・#86）

収集・登録した記事を、**アプリと同じVPS上のCodex CLI**（`codex login`でChatGPTアカウント認証）に
解析させる。Research DeskのサーバーからOpenAI APIは呼ばない（従量課金ではなくChatGPTの契約枠を
使うため）。実行は定期バッチではなく、画面の「AI解析」「再解析」から積むオンデマンド方式。

### 実行役はVPSに置く（#86）

#79ではサブPCの常駐ポーラーに実行させる前提だったが、**サブPCの`~/.config/systemd/user/`は
Gitで管理できず**（issue-deckの`src/lib/infra-config-repos.ts`に受け口が無い）、動かすには実機での
手作業が要り、リリースしても解析が始まらなかった。VPSにはaide-botが同じユーザーで導入した
Codex CLIがある（guchi-apps/aide-bot#130）ので、ポーラーもそこへ移し、**PM2（`deploy/ecosystem.config.js`の
`research-desk-analysis-worker`）に載せてデプロイで配る**。

- ポーラーはアプリと同じ`.env`を自分で読む（`RESEARCH_DESK_URL`の既定は`http://127.0.0.1:<PORT>`）。
  **PM2は`.env`を読まない**が、`env:`へ共有シークレットを書くと`~/.pm2/dump.pm2`へ残るため、
  スクリプト側で読む
- **共有シークレットが無くてもプロセスを終了させない。** `exit`するとPM2の再起動ループになる。
  値は本番の`.env`へデプロイ時に入るので、入るまで待って次の再起動から動き出す
- `deploy.yml`のPM2差し替えは**アプリとワーカーの両方の名前を挙げて`pm2 delete`する**。
  片方だけだと古いプロセスが残って新しい配布物で起動し直されない

### なぜ専用のジョブキューを新設したか

解析は1件あたり数分かかり、HTTPリクエストの中では完結させられない。またNext.js本体は
ヒープ128MB上限で常駐しており（`deploy/ecosystem.config.js`）、その中でCodexを抱えるのは無理がある。
実行役を別プロセスに分け、状態・重複防止・リースをDBで持つ。

なお汎用のジョブキューは他所にも無い。issue-deckの`DispatchJob`は`repositoryFullName`・`issueNumber`が
NOT NULLの必須列（`activeKey`も`owner/repo#番号`の形）で、**外部アプリが任意のペイロードのジョブを
積む口が無い**。仕組み（ポーラー + Bearer共有シークレット + claim/reportの2エンドポイント）だけを
踏襲し、スキーマは新設した。

### ジョブの流れ

| 経路 | パス | 認証 |
|---|---|---|
| 画面 → サーバー | `POST /api/analysis/jobs` | Supabaseセッション（`getCurrentUser()`） |
| 画面 → サーバー | `POST /api/analysis/review` | 同上 |
| ポーラー → サーバー | `POST /api/internal/analysis/claim` | `ANALYSIS_WORKER_SECRET` |
| ポーラー → サーバー | `POST /api/internal/analysis/report` | 同上 |
| ops-dashboard → サーバー | `GET /api/internal/ai-usage` | `OPS_API_TOKEN` |

**`ANALYSIS_WORKER_SECRET`はAIDE用の`INTERNAL_API_KEY`と別の値にしている。** #86でポーラーが
VPSへ移り、AIDEと同じく`127.0.0.1`からの呼び出しになったが、呼び出し元は別の主体のままで、
片方を失効させてももう片方が止まらないようにするため。どちらも未設定なら素通りではなく503
（`src/lib/internal-auth.ts`）。未設定のあいだポーラーは待機したままで、ジョブは`queued`で残る。

**`GET /api/internal/ai-usage`はops-dashboardの「アプリ別のAI利用」向け**（#243）。記事解析・週の総括・
ニュース収集のCodex CLI呼出回数を、直近24時間・7日間×モデル別に返す（`src/lib/ai-usage.ts`）。
**成功したものだけ数える**（記事解析は`ArticleAnalysis.createdAt`、他2つは`COMPLETED`の`finishedAt`）。
トークン数は持たないので返さない。`model`がnullの行は固定ID`codex`に置換する（ops-dashboardは
空でない文字列でない`model`が1行でもあると応答全体を捨てるため）。`OPS_API_TOKEN`はops-dashboardが全連携先へ送る共通の1本で、1Passwordの参照先はops-dashboardの項目を共用する（AIDE用`INTERNAL_API_KEY`とは別の値）。
未設定なら503。

状態は`queued` / `running` / `completed` / `failed` / `auth_required`の5つ
（`ArticleAnalysisJob.status`）。

- **二重実行はDBで防ぐ。** `ArticleAnalysisJob.activeKey`は`QUEUED`・`RUNNING`の間だけ`articleId`が
  入るUNIQUE列で、終了時に`null`へ戻す（MySQLのUNIQUEはNULLの重複を許す）。アプリ側で「実行中の
  ジョブがあるか」を先に読んでから作る方式だと、PM2の複数プロセスから同時に押されたとき両方が
  「無い」と読んで2本積む
- **落ちたポーラーはリースで回収する。** `claim`時に`leaseExpiresAt`（15分）を入れ、期限切れの
  `RUNNING`は次の`claim`で`QUEUED`へ戻す。戻ったジョブへ遅れて届いた結果は`canAcceptReport()`が
  捨てる（次の実行の結果が正）
- **結果は履歴として積む。** `ArticleAnalysis`は1ジョブ1行で、記事本体（`IndustryInformation`）の
  要約・示唆は上書きしない。画面が使うのはAIの生成内容（`ArticleAnalysis`）と、人が確定した内容
  （記事側の`business`・`importance`・`weeklyCandidate`＋`reviewedAt`）の両方で、区別して表示する
- **対象外（`OUT_OF_SCOPE`）と判定された記事は週報候補から自動で外す**（`weeklyCandidate=false`）。
  ただし人が一度でも確定している記事（`reviewedAt`が入っている）はその判断を優先し、AIの判定で
  書き換えない（`shouldAutoExcludeFromWeekly()`）
- `IndustryInformation.analysisStatus`・`analyzedAt`は最新ジョブの状態を写した**非正規化列**。
  画面の絞り込みをPrismaの`where`で行うために置いてあるので、ジョブの状態を変える処理は
  `src/lib/article-analysis.ts`の同一トランザクション内でここも更新すること

### プロンプトと出力スキーマはサーバーが持つ

`claim`の応答に**プロンプト本文とJSON Schemaを載せて**ポーラーへ渡す（`src/lib/analysis-prompt.ts`）。
ポーラーは受け取った文面を`codex exec`へ流すだけの実行役なので、**解析の観点を変えても
ポーラーのスクリプトを配り直す必要がない。** 構造化出力の制約に合わせ、スキーマは全プロパティを`required`・
`additionalProperties: false`にし、省略可能な項目は`["string","null"]`で表す。

- **キー名を決めないオブジェクト（`{ "type": "object", "additionalProperties": { … } }`）を
  置いてはいけない**（#90）。OpenAIの構造化出力はそのプロパティを`properties`から落としたうえで
  検証するため、**モデルを呼ぶ前に**`Invalid schema for response_format 'codex_output_schema': …
  Extra required key '<そのプロパティ名>' supplied.`という400（`invalid_json_schema`）で落ちる。
  エラー文が「`required`に余計なキーがある」と読めるので、`required`の並びを疑って時間を使いやすい。
  項目名が可変のものは`{ "name": …, "value": … }`の**配列**で受け、保存前にオブジェクトへ畳む
  （`metricsRecord()`）。`buildOutputSchema()`にキーを固定しないオブジェクトが混ざっていないことは
  `src/lib/analysis-prompt.test.ts`が機械的に確かめている
- スキーマを変えたら、実機のCodex CLIへ流して400にならないことを確かめる。1件だけなら次で済む

  ```bash
  env -u OPENAI_API_KEY codex exec --sandbox read-only --skip-git-repo-check --ephemeral \
    --color never --output-schema <schema.json> -o <result.json> -C <tmpdir> - <<< 'テスト。スキーマどおりのJSONだけを返してください。'
  ```

ポーラーが叩くコマンドは次の形（`scripts/codex-analysis-worker.mjs`）。

```bash
codex exec --sandbox read-only --skip-git-repo-check --ephemeral --color never \
  -c tools.web_search=true --output-schema <schema.json> -o <result.json> -C <tmpdir> -
```

- **`codex exec`は`--search`を受け付けない**（`codex --help`には出るが`codex exec --help`には無い）。
  関連情報の追加調査でWeb検索を使うには`-c tools.web_search=true`で設定を上書きする
- **`--output-schema` + `-o <FILE>`で受け取る。** 標準出力をパースすると進捗表示が混ざったときに
  壊れるため、最終応答だけをファイルへ書かせて読む
- **プロンプトは引数ではなく標準入力から渡す**（`-`）。記事本文がプロセス一覧（`ps`）に出ないため

### 認証方式の検知

Codexの認証方式は`~/.codex/auth.json`の`auth_mode`で判定する（`codex login status`の文言に依存しない）。
ChatGPTアカウント認証なら`auth_mode`が`chatgpt`・`OPENAI_API_KEY`が`null`。

- ポーラーは子プロセスの環境から**`OPENAI_API_KEY`を必ず削除**してから`codex`を起動する
- 報告された`codexAuthMode`が`chatgpt`以外なら、実行が成功しうる状態でも`auth_required`として
  止める（`classifyFailure()`）。APIキー認証へ切り替わったまま従量課金で回り続けるのを防ぐため
- 画面上部の実行環境ストリップ（`AnalysisStatusStrip`）に認証方式・最終応答・キュー件数を出す

失敗の分類（ログイン切れ／利用枠到達／出力不正／実行失敗／時間切れ）は**サーバー側の
`src/lib/analysis-job-rules.ts`**が行い、ポーラーは終了コードと標準エラーの末尾だけを送る。
判定条件をサーバーへ寄せてあるため、単体テスト（`pnpm test`）で確かめられる。

### VPS側の常駐（PM2）

ポーラー本体はこのリポジトリの`scripts/codex-analysis-worker.mjs`（追加依存なし・Nodeのみ）。
`deploy.yml`が配布物へ含め、`deploy/ecosystem.config.js`の2つ目のアプリとしてPM2が常駐させる。
**このリポジトリのリリースだけで解析が動き始める**（サブPCでの設置作業は要らない）。

| 名前 | 役割 |
|---|---|
| `research-desk` | Next.js本体（ポート3115） |
| `research-desk-analysis-worker` | 解析ポーラー。`scripts/codex-analysis-worker.mjs` |

前提はVPSにCodex CLIが入っていて、**PM2を動かしているユーザーで**ChatGPTアカウントに
ログイン済みであること（aide-botが同じ形で使っている。guchi-apps/aide-bot#130）。
`codex`はnpmのグローバル導入でnodeと同じbinディレクトリに居るため、PM2へは`pm2 start`した
シェルの`PATH`を渡している。別の場所にある場合は`.env`の`CODEX_BIN`に絶対パスを書く。

運用時の確認手順（VPS上）。

```bash
pm2 describe research-desk-analysis-worker      # status が online であること
pm2 logs research-desk-analysis-worker --lines 30 --nostream
jq -r .auth_mode ~/.codex/auth.json             # `chatgpt` であること（機械判定はこちら）
codex login status                              # 人が読む用。`Logged in using ChatGPT`
```

画面上部の実行環境ストリップにも、認証方式・最終応答・待ち件数が出る。

### DBに繋がない単体テスト（`pnpm test`）

`node --test 'src/**/*.test.ts'`。Node 24が型を剥がしてTypeScriptのまま実行するため、テスト用の
依存もビルド手順も要らない（`tsconfig.json`の`allowImportingTsExtensions`は、テストが`./x.ts`と
拡張子つきでimportするため）。**テストから読めるのはPrismaに触れないモジュールだけ**なので、
ジョブの判定ルールは`src/lib/analysis-job-rules.ts`へ、プロンプトと結果検証は
`src/lib/analysis-prompt.ts`へ分けてある。DBを伴う挙動（実際の重複投入・リース回収）は
本番相当のDBが無いローカルでは確かめられないため、コードレビューでの突き合わせに留めている。

## 業界ニュースを週報メールで送る（`/dashboard/news-mail`, #110）

選んだ週の記事にチェックを付け、AIのまとめを添えて**1通の図解つきメール**を社用アドレスへ送る
画面。送信経路は画像メール（#64）と同じで、Gmail送信・宛先/BCCの固定・二重送信の防止はAIDE側が
担い、Research Desk側は「AIDEへ送信リクエストを送るところまで」を持つ。環境変数は
`AIDE_NEWS_MAIL_URL`／`AIDE_NEWS_MAIL_TOKEN`（画像メールとは別のトークンにしてある。片方を
失効させてももう片方が止まらないようにするため）。**AIDE側の受け口が入るまでエンドツーエンドの
送信は動かない**（別Issueで切り出し済み）。

### 週の対象は「公開日」だけで決めない

業界ニュース画面（`/dashboard`）は公開日基準（`weekCondition()`）だが、週報メールでは
**公開が前の週でも、その週に取得した記事**を送りたい。そのため画面に「対象の取り方」を置き、
`src/lib/industry-information.ts`の`weekConditionByBasis()`で切り替える。

| `?basis=` | 条件 |
|---|---|
| `published` | 従来どおり公開日→発生日→収集ランの重なり（`weekCondition()`） |
| `collected` | `collectedAt`がその週（`collectedWeekCondition()`） |
| `either` | 上の2つの和。**この画面の既定** |

一覧・メール本文の「取得のみ」の札は`src/lib/news-mail.ts`の`isCollectedOnly()`が付ける。
公開日（無ければ発生日）が週の外で収集日が週の中にある記事という**表示上の目印**で、
DB側の絞り込み条件を厳密に写したものではない（どちらの日付も無い記事は元々収集日で週が
決まるため「取得のみ」とは呼ばない）。既定の週は**先週**（`DEFAULT_WEEK_OFFSET = -1`）で、
週明けに先週ぶんをまとめて送る使い方を前提にしている。

### 本文はサーバーが組み立て、プレビューは同じ関数を呼ぶ

`src/lib/news-mail.ts`はPrisma・Reactに触れない純粋なモジュールで、件名・HTML本文・テキスト本文を
作る。**画面のプレビューと送信APIが同じ`buildNewsMailHtml()`を呼ぶ**ので、見えている内容と
実際に送る内容が食い違わない。ブラウザから受け取るのは「どの記事を送るか」と件名だけで、
本文のHTMLは受け取らない（任意のHTMLを送れる口を作らないため）。差し込む値はすべて
`escapeHtml()`を通し、`href`は`https?:`で始まるURLだけを通す。

HTMLは**tableとインラインスタイルだけ**で組む。Gmailは`<style>`の一部やflex/gridを落とすため。
事業別の件数バーも画像ではなく幅を指定したtableのセルで描く——画像はGmailの初期表示で
ブロックされることがあり、その場合に図が丸ごと読めなくなる。**`style`属性はダブルクォートで
囲むので、`font-family`のフォント名はシングルクォートで書く**（ダブルのままだと属性がそこで
閉じ、以降のHTMLが壊れる）。

日付の整形と週の区切りは`src/lib/jst-week.ts`へ切り出した。週報メールの本文組み立てが
**Prismaを読めない場所（`node --test`とブラウザ）**から同じ関数を使う必要があるため。
`industry-information.ts`は従来と同じ名前で再エクスポートしているので、既存の呼び出し側は
変わらない。**`pnpm test`から読むモジュールは`@/`エイリアスではなく相対パス＋拡張子で
importする**（`@/`はtsconfigの`paths`で、Nodeの実行時解決には効かない）。

### 週の総括（AI）は既存のポーラーに相乗りする

「週の総括」は`WeeklyBriefJob`（`src/lib/weekly-brief.ts`）に積み、**記事解析（#79）と同じ
VPS常駐ポーラー**（`scripts/codex-analysis-worker.mjs`）が実行する。ポーラーが読むのは
`jobId`・`prompt`・`outputSchema`だけなので、`/api/internal/analysis/claim`の応答へ総括ジョブを
混ぜ、`/report`をジョブIDで振り分けるだけで動く——**ポーラーのスクリプトは変更していない。**

- **テーブルは`ArticleAnalysisJob`と分けた。** あちらの`articleId`はNOT NULLで記事側の
  `analysisStatus`とも連動しており、nullableにして相乗りさせると記事解析側の前提（claim時の
  状態更新・リース回収・二重実行防止）が広く崩れる
- 二重実行の防止・リース回収の作りは記事解析と同じ（`activeKey`のUNIQUE、`leaseExpiresAt`）。
  `activeKey`には**週の開始日時**を入れるので、同じ週の総括は同時に1本だけになる
- **記事の解析を優先し、余った枠でだけ総括を取る**（`claimAnalysisJobs()`）。総括は1回あたり
  数分かかるため、先に取ると仕分け待ちの記事解析が後回しになる
- 結果は1ジョブ1件なので別テーブルを作らず同じ行に持つ（`headline`・`overview`・`topics`）
- 画面は総括が`QUEUED`／`RUNNING`の間だけ30秒ごとに`router.refresh()`する。**総括が無くても
  送信はできる**（その場合はメール本文からその節ごと落ちる）

## 業界ニュースの自動収集ジョブ（Codex CLI・Web検索、#189）

これまでChatGPTの定期タスクが毎日20:00に直近7日分を検索・選定・要約し、AIDE経由で
`POST /api/internal/weekly-report`へ登録していた。その作業を、記事解析（#79）・週の総括（#110）と
**同じVPS常駐ポーラー**（`scripts/codex-analysis-worker.mjs`）へ移した。RSS収集（題名だけを拾う
`runDailyCollection()`）は残しており、代替ではなく別経路。

```
日次cron → POST /api/collection/daily → RSS収集 ＋ 収集ジョブを積む（CollectionSearchJob）
VPSのポーラー → claim（kind: "collection_search"）→ codex exec ＋ Web検索 → report
              → parseCollectionSearchPayload() → importWeeklyReport() → CollectionRun・記事
```

- **ChatGPT定期タスクは止めていない。当面は併用して品質を見比べる**（ユーザー方針）。そのため
  収集のプロンプトには既登録の記事を渡さず、両者が独立に選んだ結果を比べられるようにしてある
  （重複はURL一致と同一イベントの統合＝#43が取り込み側で処理する）。件数の上限も週報登録API
  （全体10件・各事業5件）に揃えた。比べる材料は解析状況画面の「自動収集」欄（Codexが返した件数・
  新規・統合更新・既存と重複・上限で除外・読めず除外）
- **取り込みは`importWeeklyReport()`をそのまま呼ぶ**。結果の形（`src/lib/collection-search-prompt.ts`の
  `CollectedArticle`）を`WeeklyReportArticle`に揃えてあるので、冪等性・統合・週あたり上限・
  `CollectionRun`への記録はAIDE経由の登録と同じ規則で働く。**取り込んでからジョブを完了にする**——
  途中で落ちてもリース切れで積み直され、再取り込みはURL一致で二重登録にならない
- **`CollectionSearchJob`は`ArticleAnalysisJob`・`WeeklyBriefJob`と別テーブル**。理由は総括と同じ
  （記事解析のテーブルは`articleId`必須で記事側の`analysisStatus`と連動する）。`activeKey`にJSTの日付を
  入れ、同じ日の収集が待ち・実行中の間は積まない（UNIQUE制約。終了時にnullへ戻すので完了後の再実行は可）
- **実行の優先順は 記事の解析 → 週の総括 → 収集**（`claimAnalysisJobs()`）。収集は定期実行で、
  人が結果を待っていないため、余った枠でだけ取る。期限切れの回収は枠に関わらず毎回行う
- **ポーラーはジョブごとの実行上限を読む**。claimの応答の`timeoutSeconds`（収集は780秒）があれば
  それに従い、無ければ`ANALYSIS_JOB_TIMEOUT_SECONDS`（既定600秒）。**保持期限（`LEASE_SECONDS`＝900秒）
  より短くしておくこと**——超えると実行中にリースが切れ、別のポーラーが同じジョブを取り直す
  （`collection-search-prompt.test.ts`が大小関係を確かめる）。ポーラーのスクリプトを変えたので、
  この変更のデプロイでワーカーも入れ替わる（`deploy.yml`の`pm2 delete`が両方の名前を挙げている）
- 積むのは`POST /api/collection/daily`の**先頭**（RSS収集より前）。RSS収集が例外で落ちても収集ジョブは
  積まれ、積めなくてもRSS収集の結果は成功のまま返す（応答の`collectionSearch`は`queued`・
  `already_queued`・`failed`）。**新着通知（`notifyNewCandidates()`）は収集ジョブの取り込みでも送る
  （#216）。** cron起点のRSS収集完了時（`/api/collection/daily`）と同じ週のdedupeKeyで上書きするため、
  同じ週に両方が完了しても通知は1件にまとまる。**0件でも完了を通知する**——収集そのものが動いたことを
  AIDE Bot経由で確認できるようにするため、Issue #216の要件どおりRSS収集と揃えた。AIDE経由の週報登録
  （`importWeeklyReport()`単体を呼ぶ`/api/internal/weekly-report`）は今回も呼んでいない
- **結果の検証は寛容側に倒す**。記事の必須項目（事業・題名・URL・媒体名）が欠けた要素、`http(s)`以外のURL、
  512文字を超えるURL（`normalizedUrl`に収まらず登録で例外になる）は落として続ける。返ってきた記事が
  1件以上あるのに**1件も読めなかった**ときだけ`INVALID_OUTPUT`にする（形が壊れている可能性が高く、
  0件の成功と区別が付かなくなるため）。**0件は成功**（該当が無い日はありうる）
- スキーマは`{ name, value }`の配列で数値を受ける（#90。キー可変のオブジェクトは置けない）。
  失敗の分類（時間切れ・ログイン切れ・利用枠・出力不正）は記事解析と同じ`classifyFailure()`

**収集プロンプトの初期値はaideの`docs/chatgpt-mcp.md`の指示例（事業ごと5件・7日→30日拡張・示唆と数値の
付与）と、記事解析と共通の事業の観点（`DELIVERY_SCOPE`・`LOCKER_SCOPE`）から組んだもの。** ChatGPT側で
実際に使っているプロンプトが手に入ったら`buildCollectionSearchPrompt()`を差し替える。

### 検索・判定基準は事業ごとに、不採用記事と利用者の指示から更新する（#211で事業別化）

`CollectionSearchPolicy`はAIが使う検索・採用／不採用の判定基準を事業（`business`＝`DELIVERY`／`LOCKER`）ごとに
1件ずつ保持する（主キーは`business`。#206時点はid固定1件のグローバル単一だった）。設定画面では事業ごとに
基準・最終更新日時のカードを表示し、利用者は事業ごとに不自然な検索結果を文章で指示する。次の収集ジョブは、
その指示と人が不採用にした直近10件の記事題名（事業ごとに絞り込み）をプロンプトへ渡し、Codexが返す
`nextPolicyDelivery`・`nextPolicyLocker`をそれぞれの事業の基準として次回用に保存する。利用者が個別の除外語句を
管理するのではなく、語句では表せない不採用の傾向もAIが基準へ整理する。

**#206→#211の移行では、既存の1件の基準文を両事業の初期値としてそのまま複製する**
（`prisma/migrations/20260922130000_collection_search_policy_per_business/migration.sql`）。
`collection_search_policy`テーブルの主キー変更（`id`固定1→`business`）はデータ移行を伴うため、
`prisma migrate diff`の自動生成に頼らず手書きした。**複製行の`INSERT`では`id`列に明示的に
別の値（`2`）を指定する必要がある**——この時点では`id`列がまだ主キーのまま（`DEFAULT 1`）残っており、
`id`を指定せずに`INSERT`すると複製行にも`id=1`が入り、既存行と主キー重複で失敗する
（`ALTER TABLE ... DROP PRIMARY KEY, DROP COLUMN id`より前に複製行を作るとこの順序依存が起きる）。

### 検索キーワードの表示（#211）

判定基準（AIが採用／不採用を判断する自然文の基準）とは別に、**検索そのものに使うキーワード・観点は
コードにハードコードされておりAI・利用者どちらからも変更できない。** 設定画面には、事業ごとの判定基準
カードの下に、変更できないものとして次を表示する。

- RSS収集（`runDailyCollection()`）が使う検索クエリ（`src/lib/collection.ts`の`FEEDS`。`query`フィールドを
  画面表示にも流用し、`url`はそこから組み立てる）
- 収集ジョブ・記事解析が共通で使う「対象範囲」の語句（`src/lib/analysis-prompt.ts`の`DELIVERY_SCOPE`・
  `LOCKER_SCOPE`）

「判定基準」（採用可否の傾向）と「検索キーワード／対象範囲」（何を検索するかの切り口）は別の層であり、
前者だけがAIによる自動調整・利用者からの指示の対象になる。この二層構造は#206の時点から変わっていない。

## 解析状況画面（`/dashboard/analysis`, #137）

業界ニュース画面上部の「ChatGPT 解析」の帯（`AnalysisStatusStrip`）は、帯全体がこの画面への
リンクになっている（解析状況画面自身に置くときだけ`linked={false}`でリンクにしない）。画面は
`getAnalysisQueueDetail()`（`src/lib/article-analysis.ts`）の結果を、解析中・待ち・要対応・最近完了・
実行環境・今日の実績に分けて出し、`AutoRefresh`（`router.refresh()`）で15秒ごとに読み直す。
タブが裏にある間は読み直さない。

- **待ちの並びはポーラーが実際に取る順にする**（`orderQueue()`、`src/lib/analysis-queue-view.ts`）。
  `claimAnalysisJobs()`は記事を古い順に取り、余った枠でだけ週の総括（`WeeklyBriefJob`）を取るため、
  積んだ時刻が早い総括でも、待っている記事の後ろへ回す。積んだ時刻の順に混ぜて並べると、
  1番上の総括がいつまでも始まらないように見える
- **「要対応」と帯の「失敗」「認証待ち」は、記事の最新状態（`IndustryInformation.analysisStatus`）で
  数える。** #137より前の帯は`ArticleAnalysisJob`の`FAILED`の件数を数えていたため、再解析で直った
  記事の過去の失敗まで積み上がり続けていた
- **帯の「待ち」「実行中」は週の総括も含めて数える**（`briefQueued`・`briefRunning`を合算）。
  `AnalysisOverview`の`queued`・`running`自体は記事の解析だけのまま残している——週報メール画面
  （`NewsMailPanel`の`analysisQueue`）が「総括より先に走る記事の数」として使っているため
- **期限切れの「解析中」はポーラー停止のサイン。** 期限切れのジョブを待ちへ戻す
  `releaseExpiredLeases()`はポーラーの取得の中でしか呼ばれないため、期限を過ぎても`RUNNING`の
  ままなのはポーラーが取りに来ていないときだけ。画面では「期限切れ（ポーラー停止の可能性）」と出す
- 表示用の計算（経過時間・期限までの残り・JSTの今日0時など）はPrismaをimportしない
  `src/lib/analysis-queue-view.ts`に置き、`node --test`で確かめている
- **右カラムの「自動収集」欄は、待ち・実行中・要対応の並び（`orderQueue()`）とは切り離している**（#189）。
  収集ジョブ（`CollectionSearchJob`）は直近5回を`listRecentCollectionSearchJobs()`で別に読み、状態・所要時間・
  取り込みの内訳を出す。記事の解析キューと混ぜると、`QueueItem`の`kind`と並び順の前提が広がるため

## 新着記事のPush通知（#231）

日次収集（`POST /api/collection/daily`）で新規記事（`insertedCount`>0）が入った日に、購読済みの端末へ
Web Pushで「今日の新着記事がN件あります」を送る。0件の日は送らない。タップで`/dashboard/inbox`を開く。

- **`web-push`＋VAPID＋Service Worker（`public/sw.js`）。** issue-deckと同じ方式。SWは`push`表示と
  `notificationclick`だけで、`fetch`は扱わない（#68の方針のまま）。登録するのは設定画面の
  `PushToggle`だけ。`src/proxy.ts`のmatcherは`/`と`/dashboard`配下だけなので`/sw.js`は素通し
- **購読は`PushSubscription`（`push_subscriptions`）に端末ごと1行。** ユーザーとの紐付けは持たない
  （許可リストの本人だけがログインできるため）。`endpoint`で一意。Push serviceが404/410を返した
  購読は送信時に削除し、5xxなど一時的な失敗は残す（`isSubscriptionGone()`）
- **環境変数は`VAPID_PUBLIC_KEY`・`VAPID_PRIVATE_KEY`・`VAPID_SUBJECT`の3つ。** 揃っていなければ
  設定画面は「準備待ち」を表示し、収集は通常どおり成功する。鍵は`npx web-push generate-vapid-keys`で
  作って1Passwordの`research-desk`アイテムへ入れ、`sync-secrets`で同期する。**鍵を作り直すと既存の
  購読はすべて無効になる**（各端末でオンにし直す）
- **通知の送信失敗は収集の成否に影響させない。** `notifyNewArticlesPush()`は例外を握り、既存の
  aide-bot通知（`notifyNewCandidates()`）とは独立して動く
- iPhoneはホーム画面に追加したアプリ（iOS 16.4以降）でのみ受け取れる
- 判定ロジックはPrisma非依存の`src/lib/push-rules.ts`に置き`pnpm test`で検証する

## バンプPRの自動マージ（#238）

バージョンbump PR（`release/vX.Y.Z` → `develop`）は、`release-develop-to-main.yml`が呼ぶ共有workflowが
PR作成直後に`gh pr merge --auto --merge`を実行して、CI通過後に自動マージさせる。マージでpackage.jsonの
versionが変わると、pushトリガーでdevelop→mainのPRが自動作成される。

- **前提は`develop`のブランチ保護。** GitHub Auto-mergeは必須ステータスチェックが無いブランチでは
  「既にマージ可能」として有効化を断られる（`Pull request is in clean status`）。v1.16.0のバンプPR（#236）は
  これでCI完了後も約23分手動マージ待ちになった
- 設定値（dayspan・issue-deckと同じ）: 必須チェック`lint-and-build`・strict=false・enforce_admins=false・
  レビュー必須なし・force push/削除禁止。`main`は別途ruleset（`protect main`）で保護している
- 確認: `gh api repos/guchi-apps/work-relay/branches/develop/protection`
