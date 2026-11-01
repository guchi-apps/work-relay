import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { enqueueAnalysisJob } from "@/lib/article-analysis";
import { normalizeUrl } from "@/lib/collection";
import { prisma } from "@/lib/db";
import { getTriageState, type TriageState } from "@/lib/triage";

export type SharedArticleBusiness = string;

export type SharedArticleSummary = {
  id: string;
  title: string;
  sourceName: string;
  collectedAt: Date;
  publishedAt: Date | null;
  analysisStatus: string | null;
  triage: TriageState;
};

const SUMMARY_SELECT = { id: true, title: true, sourceName: true, collectedAt: true, publishedAt: true, analysisStatus: true, weeklyCandidate: true, reviewedAt: true } as const;

function toSummary(row: Prisma.IndustryInformationGetPayload<{ select: typeof SUMMARY_SELECT }>): SharedArticleSummary {
  return { id: row.id, title: row.title, sourceName: row.sourceName, collectedAt: row.collectedAt, publishedAt: row.publishedAt, analysisStatus: row.analysisStatus, triage: getTriageState(row) };
}

/** 共有されたURLがすでに新着記事にあるか。自動収集が統合した転載元（`mergedSources`）までは見ない。 */
export async function findArticleByUrl(url: string): Promise<SharedArticleSummary | null> {
  const row = await prisma.industryInformation.findUnique({ where: { normalizedUrl: normalizeUrl(url) }, select: SUMMARY_SELECT });
  return row ? toSummary(row) : null;
}

export type CreateSharedArticleResult = { outcome: "created" | "duplicate"; article: SharedArticleSummary };

/**
 * 共有された記事を新着記事に登録し、AI解析を積む（#144）。
 *
 * 自動収集（`upsertIndustryInformationEvent()`）の週あたり上限・同一イベント統合は通さない。
 * 人がわざわざ共有した記事なので、上限で外したり別記事へ統合したりせず、そのまま「採用」で置く
 * （`reviewedAt`を入れる。`src/lib/triage.ts`）。ページ本文は取得せず、共有された文章だけを
 * 本文の代わりに持たせる——AI解析は本文が無くても原典URLから判断する（`analysis-prompt.ts`）。
 */
export async function createSharedArticle(input: { url: string; title: string; text: string; business: SharedArticleBusiness; reviewedBy: string }): Promise<CreateSharedArticleResult> {
  const normalizedUrl = normalizeUrl(input.url);
  const existing = await findArticleByUrl(input.url);
  if (existing) return { outcome: "duplicate", article: existing };

  const now = new Date();
  let row;
  try {
    row = await prisma.industryInformation.create({
      data: {
        business: input.business,
        informationType: "OTHER",
        title: input.title,
        originalUrl: input.url,
        normalizedUrl,
        urlHash: createHash("sha256").update(normalizedUrl).digest("hex"),
        sourceName: new URL(input.url).hostname.replace(/^www\./, ""),
        content: input.text || null,
        keywords: [],
        tags: ["共有"],
        weeklyCandidate: true,
        reviewedAt: now,
        reviewedBy: input.reviewedBy,
        reviewNote: "共有メニューから追加",
      },
      select: SUMMARY_SELECT,
    });
  } catch (error) {
    // 同時に2回押された場合など。先に入った方を返す。
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await findArticleByUrl(input.url);
      if (raced) return { outcome: "duplicate", article: raced };
    }
    throw error;
  }

  await enqueueAnalysisJob(row.id, input.reviewedBy);
  return { outcome: "created", article: { ...toSummary(row), analysisStatus: "QUEUED" } };
}
