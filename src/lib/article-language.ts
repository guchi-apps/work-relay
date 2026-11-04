/**
 * 記事の言語判定（#394）。DB・Prismaに触れない純粋な関数だけを置く。
 *
 * 新着記事画面で「英語の記事か」「要約が日本語になっているか」を出し分けるための簡易判定で、
 * 言語を厳密に識別するものではない。ひらがな・カタカナ・漢字のいずれも含まない文字列を
 * 「日本語を含まない」とみなす（英語に限らず外国語の題名も同じ扱い）。
 */

// ひらがな・カタカナ（長音・半角カナ含む）・CJK統合漢字。
const JAPANESE_PATTERN = /[぀-ヿㇰ-ㇿ㐀-䶿一-鿿ｦ-ﾟ]/;

export function containsJapanese(text: string | null | undefined): boolean {
  return typeof text === "string" && JAPANESE_PATTERN.test(text);
}

/** 題名が日本語を含まない（＝外国語の記事）か。空の題名は対象にしない。 */
export function isForeignLanguageTitle(title: string): boolean {
  return title.trim() !== "" && !containsJapanese(title);
}

/** 要約が登録されているのに日本語を含まない（＝英語のまま）か。要約なしは対象にしない。 */
export function isSummaryUntranslated(summary: string | null | undefined): boolean {
  return typeof summary === "string" && summary.trim() !== "" && !containsJapanese(summary);
}
