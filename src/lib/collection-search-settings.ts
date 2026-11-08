import { prisma } from "@/lib/db";

import { findBusiness, getBusinesses } from "@/lib/businesses";

export type CollectionSearchBusiness = string;

/** 区分の判定基準の初期値（マスタの`defaultPolicy`）。 */
async function defaultPolicyOf(business: CollectionSearchBusiness): Promise<string> {
  return findBusiness(await getBusinesses(), business)?.defaultPolicy ?? "";
}
const INSTRUCTION_LIMIT = 1000;

export type CollectionSearchPolicyView = { business: CollectionSearchBusiness; policy: string; pendingInstruction: string | null; updatedAt: Date };

export async function getCollectionSearchPolicy(business: CollectionSearchBusiness): Promise<CollectionSearchPolicyView> {
  return prisma.collectionSearchPolicy.upsert({
    where: { business }, create: { business, policy: await defaultPolicyOf(business) }, update: {},
  });
}

export async function getCollectionSearchPolicies(): Promise<Record<CollectionSearchBusiness, CollectionSearchPolicyView>> {
  const businesses = await getBusinesses();
  const views = await Promise.all(businesses.map((def) => getCollectionSearchPolicy(def.key)));
  return Object.fromEntries(businesses.map((def, index) => [def.key, views[index]]));
}

export async function requestCollectionSearchPolicyAdjustment(business: CollectionSearchBusiness, instruction: string): Promise<CollectionSearchPolicyView | null> {
  const text = instruction.trim().slice(0, INSTRUCTION_LIMIT);
  if (!text) return null;
  return prisma.collectionSearchPolicy.upsert({
    where: { business }, create: { business, policy: await defaultPolicyOf(business), pendingInstruction: text }, update: { pendingInstruction: text },
  });
}

/**
 * 収集ジョブの結果として方針を保存する。
 *
 * `pendingInstruction`は、ジョブの取得時（`claimedAt`）までに保存された指示だけを消す。収集は最長780秒
 * 動くため、その間に画面から保存された指示はまだプロンプトに入っていない。`updatedAt`が`claimedAt`より
 * 後の行は触らず、次の収集へ持ち越す（#412）。方針の更新は指示の消去より後に行う（更新が`updatedAt`を進めるため）。
 */
export async function saveCollectionSearchPolicy(business: CollectionSearchBusiness, policy: string, claimedAt: Date): Promise<void> {
  const text = policy.trim().slice(0, 4000) || (await defaultPolicyOf(business));
  await prisma.collectionSearchPolicy.upsert({ where: { business }, create: { business, policy: text }, update: {} });
  await prisma.collectionSearchPolicy.updateMany({ where: { business, updatedAt: { lte: claimedAt } }, data: { pendingInstruction: null } });
  await prisma.collectionSearchPolicy.update({ where: { business }, data: { policy: text } });
}
