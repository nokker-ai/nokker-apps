import MobileCoreServices
import PDFKit
import UIKit
import UniformTypeIdentifiers

/// « Partager vers Nokker » (LOKKAL-PHONE §4.2.1, lot P5a) : texte, adresse web, images (4 au plus) ou PDF (4 au plus)
/// depuis n'importe quelle app. Rien ne part sur le réseau ici : l'extension dépose le partage dans la boîte de l'App
/// Group (images réduites à 2048 px en JPEG, texte des PDF extrait sur l'appareil par PDFKit, 20 000 caractères au plus),
/// puis ouvre Nokker par `nokker://share/<id>`. L'app ouvre un nouveau fil avec la pièce dans le composeur : c'est la
/// personne qui envoie.
final class ShareViewController: UIViewController {
    private static let maxPdfChars = 20_000
    private static let maxSide: CGFloat = 2048

    private let label = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.systemBackground.withAlphaComponent(0.96)
        label.text = NSLocalizedString("Envoi vers Nokker…", comment: "")
        label.font = .preferredFont(forTextStyle: .headline)
        label.textAlignment = .center
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        Task { await self.collect() }
    }

    private func collect() async {
        let id = UUID().uuidString.lowercased()
        guard let inbox = NokkerShared.inbox() else {
            return finish(message: NSLocalizedString("Nokker n'a pas accès à sa boîte de partage sur cet appareil.", comment: ""), open: nil)
        }
        let dir = inbox.appendingPathComponent(id, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var items: [NokkerShared.Item] = []
        var images = 0
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        for p in providers {
            if p.hasItemConformingToTypeIdentifier(UTType.pdf.identifier), let url = await loadURL(p, UTType.pdf) {
                let text = PDFDocument(url: url)?.string ?? ""
                items.append(.init(kind: "pdf", text: String(text.prefix(Self.maxPdfChars)), name: url.lastPathComponent))
            } else if p.hasItemConformingToTypeIdentifier(UTType.image.identifier), images < 4, let image = await loadImage(p) {
                images += 1
                let file = "image-\(images).jpg"
                if let jpeg = scaled(image).jpegData(compressionQuality: 0.85), (try? jpeg.write(to: dir.appendingPathComponent(file))) != nil {
                    items.append(.init(kind: "image", file: file, name: p.suggestedName))
                }
            } else if p.hasItemConformingToTypeIdentifier(UTType.url.identifier), let url = await loadURL(p, UTType.url), !url.isFileURL {
                items.append(.init(kind: "url", url: url.absoluteString, name: p.suggestedName))
            } else if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier), let text = await loadText(p) {
                items.append(.init(kind: "text", text: String(text.prefix(Self.maxPdfChars))))
            }
        }
        if items.isEmpty {
            try? FileManager.default.removeItem(at: dir)
            return finish(message: NSLocalizedString("Rien à partager vers Nokker ici.", comment: ""), open: nil)
        }
        let manifest = NokkerShared.Manifest(id: id, created_at: ISO8601DateFormatter().string(from: Date()), items: items)
        if let data = try? JSONEncoder().encode(manifest) {
            try? data.write(to: dir.appendingPathComponent("manifest.json"), options: .atomic)
        }
        finish(message: NSLocalizedString("C'est dans Nokker.", comment: ""), open: URL(string: "\(NokkerShared.urlScheme)://share/\(id)"))
    }

    // MARK: - Chargement des pièces

    private func loadURL(_ p: NSItemProvider, _ type: UTType) async -> URL? {
        await withCheckedContinuation { c in
            p.loadItem(forTypeIdentifier: type.identifier, options: nil) { item, _ in c.resume(returning: item as? URL) }
        }
    }

    private func loadText(_ p: NSItemProvider) async -> String? {
        await withCheckedContinuation { c in
            p.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { item, _ in
                c.resume(returning: (item as? String) ?? (item as? Data).flatMap { String(data: $0, encoding: .utf8) })
            }
        }
    }

    private func loadImage(_ p: NSItemProvider) async -> UIImage? {
        await withCheckedContinuation { c in
            p.loadItem(forTypeIdentifier: UTType.image.identifier, options: nil) { item, _ in
                switch item {
                case let image as UIImage: c.resume(returning: image)
                case let url as URL: c.resume(returning: UIImage(contentsOfFile: url.path))
                case let data as Data: c.resume(returning: UIImage(data: data))
                default: c.resume(returning: nil)
                }
            }
        }
    }

    private func scaled(_ image: UIImage) -> UIImage {
        let side = max(image.size.width, image.size.height)
        guard side > Self.maxSide else { return image }
        let k = Self.maxSide / side
        let size = CGSize(width: (image.size.width * k).rounded(), height: (image.size.height * k).rounded())
        return UIGraphicsImageRenderer(size: size).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    }

    // MARK: - Fin

    private func finish(message: String, open url: URL?) {
        DispatchQueue.main.async {
            self.label.text = message
            if let url { self.openContainingApp(url) }
            DispatchQueue.main.asyncAfter(deadline: .now() + (url == nil ? 1.6 : 0.4)) {
                self.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
            }
        }
    }

    /// Une extension de partage n'a pas `UIApplication.shared` : on remonte la chaîne des répondeurs jusqu'à l'app hôte.
    /// Si iOS refuse, le partage reste dans la boîte et Nokker le reprend à sa prochaine ouverture.
    private func openContainingApp(_ url: URL) {
        var responder: UIResponder? = self
        while let r = responder {
            if let app = r as? UIApplication {
                app.open(url, options: [:], completionHandler: nil)
                return
            }
            responder = r.next
        }
    }
}
