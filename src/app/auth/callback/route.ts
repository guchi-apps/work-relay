import type { Session, User } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { decideAccess, toAccessSubject } from "@/lib/access/client";
import { signOutThisApp } from "@/lib/auth-signout";
import { issueHandoff } from "@/lib/native-auth/handoff";
import { nativeLoginCodeUrl, nativeLoginErrorUrl } from "@/lib/native-auth/native-app";
import { encryptSecret } from "@/lib/native-auth/secret-cipher";
import { handoffStore } from "@/lib/native-auth/stores";
import { isValidChallenge } from "@/lib/native-auth/tokens";
import { getRequestOrigin, safeNextPath } from "@/lib/request-origin";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = getRequestOrigin(request);
  const code = url.searchParams.get("code");
  const next = safeNextPath(url.searchParams.get("next"));

  // iOSアプリの認証シート（#317）。戻り先はアプリのスキームで、アプリへ返すのは一度限りの
  // 引き継ぎコードだけ。このシートはエフェメラルでCookieを持たないため、Cookieの確立は
  // WKWebViewが呼ぶ /auth/native/consume で行う。
  const challenge = url.searchParams.get("challenge");
  const native = url.searchParams.get("native") === "1" && isValidChallenge(challenge);

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      if (native && challenge) {
        return nativeHandoff(supabase, data, challenge, next);
      }
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(native ? nativeLoginErrorUrl("auth_failed") : `${origin}/login?error=auth_callback_failed`);
}

async function nativeHandoff(
  supabase: Awaited<ReturnType<typeof createClient>>,
  data: { user: User | null; session: Session | null },
  challenge: string,
  next: string,
) {
  const { user, session } = data;
  if (!user || !session) return NextResponse.redirect(nativeLoginErrorUrl("auth_failed"));

  // 許可は共通アクセス設定で判定する。許可外はコードを発行せず、セッションも破棄する。
  let allowed = false;
  try {
    allowed = (await decideAccess(toAccessSubject(user))).allowed;
  } catch {
    allowed = false;
  }
  if (!allowed) {
    await signOutThisApp(supabase);
    return NextResponse.redirect(nativeLoginErrorUrl("not_allowed"));
  }

  // 暗号鍵の未設定やDB障害のときは500にせず、アプリへ失敗を返す（コードは発行しない）。
  let handoffCode: string;
  try {
    handoffCode = await issueHandoff({
      store: handoffStore,
      challenge,
      sessionCipher: encryptSecret(JSON.stringify({ accessToken: session.access_token, refreshToken: session.refresh_token })),
      next,
      now: new Date(),
    });
  } catch (error) {
    console.error("[work-relay] iOSアプリの引き継ぎコードを発行できません:", error instanceof Error ? error.message : error);
    await signOutThisApp(supabase);
    return NextResponse.redirect(nativeLoginErrorUrl("auth_failed"));
  }

  // シートはエフェメラルでCookieが残らず、サーバー側のセッションは失効させない
  // （引き継ぎ先のWKWebViewが同じセッションを使うため）。
  return NextResponse.redirect(nativeLoginCodeUrl(handoffCode));
}
