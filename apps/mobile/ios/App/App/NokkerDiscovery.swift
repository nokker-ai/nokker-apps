import CryptoKit
import Foundation
import Network

/// Découverte du réseau local par le nœud maison (LOKKAL-PHONE §4.4, lot P10d ; contrat validé par dev le 06.11).
/// Référence TypeScript : packages/sdk/src/discovery.ts (`filterDiscovered`).
///
/// - Le nœud n'ANNONCE rien (aucun NWListener Bonjour) ; il PARCOURT une liste fermée de types (écrans, enceintes,
///   Home Assistant), jamais téléphones ni ordinateurs personnels.
/// - Sur l'appareil, avec le TXT (qui ne sort jamais) : instance écartée si `model`/`am` commence par Mac, iPhone, iPad
///   ou iPod ; préfixe matériel `XXXXXXXXXXXX@` des noms RAOP retiré ; dédoublonnage par nom (une entrée, ses types).
/// - Sortie : `{id, type, types, name}` seulement — ni IP, ni port, ni TXT. `id` = sha256(sel du nœud ‖ type ‖ nom)
///   tronqué : stable pour CE nœud ; le sel vit au trousseau et part avec le nœud.
/// - Home Assistant : `haCandidates` lit l'URL interne annoncée par HA (TXT `internal_url`/`base_url`) SUR l'appareil,
///   pour préremplir le champ ; elle repasse par `NokkerHome.normalizeBase` puis par l'épinglage (rien n'est contourné).
enum NokkerDiscovery {
    struct Fail: Error { let code: String }

    static let types = ["_googlecast._tcp", "_airplay._tcp", "_raop._tcp", "_home-assistant._tcp", "_spotify-connect._tcp", "_sonos._tcp"]
    static let maxServices = 50
    static let saltAccount = "lan-salt"

    struct Raw {
        let type: String
        let name: String
        let txt: [String: String]
    }

