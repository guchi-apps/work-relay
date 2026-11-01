import SwiftUI

@main
struct WorkRelayApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

struct ContentView: View {
    @StateObject private var model = WebViewModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            // ステータスバーの部分はWebのヘッダーと同じ色で塗る。WebViewはステータスバーの
            // 下から始めるので、スクロールした内容が上端へ潜らない
            Color("HeaderBand").ignoresSafeArea()

            WebViewContainer(webView: model.webView)
                .ignoresSafeArea(edges: .bottom)

            if let failure = model.failure {
                ConnectionErrorView(failure: failure, isRetrying: model.isRetrying, retry: model.retry)
                    .transition(.opacity)
            }

            ShareNoticeView(importer: model.shareImporter)
        }
        .animation(.easeOut(duration: 0.2), value: model.failure)
        .onAppear {
            model.startIfNeeded()
            Task { await model.shareImporter.run() }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            // 別アプリへ行っているあいだに回線が戻っていることがある
            if model.failure != nil { model.retry() }
            // 共有拡張から渡された内容があれば取り込む（`workrelay://share` で開けなかった場合もここで拾う）
            Task { await model.shareImporter.run() }
        }
        .onOpenURL { url in
            if url.scheme == AppConfig.authCallbackScheme, url.host == "share" {
                Task { await model.shareImporter.run() }
            }
        }
    }
}
