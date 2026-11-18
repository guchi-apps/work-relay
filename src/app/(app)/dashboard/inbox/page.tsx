import { redirect } from "next/navigation";
import { parseTriageParam } from "@/lib/triage";

// 新着記事画面は業界ニュースのタイムライン（`/dashboard`）へ統合した（#476）。Push通知・ブックマーク
// など既に配られたURLを壊さないよう、開いていた仕分けタブのまま業界ニュースへ転送する。
export default async function InboxPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const triage = parseTriageParam((await searchParams).triage);
  redirect(`/dashboard?triage=${triage}`);
}
