import Link from "next/link";
import { redirect } from "next/navigation";
import HeaderUserMenu from "@/components/HeaderUserMenu";
import SharePanel, { type ExistingArticleView } from "@/components/SharePanel";
import { getCurrentUser } from "@/lib/auth";
import { getBusinesses } from "@/lib/businesses";
import { buildNewsMailPickPath, fallbackArticleTitle, normalizeSharedText } from "@/lib/share-inbox";
import { findArticleByUrl } from "@/lib/shared-article";

export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * 共有された記事・文章の画面（#144）。
 *
 * Androidの共有メニュー（`POST /api/share/inbox`からの303）と、iPhoneのショートカット
 * 「ワークリレーへ記事」の両方がここを`?url=&title=&text=`で開く。写真は「画像を送る」へ回るので
 * ここには来ない。
 */
export default async function SharePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getCurrentUser();
  if (user.status === "unavailable") return <section className="content"><div className="empty-state"><p>認証状態を確認できませんでした。しばらくしてから再読み込みしてください。</p></div></section>;
  if (user.status === "unauthenticated") redirect("/login");

  const params = await searchParams;
  const shared = normalizeSharedText({ title: first(params.title), text: first(params.text), url: first(params.url) });
  const existingRow = shared.url ? await findArticleByUrl(shared.url) : null;
  const existing: ExistingArticleView | null = existingRow
    ? {
        id: existingRow.id,
        title: existingRow.title,
        sourceName: existingRow.sourceName,
        collectedAtIso: existingRow.collectedAt.toISOString(),
        analysisStatus: existingRow.analysisStatus,
        triage: existingRow.triage,
        pickPath: buildNewsMailPickPath(existingRow.id, existingRow.publishedAt ?? existingRow.collectedAt, new Date()),
      }
    : null;

  const heading = shared.url ? "共有された記事" : "共有された文章";

  return (
    <section className="content">
      <Link className="breadcrumb" href="/dashboard/inbox">
        ‹　新着記事へ
      </Link>
      <header className="page-header">
        <div>
          <p className="eyebrow">SHARED FROM OTHER APPS</p>
          <h1>{heading}</h1>
          <p className="lead">他のアプリの共有メニューから受け取りました。新着記事に追加すると、AI解析のあと「ニュースを送る」に並びます。</p>
        </div>
        <div className="top-actions">
          <HeaderUserMenu />
        </div>
      </header>
      <SharePanel businesses={await getBusinesses()} url={shared.url} text={shared.text} defaultTitle={fallbackArticleTitle(shared)} existing={existing} />
    </section>
  );
}
