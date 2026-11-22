import Capacitor
import CryptoKit
import Foundation

/// Masquage sur l'appareil (LOKKAL-PHONE §4.3.2, lot P9b).
///
/// `NokkerRedact` : le même moteur que `packages/sdk/src/redact.ts`, sur les règles publiées par le noyau (dialecte commun :
/// le groupe capturé termine le motif, donc sa position se lit pareil en JS, Python et ICU). Un jeu de règles n'est
/// accepté que s'il passe ses propres vecteurs ici aussi.
///
/// `Capacitor.Plugins.NokkerVault` : le dictionnaire ⟦CODE-n⟧ → valeur, PAR FIL, de ce que CET appareil a émis. Un fichier
/// par fil sous Application Support/nokker-vault, protection `complete` (illisible appareil verrouillé), exclu de la
/// sauvegarde ; effacé à la réinstallation. Seuls ces marqueurs se démasquent : un ⟦IBAN-1⟧ écrit par un tiers reste tel quel.
enum NokkerRedact {
    struct Rule {
        let id: String
        let kind: String
        let re: NSRegularExpression
        let group: Int
        let validate: String
        let ctx: NSRegularExpression?
    }

    static let codes: [String: String] = ["phone": "PHONE", "email": "EMAIL", "iban": "IBAN", "avs": "AHV", "card": "CARD", "birthdate": "BIRTHDATE", "address": "ADDRESS", "secret": "SECRET"]
    static let marker = try! NSRegularExpression(pattern: "⟦([A-Z]{2,12})-([1-9][0-9]{0,3})⟧")
    static let maxMarkers = 200

    static func compile(_ json: [String: Any]) -> (version: String, rules: [Rule], vectors: [[String: Any]])? {
        guard let version = json["version"] as? String, let raw = json["rules"] as? [[String: Any]] else { return nil }
        var rules: [Rule] = []
        for r in raw {
            guard let id = r["id"] as? String, let kind = r["kind"] as? String, codes[kind] != nil, let p = r["pattern"] as? String,
                  let re = try? NSRegularExpression(pattern: p, options: (r["flags"] as? String) == "i" ? [.caseInsensitive] : []) else { continue }
            let ctx = (r["context"] as? String).flatMap { try? NSRegularExpression(pattern: "(?:\($0))[^0-9\\n]{0,12}$", options: [.caseInsensitive]) }
            rules.append(Rule(id: id, kind: kind, re: re, group: r["group"] as? Int ?? 0, validate: r["validate"] as? String ?? "none", ctx: ctx))
        }
        return (version, rules, json["vectors"] as? [[String: Any]] ?? [])
    }

    // MARK: validateurs (mêmes que le SDK)

