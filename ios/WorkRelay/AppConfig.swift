import Foundation

/// アプリ全体で使う定数。画面・機能はすべてWeb版（正本）にあり、アプリはそれを開く殻に徹する（#317）。
enum AppConfig {
    /// Web版のURL。開発サーバーへ向けるときもここだけを変える（ios/README.md）
    static let baseURL = URL(string: "https://research-desk.gucchii.com/")!

    /// 認証シートの戻り先スキーム。サーバー側の `src/lib/native-auth/native-app.ts` の
    /// `NATIVE_SCHEME` と揃えること（`ios/scripts/check-consistency.mjs` が照合する）。
    /// Supabase・Googleのリダイレクト先へは登録しない（サーバーの /auth/callback だけが返す）
    static let authCallbackScheme = "workrelay"

    /// User-Agentの末尾に足す識別子（`WorkRelayIOS/1.0` の形）。サーバーログで見分けるためだけで、
    /// Web側の挙動はこの値で変えない。既定の `Mobile/…` は残したまま足す
    static var userAgentApplicationName: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        return "Mobile/15E148 WorkRelayIOS/\(version)"
    }

    /// このURLがアプリで開くべきWeb版の画面か（ホスト・スキーム・ポートまで一致）。
    /// 一致しないURLはWebViewへ読み込まず、Safari等で開く
    static func isAppURL(_ url: URL) -> Bool {
        url.scheme == baseURL.scheme && url.host == baseURL.host && url.port == baseURL.port
    }
}

/// WebViewの遷移のうち、アプリが横取りして認証シートで行うもの。
/// Web側のリンク・ボタンは変えず（ハイドレーション前でも押せる素の `<a>` のまま）、遷移だけを捕まえる
enum InterceptedRoute: Equatable {
    /// `/auth/signin?next=…`（Googleログイン）。`next` はURLから引き継ぐ
    case login(next: String?)

    static func classify(_ url: URL) -> InterceptedRoute? {
        guard AppConfig.isAppURL(url) else { return nil }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        switch url.path {
        case "/auth/signin":
            return .login(next: items.first(where: { $0.name == "next" })?.value)
        default:
            return nil
        }
    }
}
