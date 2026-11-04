import { isForeignLanguageTitle, isSummaryUntranslated } from "@/lib/article-language";

/** 題名が外国語の記事に付ける「英語」バッジ（#394）。新着記事画面と業界ニュース画面で共通。 */
export function ForeignTitleBadge({ title }: { title: string }) {
  return isForeignLanguageTitle(title) ? <span className="chip lang">英語</span> : null;
}

/** 要約が日本語になっていない記事に出す注意書き（#394）。 */
export function UntranslatedSummaryNote({ summary }: { summary: string | null }) {
  return isSummaryUntranslated(summary) ? <p className="summary-note">要約が日本語になっていません。内容は「元記事」で確認してください。</p> : null;
}