    private static func salt() -> Data {
        if let s = NokkerNodePlugin.kcGet(saltAccount), s.count == 32 { return s }
        var b = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, b.count, &b)
        let d = Data(b)
        _ = NokkerNodePlugin.kcSet(saltAccount, d)
        return d
    }

    static func forget() { NokkerNodePlugin.kcDelete(saltAccount) }

    static func id(type: String, name: String) -> String {
        SHA256.hash(data: salt() + Data("\(type)\n\(name)".utf8)).map { String(format: "%02x", $0) }.joined().prefix(16).description
    }

    /// Règles de l'appareil (mêmes que `filterDiscovered` du SDK).
    static func filter(_ raw: [Raw]) -> [[String: Any]] {
        var out: [(id: String, type: String, types: [String], name: String)] = []
        for r in raw where types.contains(r.type) {
            let model = r.txt["model"] ?? r.txt["am"] ?? ""
            if model.range(of: "^(mac|iphone|ipad|ipod)", options: [.regularExpression, .caseInsensitive]) != nil { continue }
            var name = r.type == "_raop._tcp" ? r.name.replacingOccurrences(of: "^[0-9A-Fa-f]{12}@", with: "", options: .regularExpression) : r.name
            name = String(name.prefix(63))
            if name.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            if let i = out.firstIndex(where: { $0.name == name }) {
                if !out[i].types.contains(r.type) { out[i].types.append(r.type) }
                continue
            }
            if out.count >= maxServices { break }
            out.append((id(type: r.type, name: name), r.type, [r.type], name))
        }
        return out.map { ["id": $0.id, "type": $0.type, "types": $0.types, "name": $0.name] }
    }

    /// Parcourt les types demandés pendant `timeout` secondes ; rappel sur le fil principal.
    static func browse(_ wanted: [String], timeout: Double, _ done: @escaping (Result<[Raw], Fail>) -> Void) {
        let q = DispatchQueue(label: "nokker.discovery")
        var found: [String: Raw] = [:]
        var denied = false
        var browsers: [NWBrowser] = []
        for t in wanted where types.contains(t) {
            let params = NWParameters()
            params.includePeerToPeer = false
            let b = NWBrowser(for: .bonjourWithTXTRecord(type: t, domain: "local."), using: params)
            b.stateUpdateHandler = { st in
                if case .failed(let e) = st, case .dns(let code) = e, code == -65570 { denied = true } // kDNSServiceErr_PolicyDenied
                if case .waiting(let e) = st, case .dns(let code) = e, code == -65570 { denied = true }
            }
            b.browseResultsChangedHandler = { results, _ in
                for r in results {
                    guard case .service(let name, let type, _, _) = r.endpoint else { continue }
                    var txt: [String: String] = [:]
                    if case .bonjour(let rec) = r.metadata {
                        for (k, v) in rec.dictionary { txt[k.lowercased()] = v }
                    }
                    found["\(type)|\(name)"] = Raw(type: type.hasSuffix(".") ? String(type.dropLast()) : type, name: name, txt: txt)
                }
            }
            b.start(queue: q)
            browsers.append(b)
        }
        q.asyncAfter(deadline: .now() + max(0.5, min(5, timeout))) {
            for b in browsers { b.cancel() }
            let list = Array(found.values).sorted { ($0.type, $0.name) < ($1.type, $1.name) }
            DispatchQueue.main.async { done(denied && list.isEmpty ? .failure(Fail(code: "local_network_denied")) : .success(list)) }
        }
    }

    /// `lan.discover {types?, timeout_s}` → `{services, at}` (Wi-Fi maison exigé, comme `lan_home`).
    static func discover(_ p: [String: Any], _ done: @escaping (Result<[String: Any], Fail>) -> Void) {
        let wanted = (p["types"] as? [String]) ?? types
        guard wanted.allSatisfy({ types.contains($0) }), !wanted.isEmpty else { return done(.failure(Fail(code: "bad_args"))) }
        let timeout = (p["timeout_s"] as? Double) ?? Double(p["timeout_s"] as? Int ?? 3)
        NokkerHome.refreshWifi { home in
            guard home else { return done(.failure(Fail(code: "not_home_wifi"))) }
            browse(wanted, timeout: timeout) { r in
                switch r {
                case .success(let raw): done(.success(["services": filter(raw), "at": ISO8601DateFormatter().string(from: Date())]))
                case .failure(let f): done(.failure(f))
                }
            }
        }
    }

    /// Candidats Home Assistant, sur l'appareil : URL interne annoncée par HA, seulement si `normalizeBase` l'accepte.
    static func haCandidates(_ done: @escaping ([[String: String]]) -> Void) {
        browse(["_home-assistant._tcp"], timeout: 3) { r in
            guard case .success(let raw) = r else { return done([]) }
            var out: [[String: String]] = []
            for s in raw {
                for k in ["internal_url", "base_url"] {
                    if let u = s.txt[k], let base = NokkerHome.normalizeBase(u), !out.contains(where: { $0["url"] == base }) {
                        out.append(["name": String(s.name.prefix(63)), "url": base])
                        break
                    }
                }
            }
            done(out)
        }
    }

    // MARK: - Autotest du CI (debug seulement)

    #if DEBUG
    /// Services annoncés par smoke.sh sur le runner (dns-sd) : « Nokker CI TV » (_googlecast et _raop avec préfixe
    /// matériel) doit sortir UNE fois, sans préfixe ; « Nokker CI Mac » (_airplay, model=MacBookPro…) doit être écarté ;
    /// l'id est stable entre deux parcours ; rien qui ressemble à une adresse ou un port dans le résultat.
    static func selfTest() {
        browse(["_googlecast._tcp", "_airplay._tcp", "_raop._tcp"], timeout: 4) { r1 in
            browse(["_googlecast._tcp", "_airplay._tcp", "_raop._tcp"], timeout: 4) { r2 in
                guard case .success(let a) = r1, case .success(let b) = r2 else { return NSLog("NokkerDiscovery: self-test FAILED browse") }
                let s1 = filter(a), s2 = filter(b)
                let tv = s1.filter { ($0["name"] as? String) == "Nokker CI TV" }
                let types = (tv.first?["types"] as? [String]) ?? []
                let mac = s1.contains { ($0["name"] as? String)?.contains("Nokker CI Mac") == true }
                let json = (try? JSONSerialization.data(withJSONObject: s1)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
                let clean = json.range(of: "[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}|A1B2C3D4E5F6|8009", options: .regularExpression) == nil
                let stable = tv.first?["id"] as? String == s2.first(where: { ($0["name"] as? String) == "Nokker CI TV" })?["id"] as? String
                let ok = tv.count == 1 && types.contains("_googlecast._tcp") && types.contains("_raop._tcp") && !mac && clean && stable
                NSLog("NokkerDiscovery: self-test \(ok ? "ok" : "FAILED") (tv \(tv.count), types \(types.count), mac filtered \(!mac), clean \(clean), stable \(stable))")
            }
        }
    }
    #endif
}
