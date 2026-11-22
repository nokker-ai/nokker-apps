import AVFoundation
import CryptoKit
import Foundation
import Network
import UIKit
import Vision

/// Caméra de veille du nœud maison (LOKKAL-PHONE §4.4, lot P10c, phase S ; contrat verrouillé avec onboarding le 06.11,
/// doctrine HOME-WATCH §1 : les images ne quittent jamais le réseau local).
///
/// - Détection SUR l'appareil : 2 images/s, luminance réduite à 64×48, différence avec l'image précédente ; au-dessus
///   du seuil (sensibilité basse, moyenne, haute), un événement, puis une minute de calme (anti-rafale). Classe
///   « personne » par Vision (VNDetectHumanRectanglesRequest) : une CLASSE, jamais une identité (aucune reconnaissance
///   de visage, aucune identification).
/// - Le noyau ne reçoit que du TEXTE (`camera.watch_event`) ; le modèle ne voit jamais d'image en v1.
/// - Vignettes : JPEG sur l'appareil, 24 h, 200 Mo au plus, protection `complete`, exclues de la sauvegarde, effacées
///   avec le nœud. `camera.thumb_url` : URL LAN à usage unique (http://<IP Wi-Fi>:8802/t/<32 car.>, 5 min) qui ne sert
///   que la vignette CHIFFRÉE (AES-256-GCM, clé aléatoire de la demande, AAD « nokker-thumb-v1|<id> ») ; le natif du
///   téléphone du titulaire la lit et la déchiffre.
/// - Veille visible : un bandeau « Caméra de veille active » reste au-dessus de tout (le mur compris) tant qu'elle tourne.
enum NokkerCamera {
    struct Fail: Error { let code: String }

    // MARK: - Réglages

    private static let onKey = "nokker.camera.on"
    private static let nameKey = "nokker.camera.name"
    private static let sensKey = "nokker.camera.sensitivity"
    private static let posKey = "nokker.camera.position"
    static let port: UInt16 = 8802
    static let retention: TimeInterval = 24 * 3600
    static let maxBytes = 200 * 1024 * 1024
    static let cooldown: TimeInterval = 60
    static let thumbTTL: TimeInterval = 300

