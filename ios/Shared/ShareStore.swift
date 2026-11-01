import Foundation

/// 共有拡張とアプリで共有する定数（#318）。サーバー側（`src/lib/share-inbox.ts`）の上限と揃えること。
/// `ios/scripts/check-consistency.mjs` が値を照合する
enum ShareLimits {
    static let maxFiles = 20
    static let maxTotalBytes = 10 * 1024 * 1024
    static let maxTitleLength = 200
    /// 写真の長辺（ショートカットの手順と同じ。docs/share-shortcut.md）
    static let maxPixel = 1600
    /// 端末に控えを残す期間。過ぎたら破棄し、その旨を画面に出す
    static let retention: TimeInterval = 24 * 60 * 60
}

enum ShareConstants {
    /// App Group。拡張とアプリがこの共有コンテナで受け渡す（トークン・Cookieは置かない）
    static let appGroup = "group.com.gucchii.workrelay"
    /// 拡張がアプリを開く（開けなくても、アプリは前面になるたびに控えを確かめる）
    static let openURL = URL(string: "workrelay://share")!
}

/// 共有拡張が端末に残す、取り込み待ちの内容。写真はJPEGのファイルとして同じフォルダに置く
struct PendingShare: Codable, Equatable {
    var id: String
    var createdAt: Date
    var title: String
    var text: String
    var url: String?
    var fileNames: [String]

    var photoCount: Int { fileNames.count }

    /// 画面に出す内容の説明（例: 「写真4枚」「記事のURL」「文章」）
    var summary: String {
        if photoCount > 0 { return "写真\(photoCount)枚" }
        if url != nil { return "記事のURL" }
        return "文章"
    }

    func isExpired(now: Date = Date()) -> Bool {
        now.timeIntervalSince(createdAt) > ShareLimits.retention
    }
}

/// 取り込み待ちの内容は同時に1件だけ持つ。新しく共有すると置き換わる（拡張が確認画面で知らせる）
enum ShareStore {
    private static var folder: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: ShareConstants.appGroup)?
            .appendingPathComponent("pending-share", isDirectory: true)
    }

    private static var manifestURL: URL? { folder?.appendingPathComponent("manifest.json") }

    /// 保存済みの内容。無い・読めないときは nil
    static func load() -> PendingShare? {
        guard let manifestURL, let data = try? Data(contentsOf: manifestURL) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(PendingShare.self, from: data)
    }

    /// 写真ファイル（JPEG）を読み出す。1枚でも欠けていれば nil（欠けたまま送らない）
    static func loadPhotos(of share: PendingShare) -> [(name: String, data: Data)]? {
        guard let folder else { return nil }
        var result: [(String, Data)] = []
        for name in share.fileNames {
            guard let data = try? Data(contentsOf: folder.appendingPathComponent(name)) else { return nil }
            result.append((name, data))
        }
        return result
    }

    /// 既存の控えを消して保存し直す。書き込みに失敗したら throw（呼び出し側が利用者に知らせる）
    static func save(title: String, text: String, url: String?, photos: [Data]) throws -> PendingShare {
        guard let folder else { throw ShareStoreError.containerUnavailable }
        discard()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

        var names: [String] = []
        for (index, data) in photos.enumerated() {
            let name = String(format: "photo-%02d.jpg", index + 1)
            try data.write(to: folder.appendingPathComponent(name), options: .atomic)
            names.append(name)
        }
        let share = PendingShare(
            id: UUID().uuidString,
            createdAt: Date(),
            title: String(title.prefix(ShareLimits.maxTitleLength)),
            text: text,
            url: url,
            fileNames: names
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        // manifest を最後に書く。途中で失敗した写真だけの状態を「保存済み」と見なさない
        try encoder.encode(share).write(to: folder.appendingPathComponent("manifest.json"), options: .atomic)
        return share
    }

    static func discard() {
        guard let folder else { return }
        try? FileManager.default.removeItem(at: folder)
    }
}

enum ShareStoreError: Error {
    case containerUnavailable
}
