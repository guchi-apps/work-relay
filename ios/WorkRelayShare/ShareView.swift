import SwiftUI

@MainActor
final class ShareModel: ObservableObject {
    enum Phase: Equatable {
        case loading
        case ready
        /// 渡せるものが無い（非対応の形式・空）
        case unsupported
        /// 縮小しても合計が上限を超える
        case tooLarge
        case saved
        case failed(String)
    }

    @Published private(set) var phase: Phase = .loading
    @Published private(set) var content = SharedContent()
    @Published var title = ""
    /// 取り込み待ちの前回分があるか（保存すると置き換わる）
    @Published private(set) var replacesPending: PendingShare?

    var onClose: () -> Void = {}
    var onOpenApp: () -> Void = {}

    func load(items: [NSExtensionItem]) async {
        replacesPending = ShareStore.load()
        var loaded = await ShareContentLoader.load(from: items)

        // 縮小後の合計が10MBを超えるときは、1段小さくして1回だけ作り直す
        if loaded.totalBytes > ShareLimits.maxTotalBytes {
            let photos = loaded.photos
            let smaller = await Task.detached { photos.compactMap { PhotoShrinker.shrink(data: $0, maxPixel: 1200, quality: 0.6) } }.value
            if smaller.count == loaded.photos.count { loaded.photos = smaller }
        }

        content = loaded
        title = loaded.title
        if loaded.isEmpty {
            phase = .unsupported
        } else if loaded.totalBytes > ShareLimits.maxTotalBytes {
            phase = .tooLarge
        } else {
            phase = .ready
        }
    }

    func confirm() {
        do {
            _ = try ShareStore.save(title: title, text: content.text, url: content.url, photos: content.photos)
            phase = .saved
            onOpenApp()
        } catch {
            phase = .failed("端末への保存に失敗しました。空き容量を確かめて、もう一度共有してください。")
        }
    }
}

struct ShareView: View {
    @ObservedObject var model: ShareModel

    var body: some View {
        NavigationStack {
            Group {
                switch model.phase {
                case .loading:
                    ProgressView("内容を読み込んでいます").frame(maxWidth: .infinity, maxHeight: .infinity)
                case .ready:
                    ReadyView(model: model)
                case .unsupported:
                    MessageView(
                        symbol: "questionmark.circle",
                        title: "この内容は渡せません",
                        message: "写真・記事のURL・文章だけ渡せます。別の形式のファイルは、ワークリレーでは扱えません。"
                    )
                case .tooLarge:
                    MessageView(
                        symbol: "exclamationmark.triangle",
                        title: "写真が大きすぎて渡せません",
                        message: "縮小しても合計が10MBを超えます。枚数を減らして、もう一度共有してください。"
                    )
                case .saved:
                    MessageView(
                        symbol: "checkmark.circle",
                        title: "ワークリレーに渡しました",
                        message: "アプリが開かないときは、workRelayを開いてください。続きから取り込みます。まだ何も送信されていません。"
                    )
                case .failed(let message):
                    MessageView(symbol: "exclamationmark.triangle", title: "渡せませんでした", message: message)
                }
            }
            .navigationTitle("ワークリレーへ")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(model.phase == .saved ? "完了" : "キャンセル") { model.onClose() }
                }
            }
        }
    }
}

private struct ReadyView: View {
    @ObservedObject var model: ShareModel

    private var content: SharedContent { model.content }

    var body: some View {
        Form {
            if let pending = model.replacesPending {
                Section {
                    Label("前回の共有（\(pending.summary)）がまだ取り込まれていません。このまま進めると、前回の内容は破棄されます。", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                        .font(.footnote)
                }
            }
            if !content.photos.isEmpty {
                Section("写真 \(content.photos.count)枚（約\(megabytes(content.totalBytes))）") {
                    Text("長辺1600pxに縮小し、撮影場所の情報は外します。")
                        .font(.footnote).foregroundStyle(.secondary)
                    if content.droppedPhotos > 0 {
                        Label("一度に渡せるのは\(ShareLimits.maxFiles)枚までです。先頭の\(ShareLimits.maxFiles)枚だけ渡します。残りの\(content.droppedPhotos)枚は、もう一度共有してください。", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange).font(.footnote)
                    }
                    ScrollView(.horizontal) {
                        HStack {
                            ForEach(Array(content.photos.prefix(8).enumerated()), id: \.offset) { _, data in
                                if let image = UIImage(data: data) {
                                    Image(uiImage: image).resizable().scaledToFill()
                                        .frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 8))
                                }
                            }
                        }
                    }
                }
                Section("写真タイトル（任意）") { TextField("例: 現場の朝礼", text: $model.title) }
            }
            if let url = content.url {
                Section("記事のURL") { Text(url).font(.footnote).textSelection(.enabled) }
            }
            if content.photos.isEmpty, !content.text.isEmpty {
                Section("文章") { Text(content.text).lineLimit(8).font(.footnote) }
            }
            if content.unreadableItems > 0 {
                Section {
                    Label("\(content.unreadableItems)件は読み込めなかったため、渡しません。", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange).font(.footnote)
                }
            }
            Section {
                Text("この時点ではまだ送信されません。次に開く画面で内容を確かめてから送ります。")
                    .font(.footnote).foregroundStyle(.secondary)
                Button(action: model.confirm) {
                    Text(content.droppedPhotos > 0 ? "先頭の\(ShareLimits.maxFiles)枚で、ワークリレーで開く" : "ワークリレーで開く")
                        .frame(maxWidth: .infinity).fontWeight(.semibold)
                }
            }
        }
    }

    private func megabytes(_ bytes: Int) -> String {
        String(format: "%.1fMB", Double(bytes) / 1_048_576)
    }
}

private struct MessageView: View {
    let symbol: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 36)).foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(message).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
