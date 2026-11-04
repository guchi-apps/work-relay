import Link from "next/link";
import { redirect } from "next/navigation";
import HeaderUserMenu from "@/components/HeaderUserMenu";
import TextMailBlock from "@/components/TextMailBlock";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** 思いついたメモを書いて、そのまま社用メールへ送る画面（#393）。送信は`POST /api/text-mail/send`（#149）を共用する。 */
export default async function MemoPage() {
  const user = await getCurrentUser();
  if (user.status === "unavailable") return <section className="content"><div className="empty-state"><p>認証状態を確認できませんでした。しばらくしてから再読み込みしてください。</p></div></section>;
  if (user.status === "unauthenticated") redirect("/login");

  return (
    <section className="content">
      <Link className="breadcrumb" href="/dashboard">
        ‹　業界ニュースへ戻る
      </Link>
      <header className="page-header">
        <div>
          <p className="eyebrow">SEND TO EMAIL</p>
          <h1>メモを社用メールに送る</h1>
          <p className="lead">思いついたことを書いて、AIDE経由で社用メールへ即時送信します。メモはワークリレーには保存されません。</p>
        </div>
        <div className="top-actions">
          <HeaderUserMenu />
        </div>
      </header>
      <div className="share-card">
        <TextMailBlock text="" editable />
      </div>
    </section>
  );
}
