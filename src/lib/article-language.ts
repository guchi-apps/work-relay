/**
 * 記事の言語判定（#394）。DB・Prismaに触れない純粋な関数だけを置く。
 *
 * 新着記事画面・業界ニュース画面で「外国語の記事か」「要約が日本語になっているか」を出し分けるための
 * 簡易判定で、言語を厳密に識別するものではない。英語本文に社名などの日本語が1語混じっただけで
 * 「日本語」と判定しないよう、ひらがな・カタカナ・漢字が「文字（空白・記号・数字を除く）」に占める
 * 割合で見る。
 */

// ひらがな・カタカナ（長音・半角カナ含む）・CJK統合漢字。
const JAPANESE_CHAR = /[぀-ヿㇰ-ㇿ㐀-䶿一-鿿ｦ-ﾟ]/gu;
// 言語判定の分母にする文字（各国語の文字。数字・記号・空白は含めない）。
const LETTER_CHAR = /\p{L}/gu;

/** 日本語として扱う割合の下限。これ未満なら日本語の文章とはみなさない。 */
export const JAPANESE_RATIO_THRESHOLD = 0.2;

/** 文字のうち日本語（ひらがな・カタカナ・漢字）が占める割合。文字が1つも無ければ0。 */
export function japaneseRatio(text: string | null | undefined): number {
  if (typeof text !== "string") return 0;
  const letters = text.match(LETTER_CHAR)?.length ?? 0;
  if (letters === 0) return 0;
  return (text.match(JAPANESE_CHAR)?.length ?? 0) / letters;
}

export function isMostlyJapanese(text: string | null | undefined): boolean {
  return japaneseRatio(text) >= JAPANESE_RATIO_THRESHOLD;
}

/** 題名が日本語の文章でない（＝外国語の記事）か。文字が無い題名は対象にしない。 */
export function isForeignLanguageTitle(title: string): boolean {
  return /\p{L}/u.test(title) && !isMostlyJapanese(title);
}

/** 要約が登録されているのに日本語になっていない（＝英語のまま）か。要約なしは対象にしない。 */
export function isSummaryUntranslated(summary: string | null | undefined): boolean {
  return typeof summary === "string" && /\p{L}/u.test(summary) && !isMostlyJapanese(summary);
}
