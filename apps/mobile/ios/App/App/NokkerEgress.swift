import Foundation
import Network
import Security
import UIKit

/// `fetch.get` du nœud téléphone (LOKKAL-PHONE §4.5, lot P11) : une page ouverte par la connexion du téléphone, avec la
/// garde SSRF SUR L'APPAREIL (le téléphone est sur le réseau de la maison : c'est l'invariant le plus important).
///
/// À CHAQUE saut (5 redirections au plus) :
///  1. https, port 443, ni identifiants ni IP littérale ; refus des noms à une étiquette et des suffixes locaux ;
///  2. résolution complète (getaddrinfo) : si UNE adresse n'est pas publique, refus (pas de tri) ; les IPv4
///     encapsulées (::ffff:/96, NAT64 64:ff9b::/96, 6to4 2002::/16) sont revérifiées ;
///  3. `NWConnection` vers CETTE IP:443 — pas de seconde résolution, donc pas de fenêtre de rebinding —, TLS 1.2+ avec
///     le SNI de l'hôte et une vérification SecTrust explicite pour l'hôte, sans proxy ;
///  4. HTTP/1.1 écrit à la main : GET, sans cookies, sans Referer, `Accept-Encoding: identity`, `Connection: close`.
/// Bornes : 3 Mo bruts, 8 s au total, types texte seulement, texte rendu ≤ 768 Kio.
/// Réseau : Wi-Fi, ou cellulaire sous un plafond mensuel (100 Mo par défaut) ; mode données réduites = refus.
enum NokkerEgress {
    static let maxBytes = 3 * 1024 * 1024
    static let maxText = 768 * 1024
    static let timeout: TimeInterval = 8
    static let maxHops = 5
    static let userAgent = "Nokker/\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0") (phone node)"

    // MARK: - Réglages de la personne

    private static let onKey = "nokker.egress.on"
    private static let capKey = "nokker.egress.cell_cap_mb"
    private static let cellKey = "nokker.egress.cellular"
    /// Les données mobiles sont COUPÉES par défaut (case « Aussi en données mobiles ») ; refus `cellular_off`.
    static var cellularAllowed: Bool {
        get { UserDefaults.standard.bool(forKey: cellKey) }
        set { UserDefaults.standard.set(newValue, forKey: cellKey) }
    }
    static var enabled: Bool {
        get { UserDefaults.standard.bool(forKey: onKey) }
        set { UserDefaults.standard.set(newValue, forKey: onKey) }
    }
    static var cellCapMB: Int {
        get { UserDefaults.standard.object(forKey: capKey) as? Int ?? 100 }
        set { UserDefaults.standard.set(max(0, min(10_000, newValue)), forKey: capKey) }
    }
    private static var monthKey: String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM"
        f.timeZone = TimeZone(identifier: "UTC")
        return "nokker.egress.cell." + f.string(from: Date())
    }
    static var cellUsedBytes: Int { UserDefaults.standard.integer(forKey: monthKey) }
    private static func countCell(_ n: Int) { UserDefaults.standard.set(cellUsedBytes + n, forKey: monthKey) }

    // MARK: - Hôtes et adresses

    private static let bannedSuffix = ["local", "lan", "home.arpa", "internal", "localhost", "intranet", "corp", "home"]

    /// Nom d'hôte acceptable (même règle que `normalizeEgressHost` du SDK, sans joker).
    static func hostOK(_ raw: String) -> Bool {
        let h = raw.lowercased()
        if h.isEmpty || h.count > 253 || h.contains(":") || h.contains("*") { return false }
        let labels = h.split(separator: ".", omittingEmptySubsequences: false)
        if labels.count < 2 { return false }
        if labels.allSatisfy({ $0.allSatisfy(\.isNumber) }) { return false } // IPv4 littérale
        for l in labels {
            guard !l.isEmpty, l.count <= 63, l.first != "-", l.last != "-", l.allSatisfy({ ($0.isASCII && ($0.isLetter || $0.isNumber)) || $0 == "-" }) else { return false }
        }
        return !bannedSuffix.contains { h == $0 || h.hasSuffix("." + $0) }
    }

    /// `*.exemple.ch` couvre ses sous-domaines (pas lui-même), `exemple.ch` lui seul.
    static func hostAllowed(_ host: String, _ rules: [String]) -> Bool {
        let h = host.lowercased()
        return rules.contains { r in r.hasPrefix("*.") ? (h.hasSuffix(String(r.dropFirst())) && h.count > r.count - 1) : h == r }
    }

    /// Raison du refus d'une IPv4, ou nil si elle est publique.
    static func blockedV4(_ b: [UInt8]) -> String? {
        guard b.count == 4 else { return "bad_address" }
        let a = b[0], c = b[1]
        if a == 0 { return "this_network" }
        if a == 10 || (a == 172 && (c & 0xF0) == 16) || (a == 192 && c == 168) { return "private" }
        if a == 100 && (c & 0xC0) == 64 { return "cgnat" }
        if a == 127 { return "loopback" }
        if a == 169 && c == 254 { return "link_local" }
        if a == 192 && c == 0 && (b[2] == 0 || b[2] == 2) { return "reserved" }
        if a == 198 && (c & 0xFE) == 18 { return "benchmark" }
        if (a == 198 && c == 51 && b[2] == 100) || (a == 203 && c == 0 && b[2] == 113) { return "documentation" }
        if a >= 224 { return "multicast_reserved" }
        return nil
    }

    /// Raison du refus d'une IPv6, ou nil si elle est publique. Les IPv4 encapsulées sont revérifiées, pas refusées en
    /// bloc (sinon le cellulaire IPv6 seul, qui passe par le NAT64 d'iOS, ne marcherait jamais).
    static func blockedV6(_ b: [UInt8]) -> String? {
        guard b.count == 16 else { return "bad_address" }
        let zero = { (r: Range<Int>) in b[r].allSatisfy { $0 == 0 } }
        if zero(0..<16) { return "unspecified" }
        if zero(0..<15) && b[15] == 1 { return "loopback" }
        if zero(0..<10) && b[10] == 0xFF && b[11] == 0xFF { return blockedV4(Array(b[12..<16])) } // ::ffff:a.b.c.d
        if zero(0..<12) { return "ipv4_compatible" }
        if b[0] == 0x00 && b[1] == 0x64 && b[2] == 0xFF && b[3] == 0x9B && zero(4..<12) { return blockedV4(Array(b[12..<16])) } // NAT64
        if b[0] == 0x20 && b[1] == 0x02 { return blockedV4(Array(b[2..<6])) } // 6to4
        if (b[0] & 0xFE) == 0xFC { return "unique_local" }
        if b[0] == 0xFE && (b[1] & 0xC0) == 0x80 { return "link_local" }
        if b[0] == 0xFF { return "multicast" }
        if b[0] == 0x20 && b[1] == 0x01 && b[2] == 0x0D && b[3] == 0xB8 { return "documentation" }
        if b[0] == 0x01 && zero(1..<8) { return "discard" }
        return nil
    }

    enum Addr { case v4([UInt8]), v6([UInt8]) }

    static func resolve(_ host: String) -> [Addr]? {
        var hints = addrinfo()
        hints.ai_family = AF_UNSPEC
        hints.ai_socktype = SOCK_STREAM
        hints.ai_protocol = IPPROTO_TCP
        var res: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, "443", &hints, &res) == 0, let first = res else { return nil }
        defer { freeaddrinfo(first) }
        var out: [Addr] = []
        var p: UnsafeMutablePointer<addrinfo>? = first
        while let ai = p {
            if ai.pointee.ai_family == AF_INET, let sa = ai.pointee.ai_addr {
                let a = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr }
                out.append(.v4(withUnsafeBytes(of: a) { Array($0) }))
            } else if ai.pointee.ai_family == AF_INET6, let sa = ai.pointee.ai_addr {
                let a = sa.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { $0.pointee.sin6_addr }
                out.append(.v6(withUnsafeBytes(of: a) { Array($0) }))
            }
            p = ai.pointee.ai_next
        }
        return out
    }

    // MARK: - Une page

    struct Fail: Error { let code: String; var reason: String? = nil }

    struct Page {
        var status: Int
        var finalURL: URL
        var contentType: String
        var charset: String?
        var text: String
        var bytes: Int
        var truncated: Bool
        var hops: Int
    }

    /// Batterie sous 20 % hors charge (lue sur le fil principal) : refus `low_battery`.
    static func batteryLow() -> Bool {
        let d = UIDevice.current
        d.isBatteryMonitoringEnabled = true
        let unplugged = d.batteryState == .unplugged
        return unplugged && d.batteryLevel >= 0 && d.batteryLevel < 0.2
    }

    /// `fetch.get {url, trigger, allow_hosts?}` → page ou refus. À appeler sur le fil principal (batterie) ; le réseau
    /// part ensuite hors du fil principal.
    static func fetch(_ args: [String: Any], path: NWPath?, _ done: @escaping (Result<Page, Fail>) -> Void) {
        guard enabled else { return done(.failure(Fail(code: "egress_off"))) }
        if let path {
            if path.status != .satisfied { return done(.failure(Fail(code: "no_network"))) }
            // Mode économie de l'OS (données réduites) : `constrained` ; données mobiles non cochées dans l'app : `cellular_off`.
            if path.isConstrained { return done(.failure(Fail(code: "constrained"))) }
            let cellularOnly = path.isExpensive && !path.usesInterfaceType(.wifi)
            if cellularOnly && !cellularAllowed { return done(.failure(Fail(code: "cellular_off"))) }
            if cellularOnly && cellUsedBytes >= cellCapMB * 1024 * 1024 { return done(.failure(Fail(code: "metered_cap"))) }
        }
        if batteryLow() { return done(.failure(Fail(code: "low_battery"))) }
        guard let s = args["url"] as? String, let url = URL(string: s) else { return done(.failure(Fail(code: "scheme_not_allowed"))) }
        let allow = (args["trigger"] as? String) == "allowlist" ? (args["allow_hosts"] as? [String] ?? []) : nil
        let deadline = Date().addingTimeInterval(timeout)
        DispatchQueue.global(qos: .userInitiated).async {
            hop(url, hops: 0, allow: allow, deadline: deadline, cellular: path.map { $0.isExpensive && !$0.usesInterfaceType(.wifi) } ?? false, done)
        }
    }

    private static func hop(_ url: URL, hops: Int, allow: [String]?, deadline: Date, cellular: Bool, _ done: @escaping (Result<Page, Fail>) -> Void) {
        guard url.scheme?.lowercased() == "https" else { return done(.failure(Fail(code: "scheme_not_allowed"))) }
        if let p = url.port, p != 443 { return done(.failure(Fail(code: "port_not_allowed"))) }
        guard url.user == nil, url.password == nil, let host = url.host?.lowercased(), hostOK(host) else { return done(.failure(Fail(code: "host_not_allowed"))) }
        if let allow, !hostAllowed(host, allow) { return done(.failure(Fail(code: hops == 0 ? "host_not_allowed" : "redirect_not_allowed", reason: host))) }
        guard let addrs = resolve(host), !addrs.isEmpty else { return done(.failure(Fail(code: "dns_failed"))) }
        for a in addrs {
            let why: String?
            switch a {
            case .v4(let b): why = blockedV4(b)
            case .v6(let b): why = blockedV6(b)
            }
            if let why { return done(.failure(Fail(code: "blocked_address", reason: why))) }
        }
        // IPv4 d'abord s'il y en a (moins de surprises que le NAT64), sinon la première IPv6.
        let pick = addrs.first { if case .v4 = $0 { return true } else { return false } } ?? addrs[0]
        let ep: NWEndpoint.Host
        switch pick {
        case .v4(let b): guard let ip = IPv4Address(Data(b)) else { return done(.failure(Fail(code: "dns_failed"))) }; ep = .ipv4(ip)
        case .v6(let b): guard let ip = IPv6Address(Data(b)) else { return done(.failure(Fail(code: "dns_failed"))) }; ep = .ipv6(ip)
        }
        let left = deadline.timeIntervalSinceNow
        guard left > 0 else { return done(.failure(Fail(code: "timeout"))) }
        get(ep, host: host, url: url, timeout: left) { r in
            switch r {
            case .failure(let f): done(.failure(f))
            case .success(let raw):
                if cellular { countCell(raw.count) }
                guard let resp = parse(raw) else { return done(.failure(Fail(code: "bad_response"))) }
                if [301, 302, 303, 307, 308].contains(resp.status), let loc = resp.headers["location"] {
                    guard hops < maxHops else { return done(.failure(Fail(code: "too_many_redirects"))) }
                    guard let next = URL(string: loc, relativeTo: url)?.absoluteURL else { return done(.failure(Fail(code: "redirect_not_allowed"))) }
                    return hop(next, hops: hops + 1, allow: allow, deadline: deadline, cellular: cellular, done)
                }
                let ct = resp.headers["content-type"] ?? ""
                let mime = ct.split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
                guard mime.hasPrefix("text/") || ["application/json", "application/xml", "application/xhtml+xml"].contains(mime) || mime.hasSuffix("+json") || mime.hasSuffix("+xml") else {
                    return done(.failure(Fail(code: "unsupported_type", reason: mime)))
                }
                let charset = ct.range(of: "charset=", options: .caseInsensitive).map { String(ct[$0.upperBound...]).split(separator: ";").first.map { $0.trimmingCharacters(in: CharacterSet(charactersIn: " \"'")) } ?? "" }
                var text = decode(resp.body, charset: charset)
                var truncated = false
                if text.utf8.count > maxText {
                    text = String(decoding: Array(text.utf8.prefix(maxText)), as: UTF8.self)
                    truncated = true
                }
                done(.success(Page(status: resp.status, finalURL: url, contentType: mime, charset: charset, text: text, bytes: resp.body.count, truncated: truncated, hops: hops)))
            }
        }
    }

    /// GET sur une connexion ÉPINGLÉE à l'IP vérifiée, TLS au nom de l'hôte. Rend les octets bruts de la réponse.
    private static func get(_ ip: NWEndpoint.Host, host: String, url: URL, timeout: TimeInterval, _ done: @escaping (Result<Data, Fail>) -> Void) {
        let tls = NWProtocolTLS.Options()
        let sec = tls.securityProtocolOptions
        sec_protocol_options_set_min_tls_protocol_version(sec, .TLSv12)
        sec_protocol_options_set_tls_server_name(sec, host)
        // Vérification explicite pour l'HÔTE (pas pour l'IP) : chaîne système, nom = l'hôte demandé.
        sec_protocol_options_set_verify_block(sec, { _, trustRef, complete in
            let trust = sec_trust_copy_ref(trustRef).takeRetainedValue()
            SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString))
            complete(SecTrustEvaluateWithError(trust, nil))
        }, DispatchQueue.global(qos: .userInitiated))
        let params = NWParameters(tls: tls)
        params.preferNoProxies = true
        params.prohibitedInterfaceTypes = [.loopback]
        let conn = NWConnection(host: ip, port: 443, using: params)
        let q = DispatchQueue(label: "nokker.egress")
        var finished = false
        var buf = Data()
        let finish: (Result<Data, Fail>) -> Void = { r in
            q.async {
                guard !finished else { return }
                finished = true
                conn.cancel()
                done(r)
            }
        }
        q.asyncAfter(deadline: .now() + timeout) { finish(.failure(Fail(code: "timeout"))) }
        func receive() {
            conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, isComplete, error in
                if let data { buf.append(data) }
                if buf.count > maxBytes + 64 * 1024 { return finish(.failure(Fail(code: "too_large"))) }
                if isComplete || error != nil { return finish(buf.isEmpty ? .failure(Fail(code: "tls_failed")) : .success(buf)) }
                receive()
            }
        }
        conn.stateUpdateHandler = { st in
            switch st {
            case .ready:
                var pq = url.path.isEmpty ? "/" : url.path
                if let qy = url.query { pq += "?" + qy }
                let req = "GET \(pq) HTTP/1.1\r\nHost: \(host)\r\nUser-Agent: \(userAgent)\r\nAccept: text/html, text/plain, application/json, application/xml;q=0.9\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n"
                conn.send(content: Data(req.utf8), completion: .contentProcessed { e in if e != nil { finish(.failure(Fail(code: "tls_failed"))) } })
                receive()
            case .failed, .waiting:
                finish(.failure(Fail(code: "tls_failed")))
            default:
                break
            }
        }
        conn.start(queue: q)
    }

    struct Resp { var status: Int; var headers: [String: String]; var body: Data }

    /// Réponse HTTP/1.1 brute → statut, en-têtes (clés en minuscules), corps (chunked décodé).
    static func parse(_ raw: Data) -> Resp? {
        guard let sep = raw.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: raw[..<sep.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
        guard let line = head.first, line.hasPrefix("HTTP/1."), let st = Int(line.split(separator: " ").dropFirst().first ?? "") else { return nil }
        var h: [String: String] = [:]
        for l in head.dropFirst() {
            guard let c = l.firstIndex(of: ":") else { continue }
            h[l[..<c].trimmingCharacters(in: .whitespaces).lowercased()] = l[l.index(after: c)...].trimmingCharacters(in: .whitespaces)
        }
        var body = Data(raw[sep.upperBound...])
        if h["transfer-encoding"]?.lowercased().contains("chunked") == true { body = dechunk(body) }
        else if let n = h["content-length"].flatMap(Int.init), n < body.count { body = body.prefix(n) }
        if body.count > maxBytes { body = body.prefix(maxBytes) }
        return Resp(status: st, headers: h, body: body)
    }

    static func dechunk(_ d: Data) -> Data {
        var out = Data()
        var i = d.startIndex
        while i < d.endIndex, let lineEnd = d[i...].range(of: Data("\r\n".utf8)) {
            let sizeS = String(decoding: d[i..<lineEnd.lowerBound], as: UTF8.self).split(separator: ";").first ?? ""
            guard let n = Int(sizeS.trimmingCharacters(in: .whitespaces), radix: 16), n > 0 else { break }
            let start = lineEnd.upperBound
            let end = d.index(start, offsetBy: n, limitedBy: d.endIndex) ?? d.endIndex
            out.append(d[start..<end])
            i = d.index(end, offsetBy: 2, limitedBy: d.endIndex) ?? d.endIndex
        }
        return out
    }

    static func decode(_ d: Data, charset: String?) -> String {
        if let cs = charset, !cs.isEmpty {
            let enc = CFStringConvertIANACharSetNameToEncoding(cs as CFString)
            if enc != kCFStringEncodingInvalidId, let s = String(data: d, encoding: String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(enc))) { return s }
        }
        return String(decoding: d, as: UTF8.self)
    }

    // MARK: - Autotest du CI (debug seulement)

    #if DEBUG
    /// Classification sur des vecteurs (fatal au CI), refus d'un hôte local, puis un vrai fetch épinglé si le réseau répond.
    static func selfTest() {
        func v4(_ s: String) -> [UInt8] { s.split(separator: ".").compactMap { UInt8($0) } }
        func v6(_ s: String) -> [UInt8] {
            var a = in6_addr()
            _ = inet_pton(AF_INET6, s, &a)
            return withUnsafeBytes(of: a) { Array($0) }
        }
        let refused = ["10.0.0.1", "192.168.1.1", "172.16.5.4", "127.0.0.1", "169.254.1.1", "0.1.2.3", "224.0.0.1"].allSatisfy { blockedV4(v4($0)) != nil }
            && blockedV4([100, 64, 0, 1]) == "cgnat" && blockedV4([100, 127, 255, 254]) == "cgnat" && blockedV4([100, 128, 0, 1]) == nil
            && ["::1", "::", "fe80::1", "fd00::1", "ff02::1", "::ffff:192.168.1.1", "64:ff9b::c0a8:101", "2002:c0a8:101::1", "2001:db8::1"].allSatisfy { blockedV6(v6($0)) != nil }
        let accepted = blockedV4(v4("8.8.8.8")) == nil && blockedV6(v6("2606:4700:4700::1111")) == nil && blockedV6(v6("64:ff9b::808:808")) == nil
        let hosts = !hostOK("printer.local") && !hostOK("box.home.arpa") && !hostOK("10.0.0.1") && !hostOK("intranet") && hostOK("example.com")
        let allow = hostAllowed("a.example.ch", ["*.example.ch"]) && !hostAllowed("example.ch", ["*.example.ch"]) && !hostAllowed("evilexample.ch", ["*.example.ch"])
        NSLog("NokkerEgress: self-test classify \(refused && accepted && hosts && allow ? "ok" : "FAILED") (refused \(refused), accepted \(accepted), hosts \(hosts), allow \(allow))")
        let was = enabled
        enabled = true
        fetch(["url": "https://printer.local/", "trigger": "explicit"], path: nil) { r in
            if case .failure(let f) = r { NSLog("NokkerEgress: self-test local refused \(f.code)") }
            DispatchQueue.main.async { fetch(["url": "https://example.com/", "trigger": "explicit"], path: nil) { r in
                enabled = was
                switch r {
                case .success(let p): NSLog("NokkerEgress: self-test fetch status \(p.status) example \(p.text.contains("Example Domain")) bytes \(p.bytes)")
                case .failure(let f): NSLog("NokkerEgress: self-test fetch failed \(f.code) \(f.reason ?? "")")
                }
            } }
        }
    }
    #endif
}
