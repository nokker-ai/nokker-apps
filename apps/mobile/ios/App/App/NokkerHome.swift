import CryptoKit
import Foundation
import Network
import NetworkExtension
import Security

/// Mode « nœud maison » (LOKKAL-PHONE §4.4, lot P10a, phase S) : relais Home Assistant sur le LAN, mêmes opérations,
/// arguments et résultats que `home-bridge` (OPS) ; référence TypeScript : packages/sdk/src/home-relay.ts.
///
/// - Réglages sur l'appareil : mode maison allumé, URL de base de HA (PRIVÉE seulement), motifs d'entités (vide par
///   défaut). Jeton HA (compte non administrateur) saisi dans un champ NATIF, gardé dans le trousseau
///   (ThisDeviceOnly) : il ne passe jamais dans la WebView et ne sort jamais.
/// - Wi-Fi « maison » : empreinte sha256(sel ‖ BSSID) gardée dans le trousseau, le BSSID ne sort jamais ; lu par
///   `NEHotspotNetwork.fetchCurrent` (entitlement wifi-info et autorisation de position : vrai appareil, P3). Sans
///   cela, `home_wifi` reste faux et `lan_home` reste `off`.
/// - Connexion : nom résolu UNE fois, TOUTES les adresses privées exigées, WebSocket vers l'IP (aucune seconde
///   résolution) ; en https, certificat vérifié pour le NOM demandé.
/// - Aucune coordonnée ne part : `latitude`, `longitude`, `gps_accuracy` retirés de `person`, `device_tracker`, `zone`.
/// - Échecs : codes seulement (`not_home_wifi`, `ha_not_configured`, `ha_unreachable`, `ha_auth_failed`,
///   `entity_not_allowed`, `service_not_allowed`, `ha_error`, `bad_args`) ; les phrases sont dans le noyau.
enum NokkerHome {
    struct Fail: Error { let code: String }

    // MARK: - Réglages

    private static let onKey = "nokker.home.on"
    private static let urlKey = "nokker.home.ha_url"
    private static let entitiesKey = "nokker.home.entities"
    static let tokenAccount = "ha-token"
    static let wifiAccount = "home-wifi"
    static let saltAccount = "home-wifi-salt"
    static let targetsMax = 10
    static let historyMaxH = 24.0 * 7
    static let querySet: Set<String> = ["weather.get_forecasts", "calendar.get_events", "todo.get_items", "media_player.search_media", "music_assistant.search", "music_assistant.get_queue"]
    static let targetKeys: Set<String> = ["entity_id", "area_id", "device_id", "floor_id", "label_id"]
    static let targetDomain: [String: String] = ["music_assistant": "media_player"]
    static let entityRefKeys: [String: String] = ["group_members": "media_player", "media_player_entity_id": "media_player", "source_player": "media_player"]
    static let coordDomains: Set<String> = ["person", "device_tracker", "zone"]

    static var on: Bool {
        get { UserDefaults.standard.bool(forKey: onKey) }
        set { UserDefaults.standard.set(newValue, forKey: onKey) }
    }
    static var baseURL: String? {
        get { UserDefaults.standard.string(forKey: urlKey) }
        set { UserDefaults.standard.set(newValue, forKey: urlKey); reset() }
    }
    static var entities: [String] {
        get { UserDefaults.standard.stringArray(forKey: entitiesKey) ?? [] }
        set { UserDefaults.standard.set(newValue, forKey: entitiesKey) }
    }
    static var tokenSet: Bool { NokkerNodePlugin.kcGet(tokenAccount) != nil }
    static var homeWifiSet: Bool { NokkerNodePlugin.kcGet(wifiAccount) != nil }
    /// Dernière lecture du Wi-Fi courant (rafraîchie à chaque battement et avant chaque tâche).
    private(set) static var homeWifiNow = false
    static var lastCheck: String?
    #if DEBUG
    /// Autotest du CI : simulateur sans Wi-Fi ni entitlement, faux HA sur la boucle locale.
    static var ciHomeWifi = false
    static var ciLoopback = false
    #endif

    static var configured: Bool { baseURL != nil && tokenSet }
    /// `caps.lan_home` du battement : allumé, configuré, et sur le Wi-Fi déclaré « maison ».
    static var lanHome: Bool { on && configured && homeWifiNow }

