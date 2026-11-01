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

export async function saveCollectionSearchPolicy(business: CollectionSearchBusiness, policy: string): Promise<void> {
  const text = policy.trim().slice(0, 4000) || (await defaultPolicyOf(business));
  await prisma.collectionSearchPolicy.upsert({ where: { business }, create: { business, policy: text }, update: { policy: text, pendingInstruction: null } });
}
