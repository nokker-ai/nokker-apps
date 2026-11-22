import Foundation

/// Boîte de partage commune à l'app et à l'extension « Partager vers Nokker » (LOKKAL-PHONE §4.2.1, lot P5a) :
/// le conteneur de l'App Group `group.ai.nokker.app`, dossier `share/<id>/` avec `manifest.json` et les images.
/// Ce fichier est compilé dans les DEUX cibles (App et ShareExtension).
enum NokkerShared {
    static let appGroup = "group.ai.nokker.app"
    static let urlScheme = "nokker"

    static func inbox() -> URL? {
        guard let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return nil }
        let dir = base.appendingPathComponent("share", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    struct Item: Codable {
        /// text | url | image | pdf
        var kind: String
        var text: String?
        var url: String?
        /// Fichier de l'image dans le dossier du partage (JPEG).
        var file: String?
        var name: String?
    }

    struct Manifest: Codable {
        var id: String
        var created_at: String
        var items: [Item]
    }
}