    static var on: Bool {
        get { UserDefaults.standard.bool(forKey: onKey) }
        set { UserDefaults.standard.set(newValue, forKey: onKey) }
    }
    static var name: String {
        get { UserDefaults.standard.string(forKey: nameKey) ?? "Maison" }
        set { UserDefaults.standard.set(String(newValue.prefix(40)), forKey: nameKey) }
    }
    static var sensitivity: String {
        get { UserDefaults.standard.string(forKey: sensKey) ?? "medium" }
        set { UserDefaults.standard.set(["low", "medium", "high"].contains(newValue) ? newValue : "medium", forKey: sensKey) }
    }
    static var position: String {
        get { UserDefaults.standard.string(forKey: posKey) ?? "back" }
        set { UserDefaults.standard.set(newValue == "front" ? "front" : "back", forKey: posKey) }
    }
    static var permission: String {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return "granted"
        case .denied, .restricted: return "denied"
        default: return "undetermined"
        }
    }

    /// Part des pixels qui doivent changer (différence de luminance > 25) pour un mouvement.
    static func threshold(_ s: String) -> Double { s == "high" ? 0.005 : s == "low" ? 0.04 : 0.015 }

    // MARK: - Détecteur (fonction pure, testée par l'autotest)

    /// Détecteur de mouvement sur des images de luminance 64×48 ; anti-rafale de `cooldown` secondes.
    final class Detector {
        private var previous: [UInt8]?
        private var lastEvent: Date?
        var threshold: Double
        init(threshold: Double) { self.threshold = threshold }

        /// Vrai quand cette image ouvre un événement.
        func feed(_ luma: [UInt8], at: Date) -> Bool {
            defer { previous = luma }
            guard let p = previous, p.count == luma.count, !luma.isEmpty else { return false }
            var changed = 0
            for i in 0..<luma.count where abs(Int(luma[i]) - Int(p[i])) > 25 { changed += 1 }
            guard Double(changed) / Double(luma.count) >= threshold else { return false }
            if let l = lastEvent, at.timeIntervalSince(l) < NokkerCamera.cooldown { return false }
            lastEvent = at
            return true
        }
    }

    // MARK: - Événements et vignettes (sur l'appareil)

    struct Event: Codable {
        var id: String
        var camera: String
        var start: Double
        var end: Double
        var person: Bool
        var hasThumb: Bool
    }

    static var dir: URL {
        let d = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("nokker-camera", isDirectory: true)
        if !FileManager.default.fileExists(atPath: d.path) {
            try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
            var rv = URLResourceValues()
            rv.isExcludedFromBackup = true
            var u = d
            try? u.setResourceValues(rv)
        }
        return d
    }
    private static var indexURL: URL { dir.appendingPathComponent("events.json") }
    private static let io = DispatchQueue(label: "nokker.camera.io")

    static func events() -> [Event] {
        io.sync { (try? Data(contentsOf: indexURL)).flatMap { try? JSONDecoder().decode([Event].self, from: $0) } ?? [] }
    }

    private static func save(_ list: [Event]) {
        guard let d = try? JSONEncoder().encode(list) else { return }
        try? d.write(to: indexURL, options: [.atomic, .completeFileProtection])
    }

    static func thumbURL(_ id: String) -> URL { dir.appendingPathComponent("\(id).jpg") }

    /// Range un événement (et sa vignette), puis purge : plus de 24 h, puis le plus ancien au-delà de 200 Mo.
    static func record(_ e: Event, jpeg: Data?, now: Date = Date()) {
        io.sync {
            var list = (try? Data(contentsOf: indexURL)).flatMap { try? JSONDecoder().decode([Event].self, from: $0) } ?? []
            var ev = e
            if let jpeg {
                ev.hasThumb = (try? jpeg.write(to: thumbURL(e.id), options: [.atomic, .completeFileProtection])) != nil
            }
            list.append(ev)
            save(purge(list, now: now))
        }
    }

    /// Purge (dans `io`) : rend la liste gardée et efface les vignettes des événements retirés.
    static func purge(_ list: [Event], now: Date) -> [Event] {
        var keep = list.filter { now.timeIntervalSince1970 - $0.start < retention }
        var bytes = keep.reduce(0) { $0 + ((try? thumbURL($1.id).resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
        while bytes > maxBytes, let first = keep.first {
            bytes -= (try? thumbURL(first.id).resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            keep.removeFirst()
        }
        let kept = Set(keep.map(\.id))
        for e in list where !kept.contains(e.id) { try? FileManager.default.removeItem(at: thumbURL(e.id)) }
        return keep
    }

    static func forget() {
        stop()
        io.sync { try? FileManager.default.removeItem(at: dir) }
        on = false
    }

    static func bytesStored() -> Int {
        events().reduce(0) { $0 + ((try? thumbURL($1.id).resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
    }

    /// `camera.watch_event {after, limit}` : forme réduite de `cameras.reviews` (texte seulement).
    static func watchEvent(after: Double, limit: Int) -> [String: Any] {
        let list = io.sync { purge((try? Data(contentsOf: indexURL)).flatMap { try? JSONDecoder().decode([Event].self, from: $0) } ?? [], now: Date()) }
        let items = list.filter { $0.start > after }.suffix(max(1, min(200, limit))).map { e -> [String: Any] in
            ["id": e.id, "camera": e.camera, "start": e.start, "end": e.end, "severity": "detection", "niveau": "inconnu",
             "title": e.person ? "personne" : "mouvement", "summary": NSNull(), "objects": e.person ? ["person"] : [String](), "zones": [String](), "has_thumb": e.hasThumb]
        }
        return ["items": Array(items), "now": Date().timeIntervalSince1970]
    }

    // MARK: - Vignette chiffrée, servie une fois sur le LAN

    private static var offers: [String: (data: Data, exp: Date)] = [:]
    private static var listener: NWListener?
    private static let net = DispatchQueue(label: "nokker.camera.lan")

    static func b64u(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    /// Chiffre : iv (12) ‖ chiffré ‖ tag, AAD « nokker-thumb-v1|<id> ».
    static func seal(_ plain: Data, id: String, key: SymmetricKey) throws -> Data {
        let box = try AES.GCM.seal(plain, using: key, nonce: AES.GCM.Nonce(), authenticating: Data("nokker-thumb-v1|\(id)".utf8))
        return box.nonce.withUnsafeBytes { Data($0) } + box.ciphertext + box.tag
    }

    static func open(_ data: Data, id: String, key: SymmetricKey) throws -> Data {
        guard data.count >= 28 else { throw Fail(code: "bad_thumb") }
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: data.prefix(12)), ciphertext: data.dropFirst(12).dropLast(16), tag: data.suffix(16))
        return try AES.GCM.open(box, using: key, authenticating: Data("nokker-thumb-v1|\(id)".utf8))
    }

    /// Adresse IPv4 du Wi-Fi (en0).
    static func wifiIPv4() -> String? {
        var ifs: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifs) == 0, let first = ifs else { return nil }
        defer { freeifaddrs(first) }
        var p: UnsafeMutablePointer<ifaddrs>? = first
        while let i = p {
            if String(cString: i.pointee.ifa_name) == "en0", let sa = i.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) {
                var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                if getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 { return String(cString: host) }
            }
            p = i.pointee.ifa_next
        }
        return nil
    }

    /// `camera.thumb_url {id}` → `{id, url, key, expires_in}` ; la vignette n'existe en clair que sur cet appareil.
    static func thumbOffer(id: String, host: String? = nil) -> Result<[String: Any], Fail> {
        guard events().contains(where: { $0.id == id }) else { return .failure(Fail(code: "not_found")) }
        guard let plain = try? Data(contentsOf: thumbURL(id)) else { return .failure(Fail(code: "thumb_gone")) }
        guard let ip = host ?? wifiIPv4() else { return .failure(Fail(code: "not_home_wifi")) }
        let key = SymmetricKey(size: .bits256)
        guard let sealed = try? seal(plain, id: id, key: key) else { return .failure(Fail(code: "thumb_gone")) }
        var t = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, t.count, &t)
        let token = b64u(Data(t))
        net.sync {
            let now = Date()
            offers = offers.filter { $0.value.exp > now }
            offers[token] = (sealed, now.addingTimeInterval(thumbTTL))
        }
        startListener()
        net.asyncAfter(deadline: .now() + thumbTTL + 1) { closeIfIdle() } // offre échue sans lecture : écoute fermée
        let raw = key.withUnsafeBytes { Data($0) }
        return .success(["id": id, "url": "http://\(ip):\(port)/t/\(token)", "key": b64u(raw), "expires_in": Int(thumbTTL)])
    }

    /// L'écoute :8802 n'est ouverte que pendant qu'une vignette attend (≤ 5 min) ; rien ne s'annonce sur le LAN (P10d).
    private static func closeIfIdle() {
        let now = Date()
        offers = offers.filter { $0.value.exp > now }
        guard offers.isEmpty, let l = listener else { return }
        l.cancel()
        listener = nil
        NSLog("NokkerCamera: lan listener closed")
    }

    /// Une seule lecture par URL : la réponse retire l'offre ; 404 pour tout le reste.
    private static func startListener() {
        net.async {
            guard listener == nil, let l = try? NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: port)!) else { return }
            l.newConnectionHandler = { c in
                c.start(queue: net)
                c.receive(minimumIncompleteLength: 1, maximumLength: 4096) { data, _, _, _ in
                    let line = data.flatMap { String(data: $0, encoding: .utf8) }?.split(separator: "\r\n").first ?? ""
                    let parts = line.split(separator: " ")
                    var body = Data()
                    var status = "404 Not Found"
                    if parts.count >= 2, parts[0] == "GET", parts[1].hasPrefix("/t/") {
                        let token = String(parts[1].dropFirst(3))
                        if let o = offers.removeValue(forKey: token), o.exp > Date() {
                            body = o.data
                            status = "200 OK"
                        }
                        closeIfIdle()
                    }
                    let head = "HTTP/1.1 \(status)\r\nContent-Type: application/octet-stream\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
                    c.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in c.cancel() })
                }
            }
            l.start(queue: net)
            listener = l
        }
    }

    /// Côté téléphone du titulaire : lit le chiffré sur le LAN (URL privée seulement) et le déchiffre.
    static func fetchLocal(url: String, key: String, id: String, _ done: @escaping (Result<Data, Fail>) -> Void) {
        guard let u = URL(string: url), u.scheme == "http", u.port == Int(port), u.path.hasPrefix("/t/"), let h = u.host,
              let v4 = NokkerHome.parseV4(h), NokkerHome.privateV4(v4) || isLoopbackCI(v4),
              let raw = Data(base64Encoded: key.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/").padding(toLength: ((key.count + 3) / 4) * 4, withPad: "=", startingAt: 0)), raw.count == 32
        else { return DispatchQueue.main.async { done(.failure(Fail(code: "bad_args"))) } }
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 8
        cfg.urlCache = nil
        URLSession(configuration: cfg).dataTask(with: u) { data, resp, error in
            let st = (resp as? HTTPURLResponse)?.statusCode ?? 0
            // Écoute fermée (URL déjà lue ou échue) : connexion refusée = vignette partie ; injoignable = hors Wi-Fi.
            let refused = (error as? URLError)?.code == .cannotConnectToHost
            let r: Result<Data, Fail>
            if st == 200, let data, let plain = try? open(data, id: id, key: SymmetricKey(data: raw)) { r = .success(plain) }
            else { r = .failure(Fail(code: st == 404 || refused ? "thumb_gone" : "not_home_wifi")) }
            DispatchQueue.main.async { done(r) }
        }.resume()
    }

    private static func isLoopbackCI(_ v4: [UInt8]) -> Bool {
        #if DEBUG
        return ciLoopback && v4.first == 127
        #else
        return false
        #endif
    }

    // MARK: - Capture (premier plan, en charge)

    private static var session: AVCaptureSession?
    private static var sink: Sink?
    private static var banner: UILabel?

    /// La veille tourne : allumée, autorisée, mode maison, en charge, premier plan.
    static func shouldRun(foreground: Bool) -> Bool {
        let dev = UIDevice.current
        dev.isBatteryMonitoringEnabled = true
        let charging = dev.batteryState == .charging || dev.batteryState == .full
        return on && permission == "granted" && NokkerHome.on && charging && foreground
    }

    static var running: Bool { session?.isRunning == true }

    /// Démarre ou arrête selon les conditions (fil principal).
    static func apply(foreground: Bool) {
        if shouldRun(foreground: foreground) { start() } else { stop() }
    }

    private static func start() {
        guard session == nil else { return }
        let s = AVCaptureSession()
        s.sessionPreset = .vga640x480
        let pos: AVCaptureDevice.Position = position == "front" ? .front : .back
        guard let cam = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: pos), let input = try? AVCaptureDeviceInput(device: cam), s.canAddInput(input) else { return }
        s.addInput(input)
        let out = AVCaptureVideoDataOutput()
        out.alwaysDiscardsLateVideoFrames = true
        out.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
        let k = Sink(threshold: threshold(sensitivity))
        out.setSampleBufferDelegate(k, queue: DispatchQueue(label: "nokker.camera.frames"))
        guard s.canAddOutput(out) else { return }
        s.addOutput(out)
        session = s
        sink = k
        DispatchQueue.global(qos: .utility).async { s.startRunning() }
        showBanner(true)
        NSLog("NokkerCamera: watch started")
    }

    static func stop() {
        guard let s = session else { return showBanner(false) }
        session = nil
        sink = nil
        DispatchQueue.global(qos: .utility).async { s.stopRunning() }
        showBanner(false)
        NSLog("NokkerCamera: watch stopped")
    }

    /// Bandeau permanent au-dessus de tout (le mur compris) : pas de veille cachée.
    private static func showBanner(_ show: Bool) {
        DispatchQueue.main.async {
            if !show { banner?.removeFromSuperview(); banner = nil; return }
            guard banner == nil, let w = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.windows.first(where: \.isKeyWindow) }).first else { return }
            let fr = Locale.preferredLanguages.first?.hasPrefix("fr") ?? false
            let l = UILabel()
            l.text = fr ? "  ● Caméra de veille active  " : "  ● Watch camera on  "
            l.font = .systemFont(ofSize: 13, weight: .semibold)
            l.textColor = .white
            l.backgroundColor = UIColor(red: 0.75, green: 0.1, blue: 0.1, alpha: 0.9)
            l.layer.cornerRadius = 10
            l.clipsToBounds = true
            l.accessibilityTraits = .staticText
            l.translatesAutoresizingMaskIntoConstraints = false
            w.addSubview(l)
            NSLayoutConstraint.activate([l.topAnchor.constraint(equalTo: w.safeAreaLayoutGuide.topAnchor, constant: 6), l.trailingAnchor.constraint(equalTo: w.safeAreaLayoutGuide.trailingAnchor, constant: -8), l.heightAnchor.constraint(equalToConstant: 24)])
            banner = l
        }
    }

    /// Images de la caméra → luminance 64×48 → détecteur ; à l'ouverture d'un événement : Vision et vignette.
    final class Sink: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
        let detector: Detector
        private var last = Date.distantPast
        init(threshold: Double) { detector = Detector(threshold: threshold) }

        func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
            let now = Date()
            guard now.timeIntervalSince(last) >= 0.5, let px = CMSampleBufferGetImageBuffer(sample) else { return } // 2 images/s
            last = now
            guard detector.feed(NokkerCamera.luma64x48(px), at: now) else { return }
            let req = VNDetectHumanRectanglesRequest()
            try? VNImageRequestHandler(cvPixelBuffer: px, options: [:]).perform([req])
            let person = !(req.results ?? []).isEmpty
            let ci = CIImage(cvPixelBuffer: px)
            let jpeg = CIContext().jpegRepresentation(of: ci.transformed(by: CGAffineTransform(scaleX: 0.75, y: 0.75)), colorSpace: CGColorSpaceCreateDeviceRGB(), options: [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.6])
            var t = [UInt8](repeating: 0, count: 8)
            _ = SecRandomCopyBytes(kSecRandomDefault, t.count, &t)
            let id = "cam_" + t.map { String(format: "%02x", $0) }.joined()
            NokkerCamera.record(Event(id: id, camera: NokkerCamera.name, start: now.timeIntervalSince1970, end: now.timeIntervalSince1970, person: person, hasThumb: false), jpeg: jpeg)
            NSLog("NokkerCamera: event \(person ? "person" : "motion")")
        }
    }

    /// Plan Y (luminance) d'une image 420 réduit à 64×48 par échantillonnage.
    static func luma64x48(_ px: CVPixelBuffer) -> [UInt8] {
        CVPixelBufferLockBaseAddress(px, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(px, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddressOfPlane(px, 0) else { return [] }
        let w = CVPixelBufferGetWidthOfPlane(px, 0), h = CVPixelBufferGetHeightOfPlane(px, 0), row = CVPixelBufferGetBytesPerRowOfPlane(px, 0)
        let p = base.assumingMemoryBound(to: UInt8.self)
        var out = [UInt8](repeating: 0, count: 64 * 48)
        for y in 0..<48 { for x in 0..<64 { out[y * 64 + x] = p[(y * h / 48) * row + (x * w / 64)] } }
        return out
    }

    // MARK: - Autotest du CI (debug seulement)

    #if DEBUG
    static var ciLoopback = false

    /// Images synthétiques (le simulateur n'a pas de caméra) : fond fixe puis carré mobile → UN événement (anti-rafale) ;
    /// vignette rangée en `complete` ; purge au-delà de 24 h ; URL à usage unique servie sur la boucle locale (1re
    /// lecture déchiffrée, 2e : 404).
    static func selfTest() {
        let d = Detector(threshold: threshold("medium"))
        let t0 = Date()
        func frame(_ k: Int) -> [UInt8] {
            var f = [UInt8](repeating: 40, count: 64 * 48)
            guard k >= 0 else { return f }
            for y in 10..<30 { for x in (k * 4)..<min(64, k * 4 + 20) { f[y * 64 + x] = 220 } }
            return f
        }
        var fired = 0
        for i in 0..<4 where d.feed(frame(-1), at: t0.addingTimeInterval(Double(i) * 0.5)) { fired += 1 }
        for i in 0..<8 where d.feed(frame(i), at: t0.addingTimeInterval(2 + Double(i) * 0.5)) { fired += 1 }
        let id = "cam_selftest"
        let jpeg = UIGraphicsImageRenderer(size: CGSize(width: 32, height: 24)).jpegData(withCompressionQuality: 0.6) { c in UIColor.darkGray.setFill(); c.fill(CGRect(x: 0, y: 0, width: 32, height: 24)) }
        let old = Event(id: "cam_old", camera: "CI", start: t0.timeIntervalSince1970 - 25 * 3600, end: t0.timeIntervalSince1970 - 25 * 3600, person: false, hasThumb: false)
        record(old, jpeg: jpeg, now: t0.addingTimeInterval(-25 * 3600))
        record(Event(id: id, camera: "CI", start: t0.timeIntervalSince1970, end: t0.timeIntervalSince1970, person: false, hasThumb: false), jpeg: jpeg, now: t0)
        let list = events()
        let purged = !list.contains(where: { $0.id == "cam_old" }) && !FileManager.default.fileExists(atPath: thumbURL("cam_old").path)
        let prot = (try? FileManager.default.attributesOfItem(atPath: thumbURL(id).path)[.protectionKey] as? FileProtectionType) ?? nil
        let protOK = prot == .complete || prot == nil // simulateur : souvent sans protection de données
        ciLoopback = true
        guard case .success(let o) = thumbOffer(id: id, host: "127.0.0.1"), let url = o["url"] as? String, let key = o["key"] as? String else {
            return NSLog("NokkerCamera: self-test FAILED offer")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            fetchLocal(url: url, key: key, id: id) { first in
                fetchLocal(url: url, key: key, id: id) { second in
                    var firstOK = false
                    if case .success(let plain) = first { firstOK = plain == jpeg }
                    var secondGone = false
                    if case .failure(let f) = second { secondGone = f.code == "thumb_gone" }
                    let ok = fired == 1 && purged && protOK && firstOK && secondGone
                    NSLog("NokkerCamera: self-test \(ok ? "ok" : "FAILED") (events \(fired), purge \(purged), protection \(prot.map { $0.rawValue } ?? "n/a (simulator)"), once \(firstOK && secondGone))")
                    forget()
                }
            }
        }
    }
    #endif
}
