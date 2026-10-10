import { cookies } from "next/headers";
import { decideAccess, toAccessSubject } from "@/lib/access/client";
import { isRetryableAuthError } from "@/lib/auth-error";
import { DEV_LOGIN_COOKIE_NAME, verifyDevLoginCookieValue } from "@/lib/dev-login";
import { createClient } from "@/lib/supabase/server";

export type CurrentUser = { email: string };

export type CurrentUserResult =
  | { status: "authenticated"; user: CurrentUser }
  | { status: "unauthenticated" }
  | { status: "unavailable" };

async function getDevLoginEmail(): Promise<string | null> {
  const cookieStore = await cookies();
  return verifyDevLoginCookieValue(cookieStore.get(DEV_LOGIN_COOKIE_NAME)?.value);
}

export async function getCurrentUser(): Promise<CurrentUserResult> {
  const devLoginEmail = await getDevLoginEmail();
  if (devLoginEmail) {
    return { status: "authenticated", user: { email: devLoginEmail } };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();

  if (error) {
    if (isRetryableAuthError(error)) {
      return { status: "unavailable" };
    }
    return { status: "unauthenticated" };
  }

  // 許可はStatusHubの共通アクセス設定で判定する（旧ALLOWED_GOOGLE_EMAILSは使わない）。
  const email = data.user?.email;
  if (!email || !(await decideAccess(toAccessSubject(data.user))).allowed) {
    return { status: "unauthenticated" };
  }

  return { status: "authenticated", user: { email } };
}
