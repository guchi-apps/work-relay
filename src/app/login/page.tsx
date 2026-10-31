import { BrandMark, Wordmark } from "@/components/BrandMark";

const ERROR_MESSAGES: Record<string, string> = {
  not_allowed: "このGoogleアカウントは利用が許可されていません",
  auth_failed: "ログインに失敗しました。もう一度お試しください",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  // iOSアプリ（#317）の認証シートから戻った失敗を、WebViewのログイン画面に表示する
  const { error } = await searchParams;
  const message = error ? ERROR_MESSAGES[error] : undefined;

  return (
    <main className="login-shell">
      <div className="login-card">
        <BrandMark variant="light" size={64} className="login-mark" />
        <p className="login-word">
          <Wordmark tone="light" />
        </p>
        <p className="login-lead">
          私用スマホで集めた業界ニュースや撮った写真を、社用PC・社用メールへ届ける個人用ツールです。
        </p>
        {/*
          ログイン開始はサーバー側のRoute Handlerへの素のリンクにする。onClickで
          signInWithOAuthを呼ぶ実装だと、ハイドレーション未完了の間はボタンが反応しない
          （guchi-apps/docs の knowledge/supabase.md「ログインの開始はサーバー側で行う」）。
        */}
        <a className="login-cta" href="/auth/signin">
          <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
            <path fill="#fff" d="M17.6 9.2c0-.6-.06-1.18-.16-1.73H9v3.28h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.56 2.66-3.87 2.66-6.53z" />
            <path fill="#fff" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18z" />
            <path fill="#fff" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.03z" />
            <path fill="#fff" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.89 11.42 0 9 0A9 9 0 0 0 .96 4.97L3.95 7.3C4.66 5.17 6.65 3.58 9 3.58z" />
          </svg>
          Googleでログイン
        </a>
        {message ? <p className="login-foot" role="alert">{message}</p> : null}
        <p className="login-foot">許可された Google アカウントのみ利用できます</p>
      </div>
    </main>
  );
}