    static func setToken(_ token: String) -> Bool {
        reset()
        return NokkerNodePlugin.kcSet(tokenAccount, Data(token.utf8))
    }

    static func forget() {
        reset()
        NokkerNodePlugin.kcDelete(tokenAccount)
        NokkerNodePlugin.kcDelete(wifiAccount)
        NokkerNodePlugin.kcDelete(saltAccount)
        UserDefaults.standard.removeObject(forKey: urlKey)
        UserDefaults.standard.removeObject(forKey: entitiesKey)
        on = false
        homeWifiNow = false
        lastCheck = nil
    }

    // MARK: - Wi-Fi « maison »

    private static func salt() -> Data {
        if let s = NokkerNodePlugin.kcGet(saltAccount), s.count == 32 { return s }
        var b = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, b.count, &b)
        let d = Data(b)
        _ = NokkerNodePlugin.kcSet(saltAccount, d)
        return d
    }

    static func wifiDigest(_ bssid: String) -> Data {
        Data(SHA256.hash(data: salt() + Data(bssid.lowercased().utf8)))
    }

    /// Relit le Wi-Fi courant ; rappel sur le fil principal.
    static func refreshWifi(_ done: @escaping (Bool) -> Void) {
        #if DEBUG
        if ciHomeWifi { homeWifiNow = true; return done(true) }
        #endif
        guard let want = NokkerNodePlugin.kcGet(wifiAccount) else { homeWifiNow = false; return done(false) }
        NEHotspotNetwork.fetchCurrent { net in
            let ok = net.map { wifiDigest($0.bssid) == want } ?? false
            DispatchQueue.main.async { homeWifiNow = ok; done(ok) }
        }
    }

    /// « Ce Wi-Fi est celui de la maison » : rend faux si l'OS ne donne pas le réseau courant.
    static func markHomeWifi(_ done: @escaping (Bool) -> Void) {
        NEHotspotNetwork.fetchCurrent { net in
            DispatchQueue.main.async {
                guard let net, !net.bssid.isEmpty else { return done(false) }
                _ = NokkerNodePlugin.kcSet(wifiAccount, wifiDigest(net.bssid))
                homeWifiNow = true
                done(true)
            }
        }
    }

    // MARK: - Adresses

    static func privateV4(_ b: [UInt8]) -> Bool {
        guard b.count == 4 else { return false }
        return b[0] == 10 || (b[0] == 172 && (16...31).contains(b[1])) || (b[0] == 192 && b[1] == 168) || (b[0] == 169 && b[1] == 254)
    }

    static func privateV6(_ b: [UInt8]) -> Bool {
        guard b.count == 16 else { return false }
        return (b[0] & 0xfe) == 0xfc || (b[0] == 0xfe && (b[1] & 0xc0) == 0x80)
    }

    static func loopback(_ a: NokkerEgress.Addr) -> Bool {
        switch a {
        case .v4(let b): return b.first == 127
        case .v6(let b): return b == [UInt8](repeating: 0, count: 15) + [1]
        }
    }

    /// URL de base acceptable (même règle que `haUrlCheck` du SDK) : http(s), hôte `.local` ou IP privée, sans
    /// identifiants ni chemin. Rend `scheme://host:port` ou nil.
    static func normalizeBase(_ raw: String) -> String? {
        guard let c = URLComponents(string: raw.trimmingCharacters(in: .whitespaces)), let scheme = c.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = c.host?.lowercased(), !host.isEmpty, c.user == nil, c.password == nil, c.query == nil, c.fragment == nil,
              c.path.isEmpty || c.path == "/" else { return nil }
        let bare = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        var ok = false
        if let v4 = parseV4(bare) { ok = privateV4(v4) }
        else if let v6 = parseV6(bare) { ok = privateV6(v6) }
        else { ok = host.range(of: "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.local$", options: .regularExpression) != nil }
        #if DEBUG
        if ciLoopback, bare == "127.0.0.1" { ok = true }
        #endif
        guard ok else { return nil }
        let h = bare.contains(":") ? "[\(bare)]" : bare
        return "\(scheme)://\(h)" + (c.port.map { ":\($0)" } ?? "")
    }

    static func parseV4(_ s: String) -> [UInt8]? {
        var a = in_addr()
        guard inet_pton(AF_INET, s, &a) == 1 else { return nil }
        return withUnsafeBytes(of: a) { Array($0) }
    }

    static func parseV6(_ s: String) -> [UInt8]? {
        var a = in6_addr()
        guard inet_pton(AF_INET6, s, &a) == 1 else { return nil }
        return withUnsafeBytes(of: a) { Array($0) }
    }

    /// Résolution UNIQUE ; toutes les adresses doivent être privées (un `.local` qui pointe dehors est refusé).
    static func target(_ base: URL) -> String? {
        guard let host = base.host?.trimmingCharacters(in: CharacterSet(charactersIn: "[]")) else { return nil }
        guard let addrs = NokkerEgress.resolve(host), !addrs.isEmpty else { return nil }
        var first: String?
        for a in addrs {
            var ok: Bool
            switch a {
            case .v4(let b): ok = privateV4(b)
            case .v6(let b): ok = privateV6(b)
            }
            #if DEBUG
            if ciLoopback, loopback(a) { ok = true }
            #endif
            guard ok else { return nil }
            if first == nil {
                switch a {
                case .v4(let b): first = b.map(String.init).joined(separator: ".")
                case .v6(var b):
                    var out = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
                    _ = inet_ntop(AF_INET6, &b, &out, socklen_t(out.count))
                    first = "[\(String(cString: out))]"
                }
            }
        }
        return first
    }

    // MARK: - Entités

    static func allowed(_ id: String, _ patterns: [String]) -> Bool {
        patterns.contains { glob($0, id) }
    }

    /// `fnmatchcase` restreint à `*` et `?` (les motifs sont normalisés dans l'app : minuscules, `domaine.objet`).
    static func glob(_ p: String, _ s: String) -> Bool {
        let pc = Array(p), sc = Array(s)
        var i = 0, j = 0, star = -1, mark = 0
        while j < sc.count {
            if i < pc.count, pc[i] == "?" || pc[i] == sc[j] { i += 1; j += 1 }
            else if i < pc.count, pc[i] == "*" { star = i; mark = j; i += 1 }
            else if star >= 0 { i = star + 1; mark += 1; j = mark }
            else { return false }
        }
        while i < pc.count, pc[i] == "*" { i += 1 }
        return i == pc.count
    }

    static func strip(_ s: Any) -> Any {
        guard var o = s as? [String: Any], let id = o["entity_id"] as? String, coordDomains.contains(String(id.split(separator: ".").first ?? "")),
              var attrs = o["attributes"] as? [String: Any] else { return s }
        for k in ["latitude", "longitude", "gps_accuracy"] { attrs.removeValue(forKey: k) }
        o["attributes"] = attrs
        return o
    }

    /// `_targets` de home-bridge : nil si permis, sinon le code.
    static func targetsProblem(_ p: [String: Any], _ patterns: [String]) -> String? {
        guard let domain = p["domain"] as? String, !domain.isEmpty, let service = p["service"] as? String, !service.isEmpty,
              let ids = p["entity_ids"] as? [Any], !ids.isEmpty, ids.count <= targetsMax else { return "bad_args" }
        let data = p["data"] ?? [String: Any]()
        guard let d = data as? [String: Any] else { return "bad_args" }
        if d.keys.contains(where: targetKeys.contains) { return "entity_not_allowed" }
        let tdom = targetDomain[domain] ?? domain
        var bad = ids.map { "\($0)" }.filter { !allowed($0, patterns) || String($0.split(separator: ".").first ?? "") != tdom }
        for (key, refDomain) in entityRefKeys {
            guard let v = d[key] else { continue }
            let refs = (v as? [Any]) ?? [v]
            bad += refs.map { "\($0)" }.filter { !allowed($0, patterns) || String($0.split(separator: ".").first ?? "") != refDomain }
        }
        return bad.isEmpty ? nil : "entity_not_allowed"
    }

    // MARK: - Session WebSocket

    private static var session: Session?

    static func reset() {
        session?.close()
        session = nil
    }

    private static func current() -> Session? {
        if let s = session { return s }
        guard let raw = baseURL, let base = URL(string: raw), let tok = NokkerNodePlugin.kcGet(tokenAccount).flatMap({ String(data: $0, encoding: .utf8) }) else { return nil }
        let s = Session(base: base, token: tok)
        session = s
        return s
    }

    final class Session {
        let base: URL
        private let token: String
        private let q = DispatchQueue(label: "nokker.home.ha")
        private var conn: NWConnection?
        private var authed = false
        private var connecting: [(Fail?) -> Void] = []
        private var nextId = 1
        private var pending: [Int: (Result<Any, Fail>) -> Void] = [:]
        private var seq = 0
        private var buffer: [[String: Any]] = []
        private var waiters: [() -> Void] = []
        private(set) var subscribed = false

        init(base: URL, token: String) {
            self.base = base
            self.token = token
        }

        func close() {
            q.async { self.fail(Fail(code: "ha_unreachable")) }
        }

        private func fail(_ f: Fail) {
            conn?.cancel()
            conn = nil
            authed = false
            subscribed = false
            let c = connecting
            connecting = []
            for cb in c { cb(f) }
            let p = pending
            pending = [:]
            for (_, cb) in p { cb(.failure(f)) }
        }

        private func connect(_ done: @escaping (Fail?) -> Void) {
            if authed { return done(nil) }
            connecting.append(done)
            if conn != nil { return }
            let port = base.port ?? (base.scheme == "https" ? 443 : 80)
            guard let ip = NokkerHome.target(base), let url = URL(string: "\(base.scheme == "https" ? "wss" : "ws")://\(ip):\(port)/api/websocket") else { return fail(Fail(code: "ha_unreachable")) }
            let ws = NWProtocolWebSocket.Options()
            ws.autoReplyPing = true
            ws.maximumMessageSize = 8 * 1024 * 1024
            let params: NWParameters
            if base.scheme == "https" {
                let host = base.host?.trimmingCharacters(in: CharacterSet(charactersIn: "[]")) ?? ""
                let tls = NWProtocolTLS.Options()
                let sec = tls.securityProtocolOptions
                sec_protocol_options_set_min_tls_protocol_version(sec, .TLSv12)
                sec_protocol_options_set_tls_server_name(sec, host)
                sec_protocol_options_set_verify_block(sec, { _, trustRef, complete in
                    let trust = sec_trust_copy_ref(trustRef).takeRetainedValue()
                    SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString))
                    complete(SecTrustEvaluateWithError(trust, nil))
                }, q)
                params = NWParameters(tls: tls)
            } else {
                params = NWParameters.tcp
            }
            params.preferNoProxies = true
            params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
            let c = NWConnection(to: .url(url), using: params)
            conn = c
            q.asyncAfter(deadline: .now() + 8) { [weak self] in
                guard let self, !self.authed, self.conn === c else { return }
                self.fail(Fail(code: "ha_unreachable"))
            }
            c.stateUpdateHandler = { [weak self] st in
                guard let self else { return }
                switch st {
                case .ready: self.receive(c)
                case .failed, .cancelled: if self.conn === c { self.fail(Fail(code: "ha_unreachable")) }
                case .waiting: if self.conn === c { self.fail(Fail(code: "ha_unreachable")) }
                default: break
                }
            }
            c.start(queue: q)
        }

        private func send(_ o: [String: Any]) {
            guard let c = conn, let d = try? JSONSerialization.data(withJSONObject: o) else { return }
            let meta = NWProtocolWebSocket.Metadata(opcode: .text)
            let ctx = NWConnection.ContentContext(identifier: "text", metadata: [meta])
            c.send(content: d, contentContext: ctx, isComplete: true, completion: .contentProcessed { _ in })
        }

        private func receive(_ c: NWConnection) {
            c.receiveMessage { [weak self] data, _, _, error in
                guard let self, self.conn === c else { return }
                if error != nil { return self.fail(Fail(code: "ha_unreachable")) }
                if let data, let m = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { self.handle(m) }
                if self.conn === c { self.receive(c) }
            }
        }

        private func handle(_ m: [String: Any]) {
            switch m["type"] as? String {
            case "auth_required":
                send(["type": "auth", "access_token": token])
            case "auth_ok":
                authed = true
                let c = connecting
                connecting = []
                for cb in c { cb(nil) }
            case "auth_invalid":
                fail(Fail(code: "ha_auth_failed"))
            case "event":
                guard let ev = m["event"] as? [String: Any] else { return }
                onEvent(ev)
            case "result":
                guard let id = m["id"] as? Int, let cb = pending.removeValue(forKey: id) else { return }
                if m["success"] as? Bool == true { cb(.success(m["result"] ?? NSNull())) }
                else { cb(.failure(Fail(code: ((m["error"] as? [String: Any])?["code"] as? String) == "unauthorized" ? "ha_auth_failed" : "ha_error"))) }
            default:
                break
            }
        }

        private func onEvent(_ ev: [String: Any]) {
            guard var data = ev["data"] as? [String: Any], let eid = data["entity_id"] as? String, NokkerHome.allowed(eid, NokkerHome.entities) else { return }
            for k in ["old_state", "new_state"] { if let s = data[k], !(s is NSNull) { data[k] = NokkerHome.strip(s) } }
            var e = ev
            e["data"] = data
            seq += 1
            buffer.append(["seq": seq, "event": e])
            if buffer.count > 1000 { buffer.removeFirst(buffer.count - 1000) }
            let w = waiters
            waiters = []
            for cb in w { cb() }
        }

        /// Commande HA ; rappel sur la file de la session.
        func command(_ type: String, _ payload: [String: Any] = [:], _ done: @escaping (Result<Any, Fail>) -> Void) {
            q.async {
                self.connect { f in
                    if let f { return done(.failure(f)) }
                    let id = self.nextId
                    self.nextId += 1
                    self.pending[id] = done
                    var o = payload
                    o["id"] = id
                    o["type"] = type
                    self.send(o)
                    self.q.asyncAfter(deadline: .now() + 10) {
                        if let cb = self.pending.removeValue(forKey: id) { cb(.failure(Fail(code: "ha_unreachable"))) }
                    }
                }
            }
        }

        func subscribe(_ done: @escaping (Fail?) -> Void) {
            q.async {
                if self.subscribed { return done(nil) }
                self.command("subscribe_events", ["event_type": "state_changed"]) { r in
                    if case .failure(let f) = r { return done(f) }
                    self.subscribed = true
                    done(nil)
                }
            }
        }

        /// Événements après `after` ; attend jusqu'à `timeout` s s'il n'y en a pas.
        func events(after: Int, timeout: Double, _ done: @escaping ([String: Any]) -> Void) {
            q.async {
                let fresh = { self.buffer.filter { ($0["seq"] as? Int ?? 0) > after } }
                if after < 0 { return done(["cursor": self.seq, "events": [Any]()]) }
                if !fresh().isEmpty || timeout <= 0 { return done(["cursor": self.seq, "events": fresh()]) }
                var answered = false
                let answer = {
                    guard !answered else { return }
                    answered = true
                    done(["cursor": self.seq, "events": fresh()])
                }
                self.waiters.append(answer)
                self.q.asyncAfter(deadline: .now() + timeout, execute: answer)
            }
        }
    }

    // MARK: - Une tâche de la file

    /// `ha.*` : résultat JSON ou code ; rappel sur le fil principal.
    static func run(_ op: String, _ p: [String: Any], _ done: @escaping (Result<[String: Any], Fail>) -> Void) {
        let main: (Result<[String: Any], Fail>) -> Void = { r in DispatchQueue.main.async { done(r) } }
        guard on, configured else { return main(.failure(Fail(code: "ha_not_configured"))) }
        refreshWifi { home in
            guard home else { return main(.failure(Fail(code: "not_home_wifi"))) }
            guard let s = current() else { return main(.failure(Fail(code: "ha_not_configured"))) }
            execute(s, op, p, entities, main)
        }
    }

    private static func execute(_ s: Session, _ op: String, _ p: [String: Any], _ pats: [String], _ done: @escaping (Result<[String: Any], Fail>) -> Void) {
        let pass: (Result<Any, Fail>, (Any) -> [String: Any]) -> Void = { r, map in
            switch r {
            case .success(let v): done(.success(map(v)))
            case .failure(let f): done(.failure(f))
            }
        }
        let pick: ([String: Any], [String]) -> [String: Any] = { o, keys in Dictionary(uniqueKeysWithValues: keys.map { ($0, o[$0] ?? NSNull()) }) }
        switch op {
        case "ha.states":
            s.command("get_states") { r in
                pass(r) { v in ["states": ((v as? [[String: Any]]) ?? []).filter { allowed($0["entity_id"] as? String ?? "", pats) }.map(strip)] }
            }
        case "ha.registry":
            s.command("config/area_registry/list") { a in
                guard case .success(let areas) = a else { return pass(a) { _ in [:] } }
                s.command("config/device_registry/list") { d in
                    guard case .success(let devices) = d else { return pass(d) { _ in [:] } }
                    s.command("config/entity_registry/list") { e in
                        pass(e) { ents in
                            ["areas": ((areas as? [[String: Any]]) ?? []).map { pick($0, ["area_id", "name"]) },
                             "devices": ((devices as? [[String: Any]]) ?? []).map { pick($0, ["id", "area_id"]) },
                             "entities": ((ents as? [[String: Any]]) ?? []).filter { allowed($0["entity_id"] as? String ?? "", pats) }.map { pick($0, ["entity_id", "area_id", "device_id", "hidden_by", "disabled_by", "platform"]) }]
                        }
                    }
                }
            }
        case "ha.call_service", "ha.query":
            if let bad = targetsProblem(p, pats) { return done(.failure(Fail(code: bad))) }
            let key = "\(p["domain"] as? String ?? "").\(p["service"] as? String ?? "")"
            let query = querySet.contains(key)
            if (op == "ha.call_service") == query { return done(.failure(Fail(code: "service_not_allowed"))) }
            var payload: [String: Any] = ["domain": p["domain"] ?? "", "service": p["service"] ?? "", "service_data": p["data"] ?? [String: Any](), "target": ["entity_id": p["entity_ids"] ?? []]]
            if query { payload["return_response"] = true }
            s.command("call_service", payload) { r in
                pass(r) { v in
                    if op == "ha.call_service" { return ["ok": true] }
                    let resp = ((v as? [String: Any])?["response"] as? [String: Any]) ?? [:]
                    return ["response": resp.filter { allowed($0.key, pats) }]
                }
            }
        case "ha.notify":
            let target = p["target"] as? String ?? "", message = p["message"] as? String ?? "", title = p["title"] as? String ?? ""
            guard !message.isEmpty, message.count <= 1000, title.count <= 200 else { return done(.failure(Fail(code: "bad_args"))) }
            guard target.hasPrefix("notify."), allowed(target, pats) else { return done(.failure(Fail(code: "entity_not_allowed"))) }
            var data: [String: Any] = ["message": message]
            if !title.isEmpty { data["title"] = title }
            s.command("call_service", ["domain": "notify", "service": "send_message", "service_data": data, "target": ["entity_id": [target]]]) { r in pass(r) { _ in ["ok": true] } }
        case "ha.tracker_see":
            guard Set(p.keys).isSubset(of: ["dev_id", "location_name"]), let dev = p["dev_id"] as? String, let where_ = p["location_name"] as? String,
                  dev.range(of: "^nokker_[a-z0-9_]{1,48}$", options: .regularExpression) != nil, !where_.isEmpty, where_.count <= 40 else { return done(.failure(Fail(code: "bad_args"))) }
            s.command("call_service", ["domain": "device_tracker", "service": "see", "service_data": ["dev_id": dev, "location_name": where_]]) { r in pass(r) { _ in ["ok": true] } }
        case "ha.history", "ha.logbook":
            guard let ids = (p["entity_ids"] as? [Any])?.map({ "\($0)" }), !ids.isEmpty, ids.count <= targetsMax else { return done(.failure(Fail(code: "bad_args"))) }
            guard ids.allSatisfy({ allowed($0, pats) }) else { return done(.failure(Fail(code: "entity_not_allowed"))) }
            let hours = max(0.1, min((p["hours"] as? Double) ?? Double(p["hours"] as? Int ?? 24), historyMaxH))
            let start = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-hours * 3600))
            if op == "ha.history" {
                s.command("history/history_during_period", ["start_time": start, "entity_ids": ids, "minimal_response": true, "no_attributes": true, "significant_changes_only": false]) { r in
                    pass(r) { v in
                        var out: [String: Any] = [:]
                        for (k, rows) in (v as? [String: Any]) ?? [:] where allowed(k, pats) {
                            guard let rows = rows as? [[String: Any]] else { continue }
                            out[k] = rows.map { ["s": $0["s"] ?? NSNull(), "lu": $0["lu"] ?? $0["lc"] ?? NSNull()] }.suffix(200).map { $0 }
                        }
                        return ["history": out]
                    }
                }
            } else {
                s.command("logbook/get_events", ["start_time": start, "entity_ids": ids]) { r in
                    pass(r) { v in
                        let keep = ["when", "entity_id", "state", "name", "message"]
                        let rows = ((v as? [[String: Any]]) ?? []).filter { allowed($0["entity_id"] as? String ?? "", pats) }.map { e in e.filter { keep.contains($0.key) } }
                        return ["entries": Array(rows.suffix(200))]
                    }
                }
            }
        case "ha.events":
            let after = (p["after"] as? Int) ?? -1
            let timeout = max(0, min(20, (p["timeout"] as? Double) ?? Double(p["timeout"] as? Int ?? 20)))
            s.subscribe { f in
                if let f { return done(.failure(f)) }
                s.events(after: after, timeout: timeout) { done(.success($0)) }
            }
        default:
            done(.failure(Fail(code: "bad_args")))
        }
    }

    // MARK: - Autotest du CI (debug seulement)

    #if DEBUG
    /// Contre le faux HA du CI (scripts/ios-ci/fake-ha.mjs, boucle locale) : états filtrés sans coordonnées, appel
    /// ciblé puis son événement, deux refus de l'appareil, jeton refusé. Le jeton de test vient du drapeau du CI.
    static func selfTest(url: String, token: String) {
        let addr = privateV4([192, 168, 1, 2]) && privateV4([10, 1, 2, 3]) && !privateV4([8, 8, 8, 8]) && !privateV4([100, 64, 0, 1]) && !privateV4([127, 0, 0, 1])
            && privateV6([0xfd] + [UInt8](repeating: 0, count: 15)) && !privateV6([0x20, 0x01] + [UInt8](repeating: 0, count: 14))
            && normalizeBase("https://ha.example.ch") == nil && normalizeBase("http://192.168.1.20:8123/") == "http://192.168.1.20:8123"
            && glob("light.*", "light.salon") && !glob("light.*", "switch.four") && !glob("light.salon", "lightxsalon")
        NSLog("NokkerHome: self-test addr \(addr ? "ok" : "FAILED")")
        ciHomeWifi = true
        ciLoopback = true
        guard let base = normalizeBase(url) else { return NSLog("NokkerHome: self-test ha FAILED base") }
        baseURL = base
        _ = setToken(token)
        entities = ["light.*", "person.*", "zone.*"]
        on = true
        func step(_ op: String, _ p: [String: Any], _ next: @escaping (Result<[String: Any], Fail>) -> Void) { run(op, p, next) }
        step("ha.states", [:]) { r in
            guard case .success(let st) = r, let states = st["states"] as? [[String: Any]] else { return NSLog("NokkerHome: self-test ha FAILED states \(r)") }
            let json = (try? JSONSerialization.data(withJSONObject: st)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let clean = !json.contains("latitude") && !json.contains("gps_accuracy")
            step("ha.events", ["after": -1]) { _ in
                var got = 0
                step("ha.events", ["after": 0, "timeout": 5]) { ev in
                    if case .success(let e) = ev { got = (e["events"] as? [Any])?.count ?? 0 }
                    step("ha.call_service", ["domain": "switch", "service": "turn_on", "entity_ids": ["switch.four"]]) { r1 in
                        step("ha.call_service", ["domain": "light", "service": "turn_on", "entity_ids": ["light.salon"], "data": ["area_id": "salon"]]) { r2 in
                            var refused = 0
                            if case .failure(let f) = r1, f.code == "entity_not_allowed" { refused += 1 }
                            if case .failure(let f) = r2, f.code == "entity_not_allowed" { refused += 1 }
                            _ = setToken("wrong")
                            step("ha.states", [:]) { r3 in
                                var auth = "?"
                                if case .failure(let f) = r3 { auth = f.code }
                                let ok = states.count == 4 && clean && got == 1 && refused == 2 && auth == "ha_auth_failed"
                                NSLog("NokkerHome: self-test ha \(ok ? "ok" : "FAILED") (states \(states.count), clean \(clean), events \(got), refused \(refused), auth \(auth))")
                                forget()
                            }
                        }
                    }
                }
                // L'appel qui fait naître l'événement attendu ci-dessus.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    step("ha.call_service", ["domain": "light", "service": "turn_on", "entity_ids": ["light.salon"]]) { r in
                        if case .failure(let f) = r { NSLog("NokkerHome: self-test ha call failed \(f.code)") }
                    }
                }
            }
        }
    }
    #endif
}
