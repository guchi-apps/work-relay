import { NextResponse, type NextRequest } from "next/server";
import { nativeLoginErrorUrl } from "@/lib/native-auth/native-app";
import { isValidChallenge } from "@/lib/native-auth/tokens";
import { getRequestOrigin, safeNextPath } from "@/lib/request-origin";
import { createClient } from "@/lib/supabase/server";

/**
 * iOSアプリの認証シート（ASWebAuthenticationSession）から開くGoogleログインの入口（#317）。
 *
 * `/auth/signin` と同じくサーバーでPKCEを始めるが、戻り先の `/auth/callback` へ `native=1` と
 * アプリの `challenge`（code_verifierのS256）を運ぶ。callbackは認証・許可判定のあと、
 * トークンではなく一度限りの引き継ぎコードだけをアプリのスキームへ返す。
 */
export async function GET(request: NextRequest) {
  const origin = getRequestOrigin(request);
  const challenge = request.nextUrl.searchParams.get("challenge");
  if (!isValidChallenge(challenge)) {
    return NextResponse.redirect(nativeLoginErrorUrl("auth_failed"));
  }

  const callback = new URL(`${origin}/auth/callback`);
  callback.searchParams.set("native", "1");
  callback.searchParams.set("challenge", challenge);
  callback.searchParams.set("next", safeNextPath(request.nextUrl.searchParams.get("next")));

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: callback.toString(), skipBrowserRedirect: true },
  });

  if (error || !data.url) {
    console.error("[work-relay] iOSアプリのGoogleログイン開始に失敗:", error?.message ?? "URLが返らなかった");
    return NextResponse.redirect(nativeLoginErrorUrl("auth_failed"));
  }

  return NextResponse.redirect(data.url);
}