    static func ibanValid(_ raw: String) -> Bool {
        let s = raw.uppercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }
        guard s.count >= 15, s.count <= 34, s.prefix(2).allSatisfy({ $0.isASCII && $0.isLetter }), s.dropFirst(2).prefix(2).allSatisfy(\.isNumber) else { return false }
        var rem = 0
        for ch in s.dropFirst(4) + s.prefix(4) {
            let v = ch.isLetter ? String(Int(ch.asciiValue! - 55)) : String(ch)
            for d in v { rem = (rem * 10 + Int(String(d))!) % 97 }
        }
        return rem == 1
    }

    static func luhnValid(_ raw: String) -> Bool {
        let d = raw.compactMap { $0.wholeNumberValue }
        guard d.count >= 13, d.count <= 19, Set(d).count > 1 else { return false }
        var sum = 0
        for (i, x) in d.reversed().enumerated() { sum += i % 2 == 1 ? (x * 2 > 9 ? x * 2 - 9 : x * 2) : x }
        return sum % 10 == 0
    }

    static func avsValid(_ raw: String) -> Bool {
        let d = raw.compactMap { $0.wholeNumberValue }
        guard d.count == 13, d[0] == 7, d[1] == 5, d[2] == 6 else { return false }
        var sum = 0
        for i in 0..<12 { sum += d[i] * (i % 2 == 0 ? 1 : 3) }
        return (10 - sum % 10) % 10 == d[12]
    }

    static func valid(_ v: String, _ how: String) -> Bool {
        switch how {
        case "iban_mod97": return ibanValid(v)
        case "luhn": return luhnValid(v)
        case "avs_ean13": return avsValid(v)
        default: return true
        }
    }

    struct Span { let range: NSRange; let kind: String; let value: String }

    static func find(_ text: String, _ rules: [Rule], kinds: Set<String>? = nil) -> [Span] {
        let ns = text as NSString
        var taken = marker.matches(in: text, range: NSRange(location: 0, length: ns.length)).map(\.range)
        var out: [Span] = []
        for r in rules where kinds?.contains(r.kind) ?? true {
            for m in r.re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
                let g = m.range(at: r.group)
                guard g.location != NSNotFound, g.length > 0 else { continue }
                if taken.contains(where: { NSIntersectionRange($0, g).length > 0 }) { continue }
                let value = ns.substring(with: g)
                guard valid(value, r.validate) else { continue }
                if let ctx = r.ctx {
                    let from = max(0, g.location - 40)
                    let before = ns.substring(with: NSRange(location: from, length: g.location - from))
                    if ctx.firstMatch(in: before, range: NSRange(location: 0, length: (before as NSString).length)) == nil { continue }
                }
                taken.append(g)
                out.append(Span(range: g, kind: r.kind, value: value))
            }
        }
        return out.sorted { $0.range.location < $1.range.location }
    }

    /// Rejoue les vecteurs : nombre d'écarts (0 = jeu accepté).
    static func failures(_ rules: [Rule], _ vectors: [[String: Any]]) -> Int {
        vectors.filter { v in
            let text = v["text"] as? String ?? ""
            let want = (v["expect"] as? [[String: String]] ?? []).map { "\($0["kind"] ?? ""):\($0["value"] ?? "")" }
            return find(text, rules).map { "\($0.kind):\($0.value)" } != want
        }.count
    }

    static func norm(_ kind: String, _ v: String) -> String {
        switch kind {
        case "email": return v.lowercased()
        case "phone", "iban", "card", "avs": return v.uppercased().filter { $0.isLetter || $0.isNumber || $0 == "+" }
        default: return v
        }
    }

    /// Masque `text` avec le dictionnaire du fil ; rend le texte, les nouvelles paires et les compteurs par code.
    static func mask(_ text: String, _ rules: [Rule], dict: [String: String]) -> (text: String, added: [String: String], counts: [String: Int]) {
        var work = dict
        var added: [String: String] = [:]
        var counts: [String: Int] = [:]
        let spans = Array(find(text, rules).prefix(maxMarkers))
        var marks: [(NSRange, String)] = []
        for s in spans {
            let code = codes[s.kind]!
            let key = norm(s.kind, s.value)
            var mk: String? = nil
            var top = 0
            for (k, v) in work {
                guard let m = marker.firstMatch(in: k, range: NSRange(location: 0, length: (k as NSString).length)), (k as NSString).substring(with: m.range(at: 1)) == code else { continue }
                if norm(s.kind, v) == key { mk = k; break }
                top = max(top, Int((k as NSString).substring(with: m.range(at: 2))) ?? 0)
            }
            let use = mk ?? "⟦\(code)-\(top + 1)⟧"
            if mk == nil { work[use] = s.value; added[use] = s.value }
            counts[code, default: 0] += 1
            marks.append((s.range, use))
        }
        let out = NSMutableString(string: text)
        for (r, mk) in marks.reversed() { out.replaceCharacters(in: r, with: mk) }
        return (out as String, added, counts)
    }
}

