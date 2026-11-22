import AVFoundation
import JavaScriptCore
import LocalAuthentication
import UIKit

/// « Frapper pour appeler » sur le NŒUD MAISON (décision produit du 06.11 ; docs du noyau KNOCK.md).
///
/// Règles :
/// - ÉTEINT par défaut ; seul le propriétaire de l'appareil l'allume (Face ID, Touch ID ou code : LAContext). Couper ne
///   demande RIEN : n'importe qui dans la pièce fait taire le micro (bandeau « Couper »), seul le rallumage est protégé.
/// - Détection LOCALE, en natif (AVAudioEngine) : la WebView n'a toujours PAS le micro en mode maison ou mur
///   (NokkerMediaGuard inchangé). Le détecteur est le module du noyau `knock-worklet.js` (copié tel quel dans
///   public/knock, avec ses poids), exécuté dans un JSContext natif hors de la WebView : même algorithme, parité par
///   construction. Le son est ramené à 16 kHz ; en mémoire : la fenêtre de 25 ms et ~100 trames de 32 niveaux.
///   Jamais écrit, jamais envoyé ; du JSContext ne sortent que des faits (trois coups, instant, confiance).
/// - Rien ne sort avant les trois coups ; ensuite : « oui ? » joué ici, puis le web lance UNE dictée sur l'appareil
///   (arrêt au silence), envoyée dans la session du titulaire ; l'écoute reprend quand le micro est rendu.
/// - Bandeau permanent tant que l'écoute tourne. Premier plan seulement : en arrière-plan elle s'arrête et reprend
///   d'elle-même au retour (le réglage reste allumé).
/// - Écran mural : PAS ici (voix du foyer, jeton à portée propre, contrat à venir).
enum NokkerKnock {
    static let onKey = "nokker.knock.on"
    static let cutKey = "nokker.knock.cut"

    /// Réglage du propriétaire (allumé seulement après LAContext).
    static var on: Bool {
        get { UserDefaults.standard.bool(forKey: onKey) }
        set { UserDefaults.standard.set(newValue, forKey: onKey) }
    }

    /// Coupé depuis le bandeau ou le réglage (sans authentification) : reste éteint jusqu'au rallumage du propriétaire.
    static var cut: Bool {
        get { UserDefaults.standard.bool(forKey: cutKey) }
        set { UserDefaults.standard.set(newValue, forKey: cutKey) }
    }

    static var permission: String {
        switch AVAudioSession.sharedInstance().recordPermission {
        case .granted: return "granted"
        case .denied: return "denied"
        default: return "undetermined"
        }
    }

    /// Prévenu (fil principal) après les trois coups, une fois le « oui ? » joué : `{t, confidence}`.
    static var onKnock: (([String: Any]) -> Void)?
    /// Prévenu (fil principal) à chaque changement d'état.
    static var onState: (() -> Void)?

    /// Qui tient le micro en ce moment (la dictée, le « oui ? ») : l'écoute attend qu'il soit rendu.
    private static var holds = Set<String>()
    private static var foreground = true
    private static var engine: AVAudioEngine?
    private static var banner: UIView?
    private static var lastError: String?

    static var running: Bool { engine?.isRunning == true }

    /// État pour le web : off | listening | cut | background | held | denied | unavailable.
    static var state: String {
        if running { return "listening" }
        if cut && !on { return "cut" }
        if !on { return "off" }
        if permission == "denied" { return "denied" }
        if lastError != nil { return "unavailable" }
        if !foreground { return "background" }
        if !holds.isEmpty { return "held" }
        return "off"
    }

    /// Destination des trois coups en mode maison : la voix du foyer (wall_voice, jeton nkw_ à portée fermée), JAMAIS
    /// la session complète du titulaire (décision dev 06.11 : pièce commune). Tant que la route n'est pas en prod et que
    /// le nœud n'a pas son nkw_, la fonction est INDISPONIBLE : réglage caché, allumage refusé, aucune écoute.
    static var available: Bool { false }

    static func payload() -> [String: Any] {
        ["on": on, "state": state, "cut": cut, "permission": permission, "available": available]
    }

    static func shouldRun() -> Bool {
        available && on && foreground && holds.isEmpty && NokkerHome.on && !(NokkerWall.on || NokkerWall.active) && permission == "granted"
    }

    /// Démarre ou arrête selon les conditions (fil principal).
    static func apply(foreground fg: Bool? = nil) {
        if let fg { foreground = fg }
        if shouldRun() { start() } else { stop() }
        onState?()
    }

    /// La dictée (ou le « oui ? ») prend le micro / le rend.
    /// Synchrone quand le micro est PRIS (l'écoute est arrêtée avant que la dictée configure la session audio).
    static func hold(_ who: String, _ held: Bool) {
        let work = {
            if held { holds.insert(who) } else { holds.remove(who) }
            if held { holds.remove("call") } // la dictée lancée après les coups prend le relais
            apply()
        }
        if Thread.isMainThread { work() } else if held { DispatchQueue.main.sync(execute: work) } else { DispatchQueue.main.async(execute: work) }
    }

