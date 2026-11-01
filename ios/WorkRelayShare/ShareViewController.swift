import SwiftUI
import UIKit

/// 共有シートの「workRelay」。内容を確認してもらい、端末の共有コンテナへ保存してアプリを開く（#318）。
/// **ここでは何も送信しない。** 送信（社用メール）は、アプリで開く既存の画面で本人が押す
final class ShareViewController: UIViewController {
    private let model = ShareModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        model.onClose = { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        }
        model.onOpenApp = { [weak self] in self?.openHostApp(ShareConstants.openURL) }

        let host = UIHostingController(rootView: ShareView(model: model))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)

        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        Task { await model.load(items: items) }
    }

    /// 共有拡張から本体アプリを開く。公開APIが無いため、レスポンダチェーンの `UIApplication` に
    /// `openURL:options:completionHandler:` を送る。開けなくても内容は保存済みで、アプリが前面に来たときに
    /// 取り込む（開けたかを画面では断定しない）
    private func openHostApp(_ url: URL) {
        let selector = NSSelectorFromString("openURL:options:completionHandler:")
        var responder: UIResponder? = self
        while let current = responder {
            if current.responds(to: selector) {
                typealias OpenFunction = @convention(c) (AnyObject, Selector, URL, [UIApplication.OpenExternalURLOptionsKey: Any], ((Bool) -> Void)?) -> Void
                let function = unsafeBitCast(current.method(for: selector), to: OpenFunction.self)
                function(current, selector, url, [:], nil)
                return
            }
            responder = current.next
        }
    }
}
