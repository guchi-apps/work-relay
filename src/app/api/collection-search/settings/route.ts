import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getBusinesses, normalizeBusinessKey } from "@/lib/businesses";
import { getCollectionSearchPolicies, requestCollectionSearchPolicyAdjustment, type CollectionSearchBusiness, type CollectionSearchPolicyView } from "@/lib/collection-search-settings";

export const runtime = "nodejs";

async function authorized() {
  const user = await getCurrentUser();
  return user.status === "authenticated" ? null : NextResponse.json({ error: "unauthorized" }, { status: user.status === "unavailable" ? 503 : 401 });
}

function serialize(value: CollectionSearchPolicyView) {
  return { policy: value.policy, pendingInstruction: value.pendingInstruction, updatedAt: value.updatedAt.toISOString() };
}

export async function GET() {
  const denied = await authorized();
  if (denied) return denied;
  const policies = await getCollectionSearchPolicies();
  return NextResponse.json(Object.fromEntries(Object.entries(policies).map(([key, value]) => [key, serialize(value)])), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const denied = await authorized();
  if (denied) return denied;
  const body: unknown = await request.json().catch(() => null);
  const parsed = body as { business?: unknown; instruction?: unknown } | null;
  const business: CollectionSearchBusiness | null = normalizeBusinessKey(await getBusinesses(), parsed?.business);
  const instruction = typeof parsed?.instruction === "string" ? parsed.instruction : "";
  if (!business) return NextResponse.json({ error: "invalid_business" }, { status: 400 });
  const value = await requestCollectionSearchPolicyAdjustment(business, instruction);
  if (!value) return NextResponse.json({ error: "invalid_instruction" }, { status: 400 });
  return NextResponse.json(serialize(value));
}
