import AVFoundation
import Capacitor
import CryptoKit
import Foundation
import Network
import Security
import UIKit

/// `Capacitor.Plugins.NokkerNode` — le téléphone comme NŒUD du compte (LOKKAL-PHONE §3, lot P7, phase S).
///
/// - Clé P-256 du nœud : dans la Secure Enclave quand elle existe (appareil), logicielle sinon (simulateur) ; elle ne
///   sort jamais, seul son SPKI (DER, base64url) part avec l'inscription. Clé et jeton de machine vivent dans le
///   trousseau (`AfterFirstUnlockThisDeviceOnly` : ni sauvegarde, ni autre appareil).
/// - Chaque requête du nœud porte `X-Nokker-Node-Proof: v1;ts=…;nonce=…;sig=…`, ES256 (r||s, 64 o) sur
///   `method\nhost\npath?query\nts\nnonce\nsha256hex(corps)`.
/// - Phase S : pas d'APNs. Au premier plan seulement : battement toutes les 60 s (`reach: live`) et long poll de la file
///   (`wait=25`), par URLSession, sans passer par la WebView. En arrière-plan, la boucle s'arrête.
/// - Table FERMÉE d'opérations : `zone.state`, `calendar.list`, `ocr.image`, `stt.audio`, `fetch.get` (P11) et le
///   relais Home Assistant du mode maison (P10a, `ha.*`, NokkerHome.swift) ; tout le reste rend `unknown_op`. Un nœud
///   non attesté ne fait que des LECTURES : `ha.call_service`, `ha.notify`, `ha.tracker_see` rendent
///   `attestation_required` tant que l'attestation (P3) n'existe pas. Résultat ≤ 64 Kio (1 Mio, 256 Kio : `maxResult`).
@objc(NokkerNodePlugin)
public class NokkerNodePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NokkerNodePlugin"
    public let jsName = "NokkerNode"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enroll", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forget", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setEgress", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setHome", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "promptHaToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "markHomeWifi", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkHa", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forgetHome", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setWall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wallToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setWallToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wallCheck", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authenticateExit", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setCamera", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetchLocalImage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discoverLan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discoverHa", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setKnock", returnType: CAPPluginReturnPromise)
    ]

    static let resultMax = 64 * 1024
    static let beatEvery: TimeInterval = 60
    static let haOps: Set<String> = ["ha.states", "ha.registry", "ha.call_service", "ha.query", "ha.history", "ha.logbook", "ha.notify", "ha.tracker_see", "ha.events"]
    /// Actions sur la maison : jamais par un nœud NON attesté (la phase S n'a pas d'attestation : refusées ici aussi).
    static let haWriteOps: Set<String> = ["ha.call_service", "ha.notify", "ha.tracker_see"]
    static let ops: Set<String> = Set(["zone.state", "calendar.list", "ocr.image", "stt.audio", "fetch.get", "camera.watch_event", "camera.thumb_url", "lan.discover"]).union(haOps)
    /// `fetch.get` (P11) rend jusqu'à 1 Mio ; états, registre, historique et journal de HA (P10a) 256 Kio ; le reste 64 Kio.
    static func maxResult(for op: String) -> Int {
        op == "fetch.get" ? 1024 * 1024 : ["ha.states", "ha.registry", "ha.history", "ha.logbook"].contains(op) ? 256 * 1024 : resultMax
    }
    /// Chemin réseau courant (Wi-Fi, cellulaire, données réduites) pour `fetch.get`.
    private let pathMonitor = NWPathMonitor()

    /// Posé par NokkerViewController : l'agenda passe par la même lecture que P8.
    weak var pim: NokkerPimPlugin?
    private var base: URL?
    private var running = false
    private var foreground = true
    private var wallWasOn = false
    private var beatTimer: Timer?
    private var polling = false
    private var lastBeat: Date?
    private var lastError: String?
    private lazy var session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 40
        c.httpCookieStorage = nil
        c.urlCache = nil
        return URLSession(configuration: c)
    }()

    // MARK: - Trousseau

    private static let service = "ai.nokker.node"

    static func kcSet(_ account: String, _ data: Data) -> Bool {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(q as CFDictionary)
        var add = q
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    static func kcGet(_ account: String) -> Data? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
                                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    static func kcDelete(_ account: String) {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account] as CFDictionary)
    }

    // MARK: - Clé du nœud

    /// Signataire : Secure Enclave (la donnée du trousseau n'est qu'une référence chiffrée, inutilisable ailleurs) ou
    /// clé logicielle (simulateur).
    enum NodeKey {
        case enclave(SecureEnclave.P256.Signing.PrivateKey)
        case software(P256.Signing.PrivateKey)

        var publicKey: P256.Signing.PublicKey {
            switch self {
            case .enclave(let k): return k.publicKey
            case .software(let k): return k.publicKey
            }
        }
        var storage: String {
            if case .enclave = self { return "secure_enclave" }
            return "software"
        }
        func sign(_ data: Data) throws -> Data {
            switch self {
            case .enclave(let k): return try k.signature(for: data).rawRepresentation
            case .software(let k): return try k.signature(for: data).rawRepresentation
            }
        }
    }

    static func loadKey() -> NodeKey? {
        guard let raw = kcGet("key"), let kind = kcGet("key-kind").flatMap({ String(data: $0, encoding: .utf8) }) else { return nil }
        if kind == "secure_enclave", let k = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: raw) { return .enclave(k) }
        if kind == "software", let k = try? P256.Signing.PrivateKey(rawRepresentation: raw) { return .software(k) }
        return nil
    }

    static func makeKey() -> NodeKey? {
        if SecureEnclave.isAvailable, let k = try? SecureEnclave.P256.Signing.PrivateKey() {
            guard kcSet("key", k.dataRepresentation), kcSet("key-kind", Data("secure_enclave".utf8)) else { return nil }
            return .enclave(k)
        }
        let k = P256.Signing.PrivateKey()
        guard kcSet("key", k.rawRepresentation), kcSet("key-kind", Data("software".utf8)) else { return nil }
        return .software(k)
    }

    /// Clé d'ACCORD (ECDH) du nœud, distincte de la clé de signature : le noyau y scelle le jeton de machine, que seul le
    /// natif ouvre (la WebView ne voit qu'un blob opaque).
    enum AgreeKey {
        case enclave(SecureEnclave.P256.KeyAgreement.PrivateKey)
        case software(P256.KeyAgreement.PrivateKey)

        var publicKey: P256.KeyAgreement.PublicKey {
            switch self {
            case .enclave(let k): return k.publicKey
            case .software(let k): return k.publicKey
            }
        }
        func shared(with pub: P256.KeyAgreement.PublicKey) throws -> SharedSecret {
            switch self {
            case .enclave(let k): return try k.sharedSecretFromKeyAgreement(with: pub)
            case .software(let k): return try k.sharedSecretFromKeyAgreement(with: pub)
            }
        }
    }

    static func loadAgree() -> AgreeKey? {
        guard let raw = kcGet("enc-key"), let kind = kcGet("enc-kind").flatMap({ String(data: $0, encoding: .utf8) }) else { return nil }
        if kind == "secure_enclave", let k = try? SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: raw) { return .enclave(k) }
        if kind == "software", let k = try? P256.KeyAgreement.PrivateKey(rawRepresentation: raw) { return .software(k) }
        return nil
    }

    static func makeAgree() -> AgreeKey? {
        if SecureEnclave.isAvailable, let k = try? SecureEnclave.P256.KeyAgreement.PrivateKey() {
            guard kcSet("enc-key", k.dataRepresentation), kcSet("enc-kind", Data("secure_enclave".utf8)) else { return nil }
            return .enclave(k)
        }
        let k = P256.KeyAgreement.PrivateKey()
        guard kcSet("enc-key", k.rawRepresentation), kcSet("enc-kind", Data("software".utf8)) else { return nil }
        return .software(k)
    }

    static func fromB64u(_ s: String) -> Data? {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)
    }

    /// Ouvre le sceau du noyau : ECDH (clé éphémère `epk`) → HKDF-SHA256 (sel vide, info `nokker-phone-v1|<approval_id>`)
    /// → AES-256-GCM (données associées = approval_id ; `ct` porte l'étiquette de 16 o à la fin, comme WebCrypto).
    static func openSealed(_ key: AgreeKey, approvalId: String, x: String, y: String, iv: String, ct: String) throws -> String {
        guard let xd = fromB64u(x), let yd = fromB64u(y), let ivd = fromB64u(iv), let ctd = fromB64u(ct), xd.count == 32, yd.count == 32, ctd.count > 16 else {
            throw CryptoKitError.incorrectParameterSize
        }
        let epk = try P256.KeyAgreement.PublicKey(rawRepresentation: xd + yd)
        let sym = try key.shared(with: epk).hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(), sharedInfo: Data("nokker-phone-v1|\(approvalId)".utf8), outputByteCount: 32)
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: ivd), ciphertext: ctd.prefix(ctd.count - 16), tag: ctd.suffix(16))
        let pt = try AES.GCM.open(box, using: sym, authenticating: Data(approvalId.utf8))
        guard let o = try JSONSerialization.jsonObject(with: pt) as? [String: Any], let tok = o["machine_token"] as? String, !tok.isEmpty else {
            throw CryptoKitError.incorrectParameterSize
        }
        return tok
    }

    static func b64u(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    static func hex(_ d: some Sequence<UInt8>) -> String { d.map { String(format: "%02x", $0) }.joined() }
    static func fingerprint(_ pub: P256.Signing.PublicKey) -> String { String(hex(SHA256.hash(data: pub.derRepresentation)).prefix(8)) }

    /// Chaîne signée par la preuve (même forme que `proofString` du SDK).
    static func proofString(method: String, host: String, pathQuery: String, ts: Int, nonce: String, body: Data) -> String {
        "\(method.uppercased())\n\(host.lowercased())\n\(pathQuery)\n\(ts)\n\(nonce)\n\(hex(SHA256.hash(data: body)))"
    }

    static func proofHeader(_ key: NodeKey, method: String, url: URL, body: Data) throws -> String {
        let ts = Int(Date().timeIntervalSince1970)
        var nb = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, nb.count, &nb)
        let nonce = b64u(Data(nb))
        let host = url.port.map { "\(url.host ?? ""):\($0)" } ?? (url.host ?? "")
        let pq = url.path + (url.query.map { "?\($0)" } ?? "")
        let sig = try key.sign(Data(proofString(method: method, host: host, pathQuery: pq, ts: ts, nonce: nonce, body: body).utf8))
        return "v1;ts=\(ts);nonce=\(nonce);sig=\(b64u(sig))"
    }

    // MARK: - Interface

    private func statusPayload() -> [String: Any] {
        let key = Self.loadKey()
        var o: [String: Any] = ["enrolled": Self.kcGet("token") != nil, "running": running, "secure_enclave_available": SecureEnclave.isAvailable]
        if let key { o["key_storage"] = key.storage; o["key_fingerprint"] = Self.fingerprint(key.publicKey) }
        if let id = Self.kcGet("machine").flatMap({ String(data: $0, encoding: .utf8) }) { o["machine_id"] = id }
        if let b = Self.kcGet("base").flatMap({ String(data: $0, encoding: .utf8) }) { o["base_url"] = b }
        if let lastBeat { o["last_beat_at"] = ISO8601DateFormatter().string(from: lastBeat) }
        if let lastError { o["last_error"] = lastError }
        o["egress"] = ["on": NokkerEgress.enabled, "cellular": NokkerEgress.cellularAllowed, "cellular_cap_mb": NokkerEgress.cellCapMB, "cellular_used_mb": NokkerEgress.cellUsedBytes / (1024 * 1024)]
        o["home"] = Self.homePayload()
        o["knock"] = NokkerKnock.payload()
        return o
    }

    @objc func status(_ call: CAPPluginCall) { call.resolve(statusPayload()) }

    /// Clés du nœud (créées au premier appel) : SPKI de signature et d'accord à mettre dans `POST /v1/link/phone`.
    @objc func prepareKey(_ call: CAPPluginCall) {
        guard let key = Self.loadKey() ?? Self.makeKey(), let agree = Self.loadAgree() ?? Self.makeAgree() else { return call.reject("key_unavailable") }
        call.resolve(["public_key_spki": Self.b64u(key.publicKey.derRepresentation), "enc_key_spki": Self.b64u(agree.publicKey.derRepresentation),
                      "key_storage": key.storage, "key_fingerprint": Self.fingerprint(key.publicKey)])
    }

    /// Jeton de machine rendu UNE fois par le noyau, SCELLÉ pour la clé d'accord : ouvert ici, rangé au trousseau. La
    /// WebView n'a jamais eu que le blob opaque.
    @objc func enroll(_ call: CAPPluginCall) {
        guard let id = call.getString("machine_id"), let approval = call.getString("approval_id"), let sealed = call.getObject("sealed_token"),
              let epk = sealed["epk"] as? [String: Any], let x = epk["x"] as? String, let y = epk["y"] as? String,
              let iv = sealed["iv"] as? String, let ct = sealed["ct"] as? String, let baseS = call.getString("base_url"),
              let base = URL(string: baseS), base.scheme == "https" || base.host == "127.0.0.1" || base.host == "localhost" else {
            return call.reject("bad_enroll")
        }
        guard Self.loadKey() != nil, let agree = Self.loadAgree() else { return call.reject("key_unavailable") }
        let token: String
        do { token = try Self.openSealed(agree, approvalId: approval, x: x, y: y, iv: iv, ct: ct) } catch { return call.reject("seal_invalid") }
        guard Self.kcSet("token", Data(token.utf8)), Self.kcSet("machine", Data(id.utf8)), Self.kcSet("base", Data(baseS.utf8)) else { return call.reject("keychain") }
        NSLog("NokkerNode: enrolled \(id)")
        call.resolve(statusPayload())
    }

    /// « Disponible pour Nina » décoché : retenu d'un lancement à l'autre.
    private static let pausedKey = "nokker.node.paused"

    @objc func start(_ call: CAPPluginCall) {
        guard Self.kcGet("token") != nil else { return call.reject("not_enrolled") }
        UserDefaults.standard.set(false, forKey: Self.pausedKey)
        running = true
        resume()
        call.resolve(statusPayload())
    }

    @objc func stop(_ call: CAPPluginCall) {
        UserDefaults.standard.set(true, forKey: Self.pausedKey)
        running = false
        pause()
        call.resolve(statusPayload())
    }

    /// Oubli local (après révocation, ou « retirer ce téléphone ») : clé, jeton, adresse.
    @objc func forget(_ call: CAPPluginCall) {
        running = false
        pause()
        Self.wipe()
        UserDefaults.standard.removeObject(forKey: Self.pausedKey)
        NSLog("NokkerNode: forgotten")
        call.resolve(statusPayload())
    }

    static let accounts = ["token", "machine", "base", "key", "key-kind", "enc-key", "enc-kind"]
    static func wipe() {
        for a in accounts { kcDelete(a) }
        NokkerHome.forget() // jeton HA, Wi-Fi maison et réglages : avec le nœud
        NokkerWall.forget()
        NokkerCamera.forget() // vignettes et événements de la veille
        NokkerDiscovery.forget() // sel des identifiants des appareils du réseau local
        NokkerKnock.forget() // Frapper pour appeler : éteint
    }

    // MARK: - Nœud maison (P10a)

    /// État du mode maison pour la WebView (`HomeNodeStatus` du SDK) : jamais le jeton.
    static func homePayload() -> [String: Any] {
        ["on": NokkerHome.on, "ha_url": NokkerHome.baseURL.map { $0 as Any } ?? NSNull(), "ha_token_set": NokkerHome.tokenSet, "entities": NokkerHome.entities,
         "home_wifi_set": NokkerHome.homeWifiSet, "home_wifi": NokkerHome.homeWifiNow, "ha_check": NokkerHome.lastCheck.map { $0 as Any } ?? NSNull(),
         "lan_home": NokkerHome.lanHome ? "on" : "off", "camera": cameraPayload()]
    }

    /// Veille caméra (P10c) : réglages et état, jamais d'image.
    static func cameraPayload() -> [String: Any] {
        ["on": NokkerCamera.on, "name": NokkerCamera.name, "sensitivity": NokkerCamera.sensitivity, "position": NokkerCamera.position,
         "permission": NokkerCamera.permission, "cap": NokkerCamera.running ? "on" : "off", "events": NokkerCamera.events().count, "bytes": NokkerCamera.bytesStored()]
    }

    /// `{on?, name?, sensitivity?, position?}` ; l'allumage demande l'accès à la caméra (refus : `denied`).
    @objc func setCamera(_ call: CAPPluginCall) {
        if let n = call.getString("name") {
            let t = n.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty, t.count <= 40 else { return call.reject("bad_name", "bad_name") }
            NokkerCamera.name = t
        }
        if let s = call.getString("sensitivity") { NokkerCamera.sensitivity = s }
        if let p = call.getString("position") { NokkerCamera.position = p }
        let finish = { [weak self] in
            DispatchQueue.main.async {
                guard let self else { return }
                NokkerCamera.stop() // relancée avec les nouveaux réglages si les conditions sont réunies
                NokkerCamera.apply(foreground: self.foreground)
                call.resolve(self.statusPayload())
                self.beat()
            }
        }
        guard let on = call.getBool("on") else { return finish() }
        NokkerCamera.on = on
        if on && NokkerCamera.permission == "undetermined" {
            AVCaptureDevice.requestAccess(for: .video) { _ in finish() }
        } else { finish() }
    }

    /// P10d : appareils du réseau local vus d'ici (réglages) — noms et types seulement.
    @objc func discoverLan(_ call: CAPPluginCall) {
        var p: [String: Any] = ["timeout_s": 3]
        if let t = call.getArray("types") as? [String] { p["types"] = t }
        NokkerDiscovery.discover(p) { r in
            switch r {
            case .success(let v): call.resolve(v)
            case .failure(let f): call.reject(f.code, f.code)
            }
        }
    }

    /// P10d : « Trouver Home Assistant » — URL interne annoncée par HA, sur l'appareil, acceptée par normalizeBase.
    @objc func discoverHa(_ call: CAPPluginCall) {
        NokkerDiscovery.haCandidates { list in call.resolve(["candidates": list]) }
    }

    /// Téléphone du titulaire : vignette lue sur le LAN (URL privée, usage unique) et déchiffrée ici ; `{data}` (base64).
    @objc func fetchLocalImage(_ call: CAPPluginCall) {
        guard let url = call.getString("url"), let key = call.getString("key"), let id = call.getString("id") else { return call.reject("bad_args", "bad_args") }
        NokkerCamera.fetchLocal(url: url, key: key, id: id) { r in
            switch r {
            case .success(let d): call.resolve(["data": d.base64EncodedString(), "type": "image/jpeg"])
            case .failure(let f): call.reject(f.code, f.code)
            }
        }
    }

    private func applyIdle() {
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = (NokkerHome.on || NokkerWall.on) && self.foreground
            // Frapper pour appeler : nœud maison seulement ; quitter le mode maison l'éteint (le propriétaire rallume).
            if !NokkerHome.on && (NokkerKnock.on || NokkerKnock.cut) { NokkerKnock.forget() } else { NokkerKnock.apply(foreground: self.foreground) }
        }
    }

    // MARK: - Frapper pour appeler (nœud maison)

    /// `{on: true}` : Face ID, Touch ID ou code du propriétaire, puis micro (rejet `auth_failed`, `no_passcode`,
    /// `denied`, `not_home`). `{on: false}` : SANS authentification (n'importe qui peut couper).
    @objc func setKnock(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            guard on else {
                NokkerKnock.turnOff(fromBanner: false)
                return call.resolve(self.statusPayload())
            }
            NokkerKnock.turnOn { err in
                if let err { return call.reject(err, err) }
                call.resolve(self.statusPayload())
            }
        }
    }

    // MARK: - Écran mural (P10b)

    /// `{on}` : écran allumé et luminosité de nuit tant que la page murale est affichée.
    @objc func setWall(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            NokkerWall.active = on && NokkerWall.token != nil
            NokkerWall.set(on, foreground: self.foreground)
            NokkerKnock.apply() // le mur n'écoute pas ici (voix du foyer : lot à part)
            call.resolve(["on": NokkerWall.on, "night": NokkerWall.isNight()])
        }
    }

    /// Le jeton `nkg_` du mur, remis EN MÉMOIRE à la page murale (lecture seule, révocable) ; jamais journalisé.
    @objc func wallToken(_ call: CAPPluginCall) {
        call.resolve(["token": NokkerWall.token.map { $0 as Any } ?? NSNull(), "device_id": NokkerWall.deviceId.map { $0 as Any } ?? NSNull(), "night": NokkerWall.isNight(), "active": NokkerWall.active])
    }

    /// `{passcode}` : l'appareil a un code (sinon le mur est refusé : sa sortie ne serait pas protégée).
    @objc func wallCheck(_ call: CAPPluginCall) {
        call.resolve(["passcode": NokkerWall.hasPasscode()])
    }

    /// Sortie du mur : biométrie ou code du propriétaire de l'appareil. `{ok}`.
    @objc func authenticateExit(_ call: CAPPluginCall) {
        let fr = Locale.preferredLanguages.first?.hasPrefix("fr") ?? false
        NokkerWall.authenticateExit(reason: call.getString("reason") ?? (fr ? "Quitter l'écran mural" : "Leave the wall screen")) { ok in
            call.resolve(["ok": ok])
        }
    }

    /// `{token, device_id}` après l'appairage du mur, ou `{}` pour l'oublier (révoqué, ou « ne plus servir de mur »).
    @objc func setWallToken(_ call: CAPPluginCall) {
        guard let t = call.getString("token"), let id = call.getString("device_id") else {
            NokkerWall.forget()
            return call.resolve(["stored": false])
        }
        guard t.hasPrefix("nkg_"), t.count <= 200, !id.isEmpty, id.count <= 100 else { return call.reject("bad_token", "bad_token") }
        call.resolve(["stored": NokkerWall.store(token: t, deviceId: id)])
    }

    /// `{on?, ha_url?, entities?}` : URL privée seulement (`bad_url`), motifs `domaine.objet` (`bad_entities`).
    @objc func setHome(_ call: CAPPluginCall) {
        if let raw = call.getString("ha_url") {
            guard let base = NokkerHome.normalizeBase(raw) else { return call.reject("bad_url", "bad_url") }
            if base != NokkerHome.baseURL { NokkerHome.baseURL = base; NokkerHome.lastCheck = nil }
        }
        if let list = call.getArray("entities") as? [String] {
            let norm = list.map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
            guard norm.count <= 100, norm.allSatisfy({ $0 != "*.*" && $0.range(of: "^[a-z_*?][a-z0-9_*?]*\\.[a-z0-9_*?]+$", options: .regularExpression) != nil }) else { return call.reject("bad_entities", "bad_entities") }
            NokkerHome.entities = Array(NSOrderedSet(array: norm)) as? [String] ?? norm
        }
        if let on = call.getBool("on") { NokkerHome.on = on }
        applyIdle()
        NokkerHome.refreshWifi { [weak self] _ in
            guard let self else { return }
            call.resolve(self.statusPayload())
            self.beat() // le noyau apprend tout de suite le mode et `lan_home`
        }
    }

    /// Champ NATIF sécurisé : le jeton HA ne passe jamais par la WebView. Rend `{saved}`.
    @objc func promptHaToken(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController else { return call.reject("no_view") }
            let fr = Locale.preferredLanguages.first?.hasPrefix("fr") ?? false
            let a = UIAlertController(title: fr ? "Jeton Home Assistant" : "Home Assistant token",
                                      message: fr ? "Jeton longue durée d'un compte qui n'est pas administrateur. Il reste sur cet appareil." : "Long-lived token of an account that is not an administrator. It stays on this device.",
                                      preferredStyle: .alert)
            a.addTextField { f in
                f.isSecureTextEntry = true
                f.autocorrectionType = .no
                f.autocapitalizationType = .none
                f.textContentType = .password
            }
            a.addAction(UIAlertAction(title: fr ? "Annuler" : "Cancel", style: .cancel) { _ in call.resolve(["saved": false]) })
            a.addAction(UIAlertAction(title: fr ? "Enregistrer" : "Save", style: .default) { [weak self] _ in
                let t = a.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                guard !t.isEmpty, t.count <= 4096, NokkerHome.setToken(t) else { return call.resolve(["saved": false]) }
                NokkerHome.lastCheck = nil
                call.resolve(["saved": true])
                self?.beat()
            })
            vc.present(a, animated: true)
        }
    }

    /// « Ce Wi-Fi est celui de la maison » : `{ok}` (faux si l'OS ne donne pas le réseau courant).
    @objc func markHomeWifi(_ call: CAPPluginCall) {
        NokkerHome.markHomeWifi { [weak self] ok in
            guard let self else { return }
            var o = self.statusPayload()
            o["ok"] = ok
            call.resolve(o)
            self.beat()
        }
    }

    /// Contrôle de HA (états, avec la liste d'entités) : `ha_check` = ok ou un code.
    @objc func checkHa(_ call: CAPPluginCall) {
        NokkerHome.run("ha.states", [:]) { [weak self] r in
            guard let self else { return }
            switch r {
            case .success: NokkerHome.lastCheck = "ok"
            case .failure(let f): NokkerHome.lastCheck = f.code
            }
            call.resolve(self.statusPayload())
        }
    }

    @objc func forgetHome(_ call: CAPPluginCall) {
        NokkerHome.forget()
        applyIdle()
        call.resolve(statusPayload())
        beat()
    }

    /// Le trousseau survit à la désinstallation, UserDefaults non : marqueur absent = nouvelle installation → on efface
    /// clés, jeton et adresse, et le téléphone se réinscrit. L'ancien nœud expire chez le noyau faute de battement et reste
    /// visible dans « mes machines » pour être retiré.
    private static let installedKey = "nokker.node.installed"

    /// « Laisser Nina ouvrir des pages par ce téléphone » (coupé par défaut) et plafond cellulaire mensuel (Mo).
    @objc func setEgress(_ call: CAPPluginCall) {
        if let on = call.getBool("on") { NokkerEgress.enabled = on }
        if let cap = call.getInt("cellular_cap_mb") { NokkerEgress.cellCapMB = cap }
        if let cell = call.getBool("cellular") { NokkerEgress.cellularAllowed = cell }
        call.resolve(statusPayload())
        beat() // le noyau apprend tout de suite si `egress` est allumé
    }

    override public func load() {
        // Trois coups (après le « oui ? » joué en natif) : le web lance UNE dictée sur l'appareil. Rien d'autre ne sort.
        NokkerKnock.onKnock = { [weak self] ev in self?.notifyListeners("knock", data: ev) }
        NokkerKnock.onState = { [weak self] in self?.emit() }
        pathMonitor.start(queue: DispatchQueue(label: "nokker.node.path"))
        if !UserDefaults.standard.bool(forKey: Self.installedKey) {
            let had = Self.kcGet("token") != nil
            Self.wipe()
            UserDefaults.standard.set(true, forKey: Self.installedKey)
            NSLog("NokkerNode: fresh install, keychain wiped (had token \(had))")
        }
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.foreground = false
            self?.pause()
            // Le mur rend la luminosité d'avant en arrière-plan, et se rallume au retour.
            self?.wallWasOn = NokkerWall.on
            if NokkerWall.on { NokkerWall.set(false, foreground: false) }
            NokkerCamera.stop() // iOS ne filme pas en arrière-plan : la veille s'arrête, le bandeau aussi
            self?.applyIdle()
        }
        NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.foreground = true
            self?.resume()
            if self?.wallWasOn == true { NokkerWall.set(true, foreground: true) }
            NokkerCamera.apply(foreground: true)
            self?.applyIdle()
        }
        NSLog("NokkerNode: loaded, enclave \(SecureEnclave.isAvailable), enrolled \(Self.kcGet("token") != nil)")
        // Inscrit et pas en pause : la boucle reprend au lancement (premier plan seulement).
        if Self.kcGet("token") != nil && !UserDefaults.standard.bool(forKey: Self.pausedKey) {
            running = true
            resume()
        }
        #if DEBUG
        let flag = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("nokker-ci-node")
        if FileManager.default.fileExists(atPath: flag.path) {
            try? FileManager.default.removeItem(at: flag)
            Self.selfTest()
            NokkerEgress.selfTest()
            NokkerWall.selfTest()
            NokkerCamera.selfTest()
            NokkerDiscovery.selfTest()
            NokkerKnock.selfTest()
        }
        // Nœud maison (P10a) : relais contre le faux HA du CI, URL et jeton de test dans le drapeau (jamais en release).
        let home = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("nokker-ci-home")
        if let d = try? Data(contentsOf: home), let o = try? JSONSerialization.jsonObject(with: d) as? [String: String], let u = o["url"], let t = o["token"] {
            try? FileManager.default.removeItem(at: home)
            NokkerHome.selfTest(url: u, token: t)
        }
        #endif
        applyIdle()
    }

    // MARK: - Boucle (premier plan)

    private func resume() {
        guard running, foreground else { return }
        DispatchQueue.main.async {
            self.beatTimer?.invalidate()
            self.beatTimer = Timer.scheduledTimer(withTimeInterval: Self.beatEvery, repeats: true) { [weak self] _ in self?.beat() }
            self.beat()
            self.pollLoop()
        }
    }

    private func pause() {
        DispatchQueue.main.async {
            self.beatTimer?.invalidate()
            self.beatTimer = nil
            // Long poll en vol : annulé (en arrière-plan, en pause, après l'oubli du jeton).
            self.session.getAllTasks { $0.forEach { $0.cancel() } }
        }
    }

    private var active: Bool { running && foreground }

    private func emit() { notifyListeners("nodeState", data: statusPayload()) }

    /// Requête signée du nœud. `done(statut, corps)` ; statut 0 = réseau.
    private func send(_ method: String, _ pathQuery: String, _ body: Any?, timeout: TimeInterval = 20, _ done: @escaping (Int, Data) -> Void) {
        guard let key = Self.loadKey(), let token = Self.kcGet("token").flatMap({ String(data: $0, encoding: .utf8) }),
              let baseS = Self.kcGet("base").flatMap({ String(data: $0, encoding: .utf8) }), let url = URL(string: baseS + pathQuery) else {
            return done(401, Data())
        }
        let data = body.flatMap { try? JSONSerialization.data(withJSONObject: $0) } ?? Data()
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if body != nil {
            req.httpBody = data
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        do { req.setValue(try Self.proofHeader(key, method: method, url: url, body: data), forHTTPHeaderField: "X-Nokker-Node-Proof") } catch { return done(0, Data()) }
        // Rappel sur le fil principal : l'état de la boucle (polling, lastBeat, running) n'est touché que là.
        session.dataTask(with: req) { d, r, _ in
            let st = (r as? HTTPURLResponse)?.statusCode ?? 0
            DispatchQueue.main.async { done(st, d ?? Data()) }
        }.resume()
    }

    /// Réseau du battement (P7b : le placement classe Wi-Fi avant cellulaire) : chemin courant de l'OS, jamais figé.
    /// `home_wifi` : le Wi-Fi courant est celui déclaré « maison » (P10a ; empreinte salée, le BSSID ne sort jamais).
    static func netOf(_ path: NWPath) -> [String: Any] {
        let type = path.status != .satisfied ? "none" : path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet) ? "wifi" : path.usesInterfaceType(.cellular) ? "cellular" : "none"
        return ["type": type, "metered": path.isExpensive || path.isConstrained, "home_wifi": type == "wifi" && NokkerHome.homeWifiNow]
    }

    private func beat() {
        guard active else { return }
        NokkerHome.refreshWifi { [weak self] _ in self?.sendBeat() }
    }

    private func sendBeat() {
        guard active else { return }
        NokkerCamera.apply(foreground: foreground) // en charge, premier plan, mode maison : relu à chaque battement
        let dev = UIDevice.current
        dev.isBatteryMonitoringEnabled = true
        let charging = dev.batteryState == .charging || dev.batteryState == .full
        let caps: [String: String] = [
            "location": NokkerZonesPlugin.readZones().isEmpty ? "off" : "on",
            "device_calendar": NokkerPimPlugin.eventStatus(.event) == "granted" ? "on" : "denied",
            "ocr": "on",
            "stt": NokkerTextPlugin.speechReady() ? "on" : "off",
            "egress": NokkerEgress.enabled ? "on" : "off",
            "lan_home": NokkerHome.lanHome ? "on" : "off",
            "camera": NokkerCamera.permission == "denied" ? "denied" : NokkerCamera.running ? "on" : "off"
        ]
        let b: [String: Any] = [
            "v": 1, "app_version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0",
            "os": "iOS \(dev.systemVersion)", "mode": NokkerHome.on ? "home" : "pocket", "reach": "live",
            "power": ["charging": charging, "level": max(0, Double(dev.batteryLevel))],
            "net": Self.netOf(pathMonitor.currentPath),
            "caps": caps, "queue": ["leased": 0], "slm": NSNull()
        ]
        send("POST", "/v1/gateway/phone/beat", b) { [weak self] st, _ in
            guard let self else { return }
            if st == 200 { self.lastBeat = Date(); self.lastError = nil } else { self.lastError = st == 401 ? "unauthorized" : "beat_\(st)" }
            if st == 401 { self.running = false; self.pause() } // jeton révoqué ou preuve refusée : on s'arrête
            NSLog("NokkerNode: beat \(st)")
            self.emit()
        }
    }

    private func pollLoop() {
        guard active, !polling else { return }
        polling = true
        send("GET", "/v1/gateway/phone/tasks?wait=25", nil, timeout: 35) { [weak self] st, data in
            guard let self else { return }
            self.polling = false
            if st == 200, let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let tasks = o["tasks"] as? [[String: Any]] {
                for t in tasks { self.run(t) }
                return self.pollLoop()
            }
            if st == 401 { self.running = false; self.pause(); self.lastError = "unauthorized"; return self.emit() }
            // Coupure ou erreur du serveur : on réessaie dans 10 s.
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) { self.pollLoop() }
        }
    }

    // MARK: - Opérations (table fermée, lecture seule)

    private func run(_ t: [String: Any]) {
        guard let id = t["task_id"] as? String, let op = t["op"] as? String else { return }
        let args = t["args"] as? [String: Any] ?? [:]
        let enc = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        let finish: ([String: Any]) -> Void = { [weak self] r in
            self?.send("POST", "/v1/gateway/phone/tasks/\(enc)/result", r) { st, _ in NSLog("NokkerNode: task \(op) \(r["status"] as? String ?? "?") \(st)") }
        }
        let failWhy: (String, String?) -> Void = { code, why in finish(["status": "failed", "error": why.map { ["code": code, "message": $0] } ?? ["code": code]]) }
        let fail: (String) -> Void = { failWhy($0, nil) }
        let ok: (Any) -> Void = { v in
            guard let d = try? JSONSerialization.data(withJSONObject: v), let s = String(data: d, encoding: .utf8) else { return fail("bad_result") }
            d.count > Self.maxResult(for: op) ? fail("result_too_large") : finish(["status": "done", "result": s])
        }
        guard Self.ops.contains(op) else { return fail("unknown_op") }
        // P9b : agenda, texte d'image et transcription partent MASQUÉS (dictionnaire du fil d'origine, sur l'appareil).
        let thread = (t["origin"] as? [String: Any])?["thread_id"] as? String ?? "_node"
        let masked: (String) -> String? = { NokkerVaultPlugin.maskForNode($0, thread: thread) }
        if ["calendar.list", "ocr.image", "stt.audio"].contains(op), NokkerVaultPlugin.rules == nil { return fail("redact_rules_unavailable") }
        if op == "lan.discover" {
            return NokkerDiscovery.discover(args) { r in
                switch r {
                case .success(let v): ok(v)
                case .failure(let f): fail(f.code)
                }
            }
        }
        if op == "camera.watch_event" {
            guard NokkerCamera.on else { return fail("camera_off") }
            let after = (args["after"] as? Double) ?? Double(args["after"] as? Int ?? 0)
            return ok(NokkerCamera.watchEvent(after: after, limit: (args["limit"] as? Int) ?? 200))
        }
        if op == "camera.thumb_url" {
            guard NokkerCamera.permission != "denied" else { return fail("denied") }
            guard let id = args["id"] as? String, id.range(of: "^[A-Za-z0-9._-]{1,64}$", options: .regularExpression) != nil else { return fail("bad_args") }
            return NokkerHome.refreshWifi { home in
                guard home else { return fail("not_home_wifi") }
                switch NokkerCamera.thumbOffer(id: id) {
                case .success(let o): ok(o)
                case .failure(let f): fail(f.code)
                }
            }
        }
        if Self.haOps.contains(op) {
            // Les actions sur la maison exigent un nœud attesté (P3) ; la phase S n'en a pas : refusées sur l'appareil aussi.
            if Self.haWriteOps.contains(op) { return fail("attestation_required") }
            return NokkerHome.run(op, args) { r in
                switch r {
                case .success(let v): ok(v)
                case .failure(let f): fail(f.code)
                }
            }
        }
        switch op {
        case "zone.state":
            guard let z = args["zone_id"] as? String else { return fail("bad_args") }
            guard NokkerZonesPlugin.readZones().contains(where: { $0.id == z }) else { return fail("unknown_zone") }
            let st = NokkerZonesPlugin.readStates()[z]
            ok(["inside": st?.inside ?? false, "since": st.map { $0.since as Any } ?? NSNull()])
        case "calendar.list":
            guard NokkerPimPlugin.eventStatus(.event) == "granted", let pim else { return fail("denied") }
            let iso = ISO8601DateFormatter()
            let from = (args["from"] as? String).flatMap(iso.date(from:)) ?? Date()
            let to = (args["to"] as? String).flatMap(iso.date(from:)) ?? from.addingTimeInterval(7 * 86_400)
            let items = pim.readCalendar(from: from, to: to, q: args["q"] as? String).map { e -> [String: Any] in
                var o = e
                for f in ["title", "location", "notes"] { if let v = o[f] as? String { o[f] = masked(v) ?? "" } }
                return o
            }
            ok(["items": items])
        case "fetch.get":
            NokkerEgress.fetch(args, path: pathMonitor.currentPath) { r in
                DispatchQueue.main.async {
                    switch r {
                    case .success(let p):
                        ok(["status": p.status, "final_url": p.finalURL.absoluteString, "content_type": p.contentType, "charset": p.charset.map { $0 as Any } ?? NSNull(),
                            "text": p.text, "bytes": p.bytes, "truncated": p.truncated, "hops": p.hops])
                    case .failure(let f):
                        failWhy(f.code, f.reason)
                    }
                }
            }
        case "ocr.image", "stt.audio":
            let isImg = op == "ocr.image"
            guard let u = args[isImg ? "image_url" : "audio_url"] as? String, let url = URL(string: u), let baseS = Self.kcGet("base").flatMap({ String(data: $0, encoding: .utf8) }),
                  let base = URL(string: baseS), url.host == base.host, url.port == base.port else { return fail("bad_args") }
            // Le blob est signé, à usage unique et lié à CE nœud : on le lit avec la même preuve que le reste.
            send("GET", url.path + (url.query.map { "?\($0)" } ?? ""), nil, timeout: 30) { st, data in
                guard st == 200, !data.isEmpty else { return fail(st == 403 ? "forbidden" : st == 410 ? "gone" : "fetch_failed") }
                if isImg {
                    guard let cg = UIImage(data: data)?.cgImage else { return fail("bad_image") }
                    NokkerTextPlugin.recognize(cg) { text in
                        guard let m = masked(text) else { return fail("redact_rules_unavailable") }
                        ok(["text": m])
                    }
                } else {
                    NokkerTextPlugin.transcribe(data, ext: url.pathExtension.lowercased(), lang: args["lang"] as? String) { text, extra in
                        guard let text else { return fail(extra as? String ?? "transcription_failed") }
                        guard let m = masked(text) else { return fail("redact_rules_unavailable") }
                        ok(["text": m, "duration_s": extra])
                    }
                }
            }
        default:
            fail("unknown_op")
        }
    }

    // MARK: - Autotest du CI (debug seulement)

    #if DEBUG
    /// Clé logicielle jetable (jamais celle du trousseau) : preuve signée puis vérifiée par CryptoKit sur la clé publique
    /// relue depuis son SPKI DER, et contre-épreuve sur une chaîne modifiée (autre hôte).
    static func selfTest() {
        let k = P256.Signing.PrivateKey()
        let nk = NodeKey.software(k)
        do {
            let url = URL(string: "https://node.example.test/v1/gateway/phone/tasks?wait=25")!
            let header = try proofHeader(nk, method: "GET", url: url, body: Data())
            let parts = Dictionary(uniqueKeysWithValues: header.dropFirst(3).split(separator: ";").compactMap { p -> (String, String)? in
                let kv = p.split(separator: "=", maxSplits: 1)
                return kv.count == 2 ? (String(kv[0]), String(kv[1])) : nil
            })
            guard let ts = parts["ts"].flatMap(Int.init), let nonce = parts["nonce"], let sigS = parts["sig"],
                  let sigD = Data(base64Encoded: sigS.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/").padding(toLength: ((sigS.count + 3) / 4) * 4, withPad: "=", startingAt: 0)) else {
                return NSLog("NokkerNode: self-test proof FAILED parse")
            }
            let pub = try P256.Signing.PublicKey(derRepresentation: k.publicKey.derRepresentation)
            let sig = try P256.Signing.ECDSASignature(rawRepresentation: sigD)
            let good = pub.isValidSignature(sig, for: Data(proofString(method: "GET", host: "node.example.test", pathQuery: "/v1/gateway/phone/tasks?wait=25", ts: ts, nonce: nonce, body: Data()).utf8))
            let other = pub.isValidSignature(sig, for: Data(proofString(method: "GET", host: "autre.example.test", pathQuery: "/v1/gateway/phone/tasks?wait=25", ts: ts, nonce: nonce, body: Data()).utf8))
            NSLog("NokkerNode: self-test proof \(good && !other ? "ok" : "FAILED") sig \(sigD.count) fp \(fingerprint(pub)) enclave \(SecureEnclave.isAvailable)")
            // Sceau : vecteur produit par `sealToken` du SDK (même code que le faux noyau) pour une clé d'accord JETABLE,
            // propre à cet autotest (elle ne protège rien). Le natif doit l'ouvrir, et refuser un autre approval_id.
            let vk = try P256.KeyAgreement.PrivateKey(rawRepresentation: fromB64u("7fR8uwa1ZR7A9cWazkeeb_FBTFJIterlFKVnnHz4-Xg") ?? Data())
            let opened = try openSealed(.software(vk), approvalId: "appr_selftest", x: "tJRww5LQFXuyTzuOYK3NMZWqwoMLdVLYNpfbsfsjN38", y: "J-beR71jlTmB0lGYYJCMN3c2jO2Rj5fVrLMJR9zWvu8", iv: "hrP67dWL59Ba5n2S", ct: "USYJCKhXVq4R-TyWdY6bsjN8U3l8F6yg-r8lsKlcmNzuPcaeGPHIjbopkKqo_-U4xlk")
            let wrong = (try? openSealed(.software(vk), approvalId: "appr_autre", x: "tJRww5LQFXuyTzuOYK3NMZWqwoMLdVLYNpfbsfsjN38", y: "J-beR71jlTmB0lGYYJCMN3c2jO2Rj5fVrLMJR9zWvu8", iv: "hrP67dWL59Ba5n2S", ct: "USYJCKhXVq4R-TyWdY6bsjN8U3l8F6yg-r8lsKlcmNzuPcaeGPHIjbopkKqo_-U4xlk")) != nil
            NSLog("NokkerNode: self-test seal \(opened == "mt_selftest_ok" && !wrong ? "ok" : "FAILED")")
        } catch {
            NSLog("NokkerNode: self-test proof FAILED \(error.localizedDescription)")
        }
    }
    #endif
}