@objc(NokkerVaultPlugin)
public class NokkerVaultPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NokkerVaultPlugin"
    public let jsName = "NokkerVault"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRules", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkRules", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "put", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forget", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forgetAll", returnType: CAPPluginReturnPromise)
    ]

    // MARK: - Stockage (partagé avec le nœud, qui masque ses résultats)

    private static let q = DispatchQueue(label: "nokker.vault")
    static var dir: URL {
        var d = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("nokker-vault", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        var rv = URLResourceValues()
        rv.isExcludedFromBackup = true
        try? d.setResourceValues(rv)
        return d
    }
    private static func file(_ thread: String) -> URL {
        dir.appendingPathComponent(SHA256.hash(data: Data(thread.utf8)).map { String(format: "%02x", $0) }.joined() + ".json")
    }
    private static func write(_ obj: Any, to url: URL) {
        guard let d = try? JSONSerialization.data(withJSONObject: obj) else { return }
        try? d.write(to: url, options: [.atomic, .completeFileProtection])
    }

    static func pairs(_ thread: String) -> [String: String] {
        q.sync { (try? Data(contentsOf: file(thread))).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] } ?? [:] }
    }
    static func add(_ thread: String, _ new: [String: String]) -> Int {
        q.sync {
            var cur = (try? Data(contentsOf: file(thread))).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] } ?? [:]
            // On n'écrase jamais une paire déjà émise : un marqueur garde sa valeur pour tout le fil.
            for (k, v) in new where cur[k] == nil && NokkerRedact.marker.firstMatch(in: k, range: NSRange(location: 0, length: (k as NSString).length))?.range.length == (k as NSString).length {
                cur[k] = v
            }
            write(cur, to: file(thread))
            return cur.count
        }
    }

    /// Règles acceptées (elles ont passé leurs vecteurs ici) : relues par le nœud. Sans règles, le nœud refuse les
    /// opérations qui doivent être masquées plutôt que d'envoyer en clair.
    static var rules: (version: String, rules: [NokkerRedact.Rule])? {
        guard let d = try? Data(contentsOf: dir.appendingPathComponent("rules.json")), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let c = NokkerRedact.compile(j) else { return nil }
        return (c.version, c.rules)
    }

    /// Masque un texte produit par le nœud pour le fil donné ; nil si aucune règle n'a encore été acceptée.
    static func maskForNode(_ text: String, thread: String) -> String? {
        guard let r = rules else { return nil }
        let m = NokkerRedact.mask(text, r.rules, dict: pairs(thread))
        if !m.added.isEmpty { _ = add(thread, m.added) }
        return m.text
    }

    private static let installedKey = "nokker.vault.installed"

    override public func load() {
        if !UserDefaults.standard.bool(forKey: Self.installedKey) {
            try? FileManager.default.removeItem(at: Self.dir)
            UserDefaults.standard.set(true, forKey: Self.installedKey)
        }
        NSLog("NokkerVault: loaded, rules \(Self.rules?.version ?? "none")")
        #if DEBUG
        let flag = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("nokker-ci-vault")
        if FileManager.default.fileExists(atPath: flag.path) {
            try? FileManager.default.removeItem(at: flag)
            Self.selfTest()
        }
        #endif
    }

    // MARK: - Interface

    @objc func status(_ call: CAPPluginCall) {
        call.resolve(["available": true, "rules_version": Self.rules?.version ?? NSNull()])
    }

    /// Règles du noyau (déjà vérifiées en JS) : revérifiées ici sur leurs vecteurs avant d'être gardées.
    @objc func setRules(_ call: CAPPluginCall) {
        // Aller-retour JSON : des types Foundation, comme le fichier relu plus tard par le nœud.
        guard let o = call.getObject("rules"), let d = try? JSONSerialization.data(withJSONObject: o), let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              let c = NokkerRedact.compile(j) else { return call.reject("bad_rules") }
        let bad = NokkerRedact.failures(c.rules, c.vectors)
        guard bad == 0, !c.vectors.isEmpty else { return call.reject("vectors_failed") }
        Self.q.sync { Self.write(j, to: Self.dir.appendingPathComponent("rules.json")) }
        call.resolve(["version": c.version])
    }

    /// Rejoue un jeu de règles (la copie embarquée, envoyée par l'interface au lancement) sous NSRegularExpression, SANS le
    /// garder : toutes les règles doivent compiler et tous les vecteurs passer. Seule preuve CI que les motifs du noyau
    /// tournent à l'identique en Swift. Journalise des compteurs, jamais une valeur.
    @objc func checkRules(_ call: CAPPluginCall) {
        guard let o = call.getObject("rules"), let d = try? JSONSerialization.data(withJSONObject: o), let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              let c = NokkerRedact.compile(j) else {
            NSLog("NokkerVault: self-test rules FAILED (unreadable)")
            return call.reject("bad_rules")
        }
        let given = (j["rules"] as? [Any])?.count ?? 0
        let bad = NokkerRedact.failures(c.rules, c.vectors)
        let ok = bad == 0 && c.rules.count == given && !c.vectors.isEmpty
        NSLog("NokkerVault: self-test rules \(ok ? "ok" : "FAILED") (version \(c.version), \(c.rules.count) rules, \(c.vectors.count) vectors, bad \(bad))\(c.rules.count == given ? "" : " — \(given - c.rules.count) rule(s) did not compile")")
        call.resolve(["ok": ok, "version": c.version, "rules": c.rules.count, "vectors": c.vectors.count, "bad": bad])
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let t = call.getString("thread"), !t.isEmpty else { return call.reject("bad_thread") }
        call.resolve(["pairs": Self.pairs(t)])
    }

    @objc func put(_ call: CAPPluginCall) {
        guard let t = call.getString("thread"), !t.isEmpty, let p = call.getObject("pairs") as? [String: String] else { return call.reject("bad_pairs") }
        call.resolve(["count": Self.add(t, p)])
    }

    @objc func forget(_ call: CAPPluginCall) {
        guard let t = call.getString("thread") else { return call.reject("bad_thread") }
        Self.q.sync { try? FileManager.default.removeItem(at: Self.file(t)) }
        call.resolve()
    }

    @objc func forgetAll(_ call: CAPPluginCall) {
        Self.q.sync {
            for f in (try? FileManager.default.contentsOfDirectory(at: Self.dir, includingPropertiesForKeys: nil)) ?? [] where f.lastPathComponent != "rules.json" {
                try? FileManager.default.removeItem(at: f)
            }
        }
        call.resolve()
    }

    #if DEBUG
    /// Jeu de règles minimal au format du noyau (motifs du SDK) : vecteurs, masquage, même valeur = même marqueur,
    /// protection du fichier. Le CI exige « self-test redact ok ».
    static func selfTest() {
        let j: [String: Any] = [
            "version": "selftest",
            "rules": [
                ["id": "iban", "kind": "iban", "pattern": "(?:^|[^0-9A-Za-z])([A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?)(?![A-Za-z0-9])", "group": 1, "validate": "iban_mod97"],
                ["id": "phone-ch", "kind": "phone", "pattern": "(?:^|[^0-9A-Za-z+])((?:[+]41|0041)[ .-]?[(]?0?[)]?[ .-]?[1-9](?:[ .-]?[0-9]){8}|0[1-9](?:[ .-]?[0-9]){8})(?![0-9])", "group": 1, "validate": "none"],
                ["id": "birthdate", "kind": "birthdate", "pattern": "(?:^|[^0-9])([0-3]?[0-9][./-][01]?[0-9][./-](?:19|20)?[0-9]{2})(?![0-9])", "context": "(né|née|date de naissance|naissance|geb[.]|dob)", "group": 1, "validate": "none"]
            ],
            "vectors": [
                ["text": "IBAN : CH93 0076 2011 6238 5295 7 pour le loyer", "expect": [["kind": "iban", "value": "CH93 0076 2011 6238 5295 7"]]],
                ["text": "IBAN faux : CH93 0076 2011 6238 5295 8", "expect": []],
                ["text": "Date de naissance : 14.03.1987 ; rendez-vous le 14.03.2027", "expect": [["kind": "birthdate", "value": "14.03.1987"]]]
            ]
        ]
        guard let c = NokkerRedact.compile(j) else { return NSLog("NokkerVault: self-test redact FAILED compile") }
        let bad = NokkerRedact.failures(c.rules, c.vectors)
        let a = NokkerRedact.mask("Appelle le 079 123 45 67", c.rules, dict: [:])
        let b = NokkerRedact.mask("Rappelle le 0791234567 et le 022 345 67 89", c.rules, dict: a.added)
        let t = "selftest-\(UUID().uuidString)"
        _ = add(t, a.added)
        let back = pairs(t)
        let prot = (try? FileManager.default.attributesOfItem(atPath: file(t).path)[.protectionKey] as? FileProtectionType) ?? nil
        Self.q.sync { try? FileManager.default.removeItem(at: file(t)) }
        // Data Protection : le simulateur ne l'applique pas (attribut absent) ; sur un appareil, le fichier DOIT être en
        // `complete`, sinon l'autotest échoue.
        #if targetEnvironment(simulator)
        let protOK = true
        let protLabel = "n/a (simulator)"
        #else
        let protOK = prot == .complete
        let protLabel = prot?.rawValue ?? "none"
        #endif
        let ok = bad == 0 && protOK && a.text == "Appelle le ⟦PHONE-1⟧" && b.text == "Rappelle le ⟦PHONE-1⟧ et le ⟦PHONE-2⟧" && back["⟦PHONE-1⟧"] == "079 123 45 67"
        NSLog("NokkerVault: self-test redact \(ok ? "ok" : "FAILED") (vectors bad \(bad), protection \(protLabel))")
    }
    #endif
}
