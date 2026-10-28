import { NextResponse, type NextRequest } from "next/server";
import { decideAccess, toAccessSubject } from "@/lib/access/client";
import { signOutThisApp } from "@/lib/auth-signout";
import { consumeHandoff } from "@/lib/native-auth/handoff";
import { decryptSecret } from "@/lib/native-auth/secret-cipher";
import { handoffStore } from "@/lib/native-auth/stores";
import { isValidVerifier } from "@/lib/native-auth/tokens";
import { safeNextPath } from "@/lib/request-origin";
import { createClient } from "@/lib/supabase/server";

/**
 * 引き継ぎコードを消費して、WKWebViewへ通常のSupabase SSR Cookieを渡す（#317）。
 *
 * WKWebViewの中から `fetch`（同一オリジン・POST）で呼ぶ。コードとcode_verifierはURLではなく
 * 本文で受けるため、アクセスログに残らない。失敗の理由は区別せず同じ応答にする。
 */
export async function POST(request: NextRequest) {
  const body: unknown = await request.json().catch(() => null);
  const code = typeof (body as { code?: unknown })?.code === "string" ? (body as { code: string }).code : "";
  const verifier = (body as { verifier?: unknown })?.verifier;

  const rejected = () => NextResponse.json({ error: "invalid_handoff" }, { status: 400 });
  if (!code || !isValidVerifier(verifier)) return rejected();

  const handoff = await consumeHandoff({ store: handoffStore, code, verifier, now: new Date() });
  if (!handoff) return rejected();

  let tokens: { accessToken: string; refreshToken: string };
  try {
    tokens = JSON.parse(decryptSecret(handoff.sessionCipher));
  } catch {
    return rejected();
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.setSession({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
  });
  if (error || !data.user) return rejected();

  // 発行後にアクセス許可から外れた場合に備え、ここでも確かめる。
  let allowed = false;
  try {
    allowed = (await decideAccess(toAccessSubject(data.user))).allowed;
  } catch {
    allowed = false;
  }
  if (!allowed) {
    await signOutThisApp(supabase);
    return NextResponse.json({ error: "not_allowed" }, { status: 403 });
  }

  return NextResponse.json({ next: safeNextPath(handoff.next) });
}
