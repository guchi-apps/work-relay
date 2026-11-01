import Foundation
import ImageIO
import UniformTypeIdentifiers

/// 共有シートから受け取った内容。写真は縮小済みのJPEG（位置情報などのメタデータなし）
struct SharedContent {
    var title = ""
    var text = ""
    var url: String?
    var photos: [Data] = []
    /// 20枚を超えたため渡せない写真の数
    var droppedPhotos = 0
    /// 読み込めなかった項目の数（写真が壊れている・非対応の形式など）
    var unreadableItems = 0

    var isEmpty: Bool { photos.isEmpty && url == nil && text.isEmpty }
    var totalBytes: Int { photos.reduce(0) { $0 + $1.count } }
}

/// `NSExtensionItem` から共有内容を取り出す。メモリが小さい拡張プロセスで動くため、写真は1枚ずつ
/// ファイルから縮小して読み、元の大きな画像をまとめて保持しない
enum ShareContentLoader {
    static func load(from items: [NSExtensionItem]) async -> SharedContent {
        var content = SharedContent()
        var imageProviders: [NSItemProvider] = []

        for item in items {
            if content.title.isEmpty, let title = item.attributedTitle?.string, !title.isEmpty {
                content.title = title
            }
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    imageProviders.append(provider)
                } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    if let url = await loadURL(provider) {
                        if content.url == nil { content.url = url } else { content.unreadableItems += 1 }
                    } else {
                        content.unreadableItems += 1
                    }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    if let text = await loadText(provider) {
                        content.text = content.text.isEmpty ? text : content.text + "\n" + text
                    } else {
                        content.unreadableItems += 1
                    }
                } else {
                    content.unreadableItems += 1
                }
            }
            // URLや文章を持たない項目（写真アプリなど）の本文。タイトルの候補にだけ使う
            if content.text.isEmpty, content.url == nil, imageProviders.isEmpty,
               let text = item.attributedContentText?.string, !text.isEmpty {
                content.text = text
            }
        }

        content.droppedPhotos = max(0, imageProviders.count - ShareLimits.maxFiles)
        for provider in imageProviders.prefix(ShareLimits.maxFiles) {
            if let data = await loadPhoto(provider) {
                content.photos.append(data)
            } else {
                content.unreadableItems += 1
            }
        }
        return content
    }

    private static func loadURL(_ provider: NSItemProvider) async -> String? {
        let item = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier)
        if let url = item as? URL, url.scheme == "http" || url.scheme == "https" { return url.absoluteString }
        return nil
    }

    private static func loadText(_ provider: NSItemProvider) async -> String? {
        let item = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier)
        let text = (item as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (text?.isEmpty ?? true) ? nil : text
    }

    /// 一時ファイルは読み込み関数の中でしか有効でないため、その中で縮小まで済ませる
    private static func loadPhoto(_ provider: NSItemProvider) async -> Data? {
        await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, _ in
                guard let url else { return continuation.resume(returning: nil) }
                continuation.resume(returning: PhotoShrinker.shrink(fileURL: url, maxPixel: ShareLimits.maxPixel, quality: 0.8))
            }
        }
    }
}

/// 写真を長辺 `maxPixel` のJPEGに縮める。出力にはメタデータ（撮影場所など）を載せない
enum PhotoShrinker {
    nonisolated static func shrink(fileURL: URL, maxPixel: Int, quality: Double) -> Data? {
        guard let source = CGImageSourceCreateWithURL(fileURL as CFURL, nil) else { return nil }
        return encode(source: source, maxPixel: maxPixel, quality: quality)
    }

    /// 縮小済みのJPEGをさらに縮める（合計が10MBを超えたときの2回目）
    nonisolated static func shrink(data: Data, maxPixel: Int, quality: Double) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return encode(source: source, maxPixel: maxPixel, quality: quality)
    }

    private nonisolated static func encode(source: CGImageSource, maxPixel: Int, quality: Double) -> Data? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        // 元のメタデータをコピーしない（位置情報を送らない）。向きは Transform で画素に反映済み
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return output as Data
    }
}
