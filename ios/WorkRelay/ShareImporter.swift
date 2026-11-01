import Combine
import SwiftUI
import WebKit

/// 共有拡張が端末に残した内容を、ログイン中のセッションで `POST /api/share/inbox` へ渡し、
/// 返ってきた既存の画面（「画像を送る」「共有された記事」）を開く（#318）。
///
/// - 認証は WKWebView のセッション Cookie をそのまま使う。拡張にもアプリにもトークンは持たせず、
///   ショートカット用の `SHARE_SHORTCUT_TOKEN` は使わない
/// - **ここでは何も送信しない。** サーバーへ渡すのは「受け取り」までで、メール送信は開いた画面で本人が押す
/// - 失敗したときは、内容が端末に残っているか失われたかを必ず画面に出す
@MainActor
final class ShareImporter: ObservableObject {
    enum Notice: Equatable {
        case importing(summary: String)
        /// ログインが切れている。内容は端末に残してある
        case loginRequired(summary: String)
        /// 通信に失敗した。内容は端末に残してあり、やり直せる
        case retryable(summary: String)
        /// 取り込めず、内容は失われた（上限超過・期限切れなど）。理由を `message` に入れる
        case lost(message: String)
    }

    @Published private(set) var notice: Notice?

    /// アプリ内の相対パス（`/dashboard/image-mail?shared=…`）をWebViewで開く
    var openPath: ((String) -> Void)?

    private let webView: WKWebView
    private var isRunning = false

    init(webView: WKWebView) {
        self.webView = webView
    }

    func dismissNotice() {
        if case .lost = notice { notice = nil }
    }

    /// 端末に残した内容を捨てる（利用者が「破棄する」を選んだとき）
    func discard() {
        ShareStore.discard()
        notice = nil
    }

    /// 取り込み待ちがあれば渡す。アプリの起動・前面化・ログイン完了のたびに呼んでよい（同時に1件だけ動く）
    func run() async {
        guard !isRunning, let share = ShareStore.load() else { return }
        isRunning = true
        defer { isRunning = false }

        if share.isExpired() {
            ShareStore.discard()
            notice = .lost(message: "\(share.summary)の共有は、取り込まれないまま24時間が過ぎたため破棄しました。もう一度共有してください。")
            return
        }
        guard let photos = ShareStore.loadPhotos(of: share) else {
            ShareStore.discard()
            notice = .lost(message: "端末に保存した\(share.summary)を読み出せませんでした。内容は失われています。もう一度共有してください。")
            return
        }

        notice = .importing(summary: share.summary)
        var result = await upload(share, photos: photos)
        if case .unauthorized = result {
            // アクセストークンの期限切れなら、保護された画面を開くとCookieが更新される。更新できたら1回だけやり直す
            if await refreshSession() { result = await upload(share, photos: photos) }
        }

        switch result {
        case .opened(let path):
            ShareStore.discard()
            notice = nil
            openPath?(path)
        case .unauthorized:
            notice = .loginRequired(summary: share.summary)
        case .rejected(let message):
            ShareStore.discard()
            notice = .lost(message: "\(message)\n共有された\(share.summary)は取り込まれず、端末の控えも破棄しました。")
        case .networkFailure:
            notice = .retryable(summary: share.summary)
        }
    }

    // MARK: - 通信

    private enum UploadResult {
        case opened(path: String)
        case unauthorized
        case rejected(message: String)
        case networkFailure
    }

