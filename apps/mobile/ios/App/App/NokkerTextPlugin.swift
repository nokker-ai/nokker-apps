import AVFoundation
import Capacitor
import Speech
import UIKit
import Vision

/// `Capacitor.Plugins.NokkerText` — texte reconnu SUR L'APPAREIL (LOKKAL-PHONE §4.3.1, lot P9) :
/// - `ocrImage` : Vision (texte d'une photo) ;
/// - `dictationStart` / `dictationStop` : note dictée au micro du composeur (message de la personne) ;
/// - `transcribeAudio` : fichier audio joint (réunion, message reçu) → transcription (contenu de tiers).
/// La reconnaissance vocale est TOUJOURS sur l'appareil (`requiresOnDeviceRecognition`) : si iOS ne la propose pas pour
/// la langue, on refuse (`unavailable_on_device`), jamais de repli en ligne. Rien n'est envoyé d'ici.
@objc(NokkerTextPlugin)
public class NokkerTextPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NokkerTextPlugin"
    public let jsName = "NokkerText"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "ocrImage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speechStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestSpeech", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dictationStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dictationStop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "transcribeAudio", returnType: CAPPluginReturnPromise)
    ]

    static let maxChars = 20_000
    static let maxDictation: TimeInterval = 120

    // MARK: - OCR

    static func recognize(_ cg: CGImage, _ done: @escaping (String) -> Void) {
        let req = VNRecognizeTextRequest { r, _ in
            let lines = (r.results as? [VNRecognizedTextObservation] ?? []).compactMap { $0.topCandidates(1).first?.string }
            done(String(lines.joined(separator: "\n").prefix(maxChars)))
        }
        req.recognitionLevel = .accurate
        req.usesLanguageCorrection = true
        req.recognitionLanguages = ["fr-FR", "en-US", "de-DE", "it-IT"]
        DispatchQueue.global(qos: .userInitiated).async {
            do { try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req]) } catch { done("") }
        }
    }

    @objc func ocrImage(_ call: CAPPluginCall) {
        guard let url = call.getString("data_url"), let comma = url.firstIndex(of: ","),
              let data = Data(base64Encoded: String(url[url.index(after: comma)...])), let img = UIImage(data: data), let cg = img.cgImage else {
            return call.reject("bad_image")
        }
        Self.recognize(cg) { text in call.resolve(["text": text]) }
    }

    // MARK: - Parole (toujours sur l'appareil)

    private func recognizer(_ lang: String?) -> SFSpeechRecognizer? {
        SFSpeechRecognizer(locale: Locale(identifier: lang ?? Locale.preferredLanguages.first ?? "fr-FR"))
    }

    private static func authName(_ s: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch s {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not_determined"
        @unknown default: return "unknown"
        }
    }

    /// Parole utilisable par le nœud : autorisée ET reconnaissable sur l'appareil.
    static func speechReady() -> Bool {
        SFSpeechRecognizer.authorizationStatus() == .authorized && (SFSpeechRecognizer(locale: Locale(identifier: Locale.preferredLanguages.first ?? "fr-FR"))?.supportsOnDeviceRecognition ?? false)
    }

    @objc func speechStatus(_ call: CAPPluginCall) {
        let r = recognizer(call.getString("lang"))
        call.resolve([
            "speech": Self.authName(SFSpeechRecognizer.authorizationStatus()),
            "microphone": AVAudioSession.sharedInstance().recordPermission == .granted ? "granted" : AVAudioSession.sharedInstance().recordPermission == .denied ? "denied" : "not_determined",
            "on_device": r?.supportsOnDeviceRecognition ?? false
        ])
    }

    @objc func requestSpeech(_ call: CAPPluginCall) {
        SFSpeechRecognizer.requestAuthorization { _ in
            AVAudioSession.sharedInstance().requestRecordPermission { _ in
                DispatchQueue.main.async { self.speechStatus(call) }
            }
        }
    }

    private var engine: AVAudioEngine?
    private var live: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var liveText = ""
    private var liveStart = Date()
    private var stopCall: CAPPluginCall?
    /// Dictée arrêtée par l'app (durée maximale, passage en arrière-plan) : son texte attend le `dictationStop` du web.
    private var pendingResult: [String: Any]?

    /// Micro réellement libéré : moteur arrêté, prise retirée, session audio désactivée (décision dev 06.11 : la dictée
    /// s'arrête d'elle-même à la fin ou en arrière-plan ; aucune écoute ne survit à son geste).
    private func releaseAudio() {
        engine?.stop()
        engine?.inputNode.removeTap(onBus: 0)
        live?.endAudio()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        NokkerKnock.hold("dictation", false) // « Frapper pour appeler » reprend s'il est allumé
    }

    /// Arrêt sans geste (durée maximale, arrière-plan) : micro libéré tout de suite, texte gardé, le web prévenu
    /// (`dictationEnded`) pour sortir de l'état « enregistrement ».
    private func autoStop(_ reason: String) {
        guard live != nil, stopCall == nil else { return }
        releaseAudio()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self, self.live != nil, self.stopCall == nil else { return }
            self.task?.cancel()
            self.task = nil
            self.live = nil
            self.engine = nil
            let r: [String: Any] = ["text": String(self.liveText.prefix(Self.maxChars)), "duration_s": Int(Date().timeIntervalSince(self.liveStart).rounded())]
            self.pendingResult = r
            NSLog("NokkerText: dictation stopped (\(reason))")
            self.notifyListeners("dictationEnded", data: r.merging(["reason": reason]) { a, _ in a })
        }
    }

    @objc func dictationStart(_ call: CAPPluginCall) {
        guard SFSpeechRecognizer.authorizationStatus() == .authorized else { return call.reject("denied") }
        guard let r = recognizer(call.getString("lang")), r.supportsOnDeviceRecognition else { return call.reject("unavailable_on_device") }
        // `max_s` (5…120) et `end_on_silence` : la dictée lancée par trois coups s'arrête au premier silence.
        let maxS = min(Self.maxDictation, max(5, call.getDouble("max_s") ?? Self.maxDictation))
        let endOnSilence = call.getBool("end_on_silence") ?? false
        NokkerKnock.hold("dictation", true) // l'écoute des coups rend le micro avant la dictée
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch { NokkerKnock.hold("dictation", false); return call.reject("audio_unavailable") }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.requiresOnDeviceRecognition = true
        req.shouldReportPartialResults = true
        let e = AVAudioEngine()
        let input = e.inputNode
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buf, _ in req.append(buf) }
        liveText = ""
        liveStart = Date()
        task = r.recognitionTask(with: req) { result, error in
            if let result, result.bestTranscription.formattedString != self.liveText {
                self.liveText = result.bestTranscription.formattedString
                self.lastChange = Date()
            }
            if error != nil || (result?.isFinal ?? false) { self.finishDictation() }
        }
        do { try e.start() } catch { input.removeTap(onBus: 0); NokkerKnock.hold("dictation", false); return call.reject("audio_unavailable") }
        engine = e
        live = req
        lastChange = Date()
        call.resolve(["started": true, "max_s": maxS])
        pendingResult = nil
        let started = liveStart
        DispatchQueue.main.asyncAfter(deadline: .now() + maxS) { [weak self] in if self?.liveStart == started { self?.autoStop("max") } }
        if endOnSilence { watchSilence(started) }
    }

    private var lastChange = Date()

    /// Arrêt au silence : 1,5 s sans changement du texte reconnu, ou 6 s sans un mot.
    private func watchSilence(_ started: Date) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self, self.live != nil, self.stopCall == nil, self.liveStart == started else { return }
            let quiet = Date().timeIntervalSince(self.lastChange)
            if (!self.liveText.isEmpty && quiet >= 1.5) || (self.liveText.isEmpty && quiet >= 6) { return self.autoStop("silence") }
            self.watchSilence(started)
        }
    }

    @objc func dictationStop(_ call: CAPPluginCall) {
        if live == nil, let r = pendingResult {
            pendingResult = nil
            return call.resolve(r)
        }
        guard live != nil else { return call.reject("not_recording") }
        stopCall = call
        engine?.stop()
        engine?.inputNode.removeTap(onBus: 0)
        live?.endAudio()
        // Le résultat final arrive par le rappel de la tâche ; au plus tard 4 s après l'arrêt.
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in self?.finishDictation() }
    }

    private func finishDictation() {
        DispatchQueue.main.async {
            guard let call = self.stopCall else { return }
            self.stopCall = nil
            self.task?.cancel()
            self.task = nil
            self.live = nil
            self.engine = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            NokkerKnock.hold("dictation", false)
            call.resolve(["text": String(self.liveText.prefix(Self.maxChars)), "duration_s": Int(Date().timeIntervalSince(self.liveStart).rounded())])
        }
    }

    /// Audio → texte, TOUJOURS sur l'appareil (`requiresOnDeviceRecognition`) ; jamais de reconnaissance en ligne.
    /// `done(texte, durée)` ou `done(nil, code)` ; codes : denied, unavailable_on_device, bad_audio, transcription_failed.
    static func transcribe(_ data: Data, ext: String, lang: String?, _ done: @escaping (String?, Any) -> Void) {
        guard SFSpeechRecognizer.authorizationStatus() == .authorized else { return done(nil, "denied") }
        guard let r = SFSpeechRecognizer(locale: Locale(identifier: lang ?? Locale.preferredLanguages.first ?? "fr-FR")), r.supportsOnDeviceRecognition else {
            return done(nil, "unavailable_on_device")
        }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("nokker-\(UUID().uuidString).\(ext.isEmpty ? "m4a" : ext)")
        do { try data.write(to: file) } catch { return done(nil, "bad_audio") }
        let req = SFSpeechURLRecognitionRequest(url: file)
        req.requiresOnDeviceRecognition = true
        var answered = false
        r.recognitionTask(with: req) { result, error in
            guard !answered else { return }
            if let result, result.isFinal {
                answered = true
                try? FileManager.default.removeItem(at: file)
                let secs = (try? AVAudioPlayer(data: data).duration) ?? 0
                done(String(result.bestTranscription.formattedString.prefix(maxChars)), Int(secs.rounded()))
            } else if error != nil {
                answered = true
                try? FileManager.default.removeItem(at: file)
                done(nil, "transcription_failed")
            }
        }
    }

    /// Fichier audio joint (`data_url`) → transcription sur l'appareil.
    @objc func transcribeAudio(_ call: CAPPluginCall) {
        guard let url = call.getString("data_url"), let comma = url.firstIndex(of: ","), let data = Data(base64Encoded: String(url[url.index(after: comma)...])) else {
            return call.reject("bad_audio")
        }
        let ext = (call.getString("name") as NSString?)?.pathExtension.lowercased() ?? "m4a"
        Self.transcribe(data, ext: ext, lang: call.getString("lang")) { text, extra in
            if let text { call.resolve(["text": text, "duration_s": extra]) } else { call.reject(extra as? String ?? "transcription_failed") }
        }
    }

    // MARK: - Autotest du CI (debug seulement)

    override public func load() {
        // La dictée ne survit pas au passage en arrière-plan : micro libéré, texte gardé pour le web.
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in self?.autoStop("background") }
        let r = recognizer(nil)
        NSLog("NokkerText: loaded, speech \(Self.authName(SFSpeechRecognizer.authorizationStatus())), on-device \(r?.supportsOnDeviceRecognition ?? false)")
        #if DEBUG
        let flag = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("nokker-ci-text")
        guard FileManager.default.fileExists(atPath: flag.path) else { return }
        try? FileManager.default.removeItem(at: flag)
        let size = CGSize(width: 900, height: 240)
        let img = UIGraphicsImageRenderer(size: size).image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            ("NOKKER 2026" as NSString).draw(at: CGPoint(x: 40, y: 70), withAttributes: [.font: UIFont.boldSystemFont(ofSize: 96), .foregroundColor: UIColor.black])
        }
        if let cg = img.cgImage {
            Self.recognize(cg) { text in NSLog("NokkerText: self-test ocr \(text.replacingOccurrences(of: "\n", with: " "))") }
        }
        #endif
    }
}
