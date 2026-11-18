import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";

// ログイン後の初期画面は業界ニュース（`/dashboard`、#124）。旧「新着記事」仕分け画面は
// `/dashboard/inbox`に移設したのち、#476で業界ニュースへ統合した。`/`は認証チェックだけ行い、そのまま`/dashboard`へ渡す
// （未ログイン時のフォールバック遷移先やPWAのstart_urlも`/dashboard`に揃えてあるため、
// 実際にこの経路を通るのはブックマーク等で`/`を直接開いた場合だけ）。
export default async function Home() {
  const user = await getCurrentUser();
  if (user.status === "unavailable") return <section className="content"><div className="empty-state"><p>認証状態を確認できませんでした。しばらくしてから再読み込みしてください。</p></div></section>;
  if (user.status === "unauthenticated") redirect("/login");
  redirect("/dashboard");
}