    // MARK: - Allumer (propriétaire) / couper (n'importe qui)

    static func ownerReason() -> String {
        fr ? "Allumer l'écoute des trois coups sur ce nœud maison" : "Turn on listening for three knocks on this home node"
    }

    /// Allumage : authentification du propriétaire, puis micro ; rappel sur le fil principal (`nil` = allumé).
    static func turnOn(_ done: @escaping (String?) -> Void) {
        guard available else { return done("unavailable") }
        guard NokkerHome.on else { return done("not_home") }
        let ctx = LAContext()
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else { return done("no_passcode") }
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: ownerReason()) { ok, _ in
            guard ok else { return DispatchQueue.main.async { done("auth_failed") } }
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                DispatchQueue.main.async {
                    guard granted else { apply(); return done("denied") }
                    on = true
                    cut = false
                    lastError = nil
                    NSLog("NokkerKnock: turned on by the owner")
                    apply()
                    done(nil)
                }
            }
        }
    }

    /// Couper : aucune authentification. `fromBanner` montre la phrase « Écoute coupée… ».
    static func turnOff(fromBanner: Bool) {
        let was = on
        on = false
        cut = was
        apply()
        NSLog("NokkerKnock: turned off (%@)", fromBanner ? "banner" : "settings")
        if fromBanner { showCutNote() }
    }

    /// Nœud oublié, mode maison quitté, appareil effacé : éteint, sans trace.
    static func forget() {
        on = false
        cut = false
        holds.removeAll()
        apply()
    }

    // MARK: - Écoute

    private static let q = DispatchQueue(label: "nokker.knock.dsp")
    private static var ctx: JSContext?
    private static var feed: JSValue?

    /// Le détecteur du noyau dans un JSContext (jamais la WebView). `nil` si les fichiers manquent.
    static func makeDetector(sampleRate: Double = 16000) -> (JSContext, JSValue)? {
        guard let dir = Bundle.main.resourceURL?.appendingPathComponent("public/knock"),
              let js = try? String(contentsOf: dir.appendingPathComponent("knock-worklet.js"), encoding: .utf8),
              let cnn = try? String(contentsOf: dir.appendingPathComponent("cnn.json"), encoding: .utf8),
              let tri = try? String(contentsOf: dir.appendingPathComponent("triple.json"), encoding: .utf8) else { return nil }
        let c: JSContext = JSContext()
        c.exceptionHandler = { _, e in NSLog("NokkerKnock: detector error %@", (e as JSValue?)?.toString() ?? "?") }
        c.evaluateScript(js)
        c.setObject(cnn, forKeyedSubscript: "__cnn" as NSString)
        c.setObject(tri, forKeyedSubscript: "__tri" as NSString)
        c.evaluateScript("""
        var __K = globalThis.NokkerKnockDSP;
        var __dsp = new __K.KnockDSP(\(sampleRate), {}, { cnn: __K.makeCNN(JSON.parse(__cnn).weights), scorer: __K.makeScorer(JSON.parse(__tri).weights) });
        __cnn = null; __tri = null;
        function __feed(a) {
          var ev = __dsp.process(a), out = [];
          for (var i = 0; i < ev.length; i++) if (ev[i].type === "knock") out.push({ t: ev[i].t, confidence: ev[i].confidence });
          return out;
        }
        """)
        // `as JSValue?` : compile que le SDK rende JSValue! ou JSValue.
        guard (c.exception as JSValue?) == nil, let f = c.objectForKeyedSubscript("__feed") as JSValue?, !f.isUndefined else { return nil }
        return (c, f)
    }

    /// Un bloc d'échantillons (16 kHz) → les déclenchements « trois coups » qu'il termine.
    static func run(_ feed: JSValue, _ samples: [Float]) -> [[String: Any]] {
        let r: JSValue? = feed.call(withArguments: [samples.map { Double($0) }])
        return (r?.toArray() as? [[String: Any]]) ?? []
    }

    private static func start() {
        guard engine == nil else { return }
        guard let det = makeDetector() else {
            lastError = "detector_missing"
            NSLog("NokkerKnock: detector files missing")
            return
        }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.mixWithOthers, .defaultToSpeaker])
            try session.setActive(true)
        } catch {
            lastError = "audio_unavailable"
            return
        }
        let e = AVAudioEngine()
        let input = e.inputNode
        let inFmt = input.outputFormat(forBus: 0)
        guard inFmt.sampleRate > 0, let outFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false),
              let conv = AVAudioConverter(from: inFmt, to: outFmt) else {
            lastError = "audio_unavailable"
            return
        }
        input.installTap(onBus: 0, bufferSize: 4096, format: inFmt) { buf, _ in
            let cap = AVAudioFrameCount(Double(buf.frameLength) * 16000 / inFmt.sampleRate) + 32
            guard let out = AVAudioPCMBuffer(pcmFormat: outFmt, frameCapacity: cap) else { return }
            var given = false
            var err: NSError?
            _ = conv.convert(to: out, error: &err) { _, status in
                if given { status.pointee = .noDataNow; return nil }
                given = true
                status.pointee = .haveData
                return buf
            }
            guard err == nil, let ch = out.floatChannelData else { return }
            let samples = Array(UnsafeBufferPointer(start: ch[0], count: Int(out.frameLength)))
            q.async {
                guard let feed = NokkerKnock.feed else { return }
                if let ev = run(feed, samples).first { DispatchQueue.main.async { triggered(ev) } }
            }
        }
        do { try e.start() } catch {
            input.removeTap(onBus: 0)
            lastError = "audio_unavailable"
            return
        }
        q.sync { ctx = det.0; feed = det.1 }
        engine = e
        lastError = nil
        showBanner(true)
        NSLog("NokkerKnock: listening")
    }

    static func stop() {
        guard let e = engine else { return showBanner(false) }
        engine = nil
        e.stop()
        e.inputNode.removeTap(onBus: 0)
        q.async { feed = nil; ctx = nil } // l'état du détecteur (trames) part avec lui
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        showBanner(false)
        NSLog("NokkerKnock: stopped")
    }

    private static var yes: AVAudioPlayer?

    /// Trois coups : l'écoute rend le micro, « oui ? » est joué ici, puis le web est prévenu. Si personne ne prend le
    /// micro dans les 5 s (aucune dictée lancée), l'écoute reprend d'elle-même.
    private static func triggered(_ ev: [String: Any]) {
        guard engine != nil else { return }
        NSLog("NokkerKnock: three knocks")
        holds.insert("yes")
        apply()
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try? s.setActive(true)
        let url = Bundle.main.resourceURL?.appendingPathComponent("public/sounds/nokker-yes.wav")
        yes = url.flatMap { try? AVAudioPlayer(contentsOf: $0) }
        yes?.play()
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0.3, yes?.duration ?? 0.5) + 0.05) {
            yes = nil
            try? s.setActive(false, options: .notifyOthersOnDeactivation)
            holds.remove("yes")
            holds.insert("call")
            onKnock?(ev)
            apply()
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                holds.remove("call")
                apply()
            }
        }
    }

    // MARK: - Bandeau

    private static var fr: Bool { Locale.preferredLanguages.first?.hasPrefix("fr") ?? false }

    /// Bandeau permanent (bas de l'écran) tant que l'écoute tourne, avec « Couper » sans authentification.
    private static func showBanner(_ show: Bool) {
        DispatchQueue.main.async {
            if !show { banner?.removeFromSuperview(); banner = nil; return }
            guard banner == nil, let w = keyWindow() else { return }
            let v = UIStackView()
            v.axis = .horizontal
            v.spacing = 10
            v.alignment = .center
            v.isLayoutMarginsRelativeArrangement = true
            v.layoutMargins = UIEdgeInsets(top: 6, left: 12, bottom: 6, right: 8)
            v.backgroundColor = UIColor(red: 0.12, green: 0.12, blue: 0.14, alpha: 0.92)
            v.layer.cornerRadius = 12
            let l = UILabel()
            l.text = fr ? "● À l'écoute de trois coups frappés. Rien n'est enregistré." : "● Listening for three knocks. Nothing is recorded."
            l.font = .systemFont(ofSize: 13, weight: .semibold)
            l.textColor = .white
            l.numberOfLines = 0
            let b = UIButton(type: .system)
            b.setTitle(fr ? "Couper" : "Mute", for: .normal)
            b.titleLabel?.font = .systemFont(ofSize: 14, weight: .bold)
            b.setTitleColor(.white, for: .normal)
            b.backgroundColor = UIColor(red: 0.75, green: 0.1, blue: 0.1, alpha: 1)
            b.layer.cornerRadius = 8
            b.contentEdgeInsets = UIEdgeInsets(top: 6, left: 12, bottom: 6, right: 12)
            b.accessibilityIdentifier = "nokker-knock-cut"
            b.addAction(UIAction { _ in turnOff(fromBanner: true) }, for: .touchUpInside)
            v.addArrangedSubview(l)
            v.addArrangedSubview(b)
            v.translatesAutoresizingMaskIntoConstraints = false
            w.addSubview(v)
            NSLayoutConstraint.activate([
                v.bottomAnchor.constraint(equalTo: w.safeAreaLayoutGuide.bottomAnchor, constant: -8),
                v.centerXAnchor.constraint(equalTo: w.centerXAnchor),
                v.leadingAnchor.constraint(greaterThanOrEqualTo: w.safeAreaLayoutGuide.leadingAnchor, constant: 8),
                b.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            ])
            banner = v
        }
    }

    /// Après « Couper » : la phrase reste 8 s.
    private static func showCutNote() {
        DispatchQueue.main.async {
            guard let w = keyWindow() else { return }
            let l = UILabel()
            l.text = fr ? "  Écoute coupée. Le propriétaire peut la rallumer dans les réglages du nœud maison.  " : "  Listening off. The owner can turn it back on in the home node settings.  "
            l.font = .systemFont(ofSize: 13, weight: .semibold)
            l.textColor = .white
            l.numberOfLines = 0
            l.textAlignment = .center
            l.backgroundColor = UIColor(red: 0.12, green: 0.12, blue: 0.14, alpha: 0.92)
            l.layer.cornerRadius = 12
            l.clipsToBounds = true
            l.translatesAutoresizingMaskIntoConstraints = false
            w.addSubview(l)
            NSLayoutConstraint.activate([
                l.bottomAnchor.constraint(equalTo: w.safeAreaLayoutGuide.bottomAnchor, constant: -8),
                l.centerXAnchor.constraint(equalTo: w.centerXAnchor),
                l.leadingAnchor.constraint(greaterThanOrEqualTo: w.safeAreaLayoutGuide.leadingAnchor, constant: 8),
                l.heightAnchor.constraint(greaterThanOrEqualToConstant: 36),
            ])
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) { l.removeFromSuperview() }
        }
    }

    private static func keyWindow() -> UIWindow? {
        UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.windows.first(where: \.isKeyWindow) }.first
    }

    // MARK: - Autotest du CI (debug seulement)

    #if DEBUG
    /// Salve synthétique (modes amortis et clic, graine fixe, vérifiée aussi contre le module JS sous Node) : trois coups à 0,3 s → UN
    /// déclenchement ; quatre coups au même tempo (une série) → AUCUN ; un seul coup → aucun. Passe par le vrai
    /// détecteur (JSContext, fichiers du paquet). Puis la règle d'allumage : rien sans mode maison.
    static func synth(count: Int, ioi: Double, sr: Double = 16000) -> [Float] {
        var s: UInt32 = 12345
        func rnd() -> Double { s = s &* 1664525 &+ 1013904223; return Double(s) / 4294967296 * 2 - 1 }
        let n = Int((sr * (0.6 + ioi * Double(count - 1) + 1.0)).rounded())
        var x = [Double](repeating: 0, count: n)
        for i in 0..<n { x[i] = 0.002 * rnd() }
        let modes: [(Double, Double, Double)] = [(320, 0.02, 1.0), (1050, 0.012, 0.6), (2900, 0.008, 0.35)]
        for c in 0..<count {
            let t0 = Int((sr * (0.6 + Double(c) * ioi)).rounded()), len = Int((sr * 0.3).rounded())
            var i = 0
            while i < len && t0 + i < n {
                let t = Double(i) / sr
                var y = 0.0
                for (f, d, g) in modes { y += g * sin(2 * Double.pi * f * t) * exp(-t / d) }
                if i < 32 { y += 0.5 * rnd() * exp(-Double(i) / 10) }
                x[t0 + i] += 0.4 * y * min(1, t / 0.0005)
                i += 1
            }
        }
        return x.map { Float($0) }
    }

    /// Hors du fil principal : le détecteur JS sur ~7 s de son ne bloque ni le lancement ni les autres autotests.
    static func selfTest() {
        let rule = NokkerHome.on || !shouldRun()
        DispatchQueue.global(qos: .userInitiated).async { selfTestDSP(rule: rule) }
    }

    private static func selfTestDSP(rule: Bool) {
        func knocks(in x: [Float]) -> Int? {
            guard let f = makeDetector()?.1 else { return nil }
            var n = 0, i = 0
            while i < x.count { n += run(f, Array(x[i..<min(x.count, i + 1600)])).count; i += 1600 }
            return n
        }
        let t0 = Date()
        let triple = knocks(in: synth(count: 3, ioi: 0.3)), series = knocks(in: synth(count: 4, ioi: 0.3)), single = knocks(in: synth(count: 1, ioi: 0.3))
        let ms = Int(Date().timeIntervalSince(t0) * 1000)
        let ok = triple == 1 && series == 0 && single == 0 && rule
        let fmt: (Int?) -> String = { v in v.map { String($0) } ?? "nil" }
        let (t3, t4, t1) = (fmt(triple), fmt(series), fmt(single))
        NSLog("NokkerKnock: self-test \(ok ? "ok" : "FAILED") (triple \(t3), series \(t4), single \(t1), rule \(rule), \(ms) ms)")
    }
    #endif
}
