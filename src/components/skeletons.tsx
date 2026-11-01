// ページごとの`loading.tsx`から使うスケルトン。中身の形（見出し・カード枚数）はそのページの
// 実際のレイアウトに寄せてあり、レイアウト自体（サイドバー）は`(app)/layout.tsx`が別途保持する
// ため、ここでは`<section className="content">`の中身だけを描画する（#73）。
function Bar({ width, height = 12, className = "" }: { width: number | string; height?: number; className?: string }) {
  return <div className={`sk ${className}`} style={{ width, height }} />;
}

// `breadcrumb`は見出し左上のナビゲーションリンク（`.breadcrumb`）用、`ctaWidth`は`.top-actions`側
// （ユーザーメニュー等）用。そのページの実際のヘッダーに無い要素は渡さない（#131）。
function HeaderSkeleton({ breadcrumb = false, ctaWidth }: { breadcrumb?: boolean; ctaWidth?: number }) {
  return (
    <>
      {breadcrumb && <Bar width={130} height={11} className="sk-breadcrumb" />}
      <header className="page-header">
        <div>
          <Bar width={110} height={10} className="sk-eyebrow" />
          <Bar width={190} height={22} className="sk-title" />
        </div>
        {ctaWidth !== undefined && <Bar width={ctaWidth} height={34} className="sk-cta" />}
      </header>
    </>
  );
}

// `.news-card`・`.news-head`・`.badge-col`は実データ表示用の既存クラス（globals.css）を
// そのまま流用し、中身だけをバーに差し替える。
function NewsCardSkeleton({ lines = 2 }: { lines?: number }) {
  return (
    <article className="news-card">
      <div className="news-head">
        <div style={{ flex: 1 }}>
          <Bar width="88%" />
          <Bar width="64%" />
        </div>
        <div className="badge-col">
          <Bar width={52} height={16} className="sk-badge" />
        </div>
      </div>
      {Array.from({ length: lines }, (_, index) => <Bar key={index} width={index === lines - 1 ? "46%" : "80%"} />)}
    </article>
  );
}

export function HomeSkeleton() {
  return (
    <section className="content">
      <HeaderSkeleton breadcrumb ctaWidth={100} />
      <Bar width="100%" height={42} className="sk-weeknav" />
      <Bar width="100%" height={44} className="sk-weeknav" />
      <NewsCardSkeleton />
      <NewsCardSkeleton />
      <NewsCardSkeleton lines={1} />
    </section>
  );
}

export function DashboardSkeleton() {
  return (
    <section className="content">
      <HeaderSkeleton ctaWidth={140} />
      <Bar width="100%" height={38} className="sk-weeknav" />
      <Bar width="100%" height={96} className="sk-keypoints" />
      <div className="sk-filters">
        <Bar width={110} height={35} />
        <Bar width={110} height={35} />
        <Bar width={110} height={35} />
        <Bar width="100%" height={35} />
        <Bar width={90} height={35} />
      </div>
      <NewsCardSkeleton />
      <NewsCardSkeleton />
    </section>
  );
}

// 記事詳細（#79）。本文側の解析パネルと右の確定パネルの2カラムに形を寄せる。
export function ArticleDetailSkeleton() {
  return (
    <section className="content">
      <HeaderSkeleton ctaWidth={110} />
      <div className="detail-grid">
        <div className="detail-main">
          <div className="panel">
            <Bar width={120} height={16} />
            <Bar width="100%" height={78} />
            <Bar width="92%" />
            <Bar width="74%" />
          </div>
        </div>
        <div className="detail-side">
          <div className="side-panel">
            <Bar width={100} height={16} />
            <Bar width="100%" height={34} />
            <Bar width="100%" height={34} />
            <Bar width="100%" height={38} />
          </div>
        </div>
      </div>
    </section>
  );
}

export function ImageMailSkeleton() {
  return (
    <section className="content">
      <HeaderSkeleton breadcrumb ctaWidth={90} />
      <div className="imgmail-card">
        <Bar width="100%" height={42} />
        <Bar width="100%" height={120} />
        <Bar width="40%" height={35} />
      </div>
    </section>
  );
}

export function SettingsSkeleton() {
  return (
    <section className="content">
      <HeaderSkeleton breadcrumb />
      <div className="settings-card">
        <Bar width={90} height={16} />
        <Bar width="60%" />
        <Bar width="100%" height={48} />
      </div>
      <div className="settings-card">
        <Bar width={90} height={16} />
        <Bar width="60%" />
        <Bar width="100%" height={70} />
      </div>
    </section>
  );
}

// 解析状況画面（#137）。左に一覧のパネル、右に実行環境のパネルを置く実際の配置に寄せる。
export function AnalysisStatusSkeleton() {
  return (
    <section className="content">
      <HeaderSkeleton breadcrumb />
      <Bar width="100%" height={42} className="sk-weeknav" />
      <div className="q-grid">
        <div className="q-col">
          <div className="q-panel"><Bar width={90} height={16} /><Bar width="86%" /><Bar width="70%" /></div>
          <div className="q-panel"><Bar width={90} height={16} /><Bar width="80%" /><Bar width="74%" /><Bar width="62%" /></div>
        </div>
        <div className="q-col">
          <div className="q-panel"><Bar width={90} height={16} /><Bar width="100%" height={120} /></div>
        </div>
      </div>
    </section>
  );
}