    private func upload(_ share: PendingShare, photos: [(name: String, data: Data)]) async -> UploadResult {
        let boundary = "WorkRelay-\(UUID().uuidString)"
        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
        }
        // 応答だけ受け取れずに再試行しても、サーバーが同じ共有として扱う冪等キー（写真が重複して残らない）
        field("shareKey", share.id)
        if !share.title.isEmpty { field("title", share.title) }
        if !share.text.isEmpty { field("text", share.text) }
        if let url = share.url { field("url", url) }
        for photo in photos {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"files\"; filename=\"\(photo.name)\"\r\nContent-Type: image/jpeg\r\n\r\n".utf8))
            body.append(photo.data)
            body.append(Data("\r\n".utf8))
        }
        body.append(Data("--\(boundary)--\r\n".utf8))

        var request = URLRequest(url: AppConfig.baseURL.appending(path: "api/share/inbox"))
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.httpShouldHandleCookies = false
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        // リダイレクトではなくJSONで受ける（サーバー側の `acceptsJson`）。Authorization は付けない（セッションで認証する）
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        for (name, value) in await cookieHeaders() { request.setValue(value, forHTTPHeaderField: name) }

        do {
            let (data, response) = try await URLSession.shared.upload(for: request, from: body)
            guard let http = response as? HTTPURLResponse else { return .networkFailure }
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            switch http.statusCode {
            case 200:
                if let open = json?["openUrl"] as? String, let path = appPath(from: open) { return .opened(path: path) }
                return .networkFailure
            case 401:
                return .unauthorized
            case 400..<500:
                return .rejected(message: (json?["message"] as? String) ?? "サーバーが内容を受け付けませんでした。")
            default:
                return .networkFailure
            }
        } catch {
            return .networkFailure
        }
    }

    /// 保護された画面を開き、更新されたCookieをWebViewへ反映する。ログイン画面へ戻されたら false
    private func refreshSession() async -> Bool {
        var request = URLRequest(url: AppConfig.baseURL.appending(path: "dashboard"))
        request.timeoutInterval = 30
        request.httpShouldHandleCookies = false
        for (name, value) in await cookieHeaders() { request.setValue(value, forHTTPHeaderField: name) }
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, let finalURL = http.url,
              http.statusCode == 200, finalURL.path.hasPrefix("/dashboard")
        else { return false }

        let fields = http.allHeaderFields.reduce(into: [String: String]()) { result, pair in
            if let key = pair.key as? String, let value = pair.value as? String { result[key] = value }
        }
        let updated = HTTPCookie.cookies(withResponseHeaderFields: fields, for: finalURL)
        let store = webView.configuration.websiteDataStore.httpCookieStore
        for cookie in updated { await store.setCookie(cookie) }
        return true
    }

    private func cookieHeaders() async -> [String: String] {
        let all = await webView.configuration.websiteDataStore.httpCookieStore.allCookies()
        guard let host = AppConfig.baseURL.host else { return [:] }
        let matching = all.filter { cookie in
            let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
            return host == domain || host.hasSuffix("." + domain)
        }
        return HTTPCookie.requestHeaderFields(with: matching)
    }

    /// サーバーが返した絶対URLのうち、ワークリレーの画面だけをパス＋クエリにして返す
    private func appPath(from openUrl: String) -> String? {
        guard let url = URL(string: openUrl), AppConfig.isAppURL(url) else { return nil }
        var path = url.path
        if let query = url.query { path += "?" + query }
        return path
    }
}

/// 取り込みの状況・失敗をWeb画面の上へ重ねる。ログイン画面を隠さないよう、下から出るカードにする
struct ShareNoticeView: View {
    @ObservedObject var importer: ShareImporter

    var body: some View {
        if let notice = importer.notice {
            VStack {
                Spacer()
                card(for: notice)
                    .padding(16)
            }
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    @ViewBuilder
    private func card(for notice: ShareImporter.Notice) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            switch notice {
            case .importing(let summary):
                HStack(spacing: 10) {
                    ProgressView()
                    Text("共有された\(summary)を取り込んでいます").font(.subheadline.weight(.semibold))
                }
                Text("画面を閉じずにお待ちください。").font(.footnote).foregroundStyle(.secondary)
            case .loginRequired(let summary):
                Text("ログインが切れています").font(.subheadline.weight(.semibold))
                Text("共有された\(summary)は端末に保存してあります。ログインすると、続きから取り込みます。")
                    .font(.footnote).foregroundStyle(.secondary)
                Button("共有内容を破棄する", role: .destructive, action: importer.discard).font(.footnote)
            case .retryable(let summary):
                Text("取り込めませんでした").font(.subheadline.weight(.semibold))
                Text("通信に失敗しました。共有された\(summary)は端末に残っています。電波の良い場所で、もう一度試してください。")
                    .font(.footnote).foregroundStyle(.secondary)
                HStack {
                    Button("もう一度取り込む") { Task { await importer.run() } }.buttonStyle(.borderedProminent)
                    Button("破棄する", role: .destructive, action: importer.discard)
                }
            case .lost(let message):
                Text("共有内容は取り込めませんでした").font(.subheadline.weight(.semibold))
                Text(message).font(.footnote).foregroundStyle(.secondary)
                Button("閉じる", action: importer.dismissNotice).font(.footnote)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        .shadow(radius: 8, y: 2)
    }
}
