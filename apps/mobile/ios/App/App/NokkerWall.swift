import Foundation
import LocalAuthentication
import UIKit

/// Écran mural du nœud maison (LOKKAL-PHONE §4.4, lot P10b, phase S) : la vue glance `/glance?wall=1` en plein écran.
///
/// - Jeton `nkg_` du mur (portée glance, lecture seule, révocable) : gardé dans le trousseau (ThisDeviceOnly) avec l'id
///   de l'appareil glance ; remis EN MÉMOIRE à la page murale (jamais localStorage, cookie, IndexedDB, URL ni journal).
///   Le jeton de machine du nœud, lui, reste scellé et ne passe jamais par la WebView.
/// - Écran toujours allumé tant que le mur est affiché au premier plan.
/// - Sortie protégée (décision dev 06.11) : `authenticateExit` exige le propriétaire de l'appareil (biométrie ou code,
///   `.deviceOwnerAuthentication`) ; sans code sur l'appareil, le mur est refusé (`hasPasscode` faux). La mise en place
///   du mur ferme d'office la session complète de l'appareil (côté interface) : après la sortie, l'écran de connexion.
/// - Luminosité réduite la nuit (22:00–07:00, heure de l'appareil) à 0,15 ; la valeur d'avant est rendue le matin et à
///   la sortie du mur.
enum NokkerWall {
    static let tokenAccount = "wall-token"
    static let deviceAccount = "wall-device"
    static let nightFrom = 22
    static let nightTo = 7
    static let nightBrightness: CGFloat = 0.15

    private(set) static var on = false
    private static let activeKey = "nokker.wall.active"
    /// Le mur était affiché à la dernière sortie : l'app y revient au lancement (tablette sans session).
    static var active: Bool {
        get { UserDefaults.standard.bool(forKey: activeKey) }
        set { UserDefaults.standard.set(newValue, forKey: activeKey) }
    }
    private static var savedBrightness: CGFloat?
    private static var timer: Timer?

    static var token: String? { NokkerNodePlugin.kcGet(tokenAccount).flatMap { String(data: $0, encoding: .utf8) } }
    static var deviceId: String? { NokkerNodePlugin.kcGet(deviceAccount).flatMap { String(data: $0, encoding: .utf8) } }

    static func store(token: String, deviceId: String) -> Bool {
        NokkerNodePlugin.kcSet(tokenAccount, Data(token.utf8)) && NokkerNodePlugin.kcSet(deviceAccount, Data(deviceId.utf8))
    }

    static func forget() {
        active = false
        NokkerNodePlugin.kcDelete(tokenAccount)
        NokkerNodePlugin.kcDelete(deviceAccount)
    }

    /// Un code (ou une biométrie, qui l'exige) protège l'appareil : sans lui, la sortie du mur ne protège rien.
    static func hasPasscode() -> Bool {
        LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    }

    /// Demande au propriétaire de l'appareil de confirmer la sortie du mur ; rappel sur le fil principal.
    static func authenticateExit(reason: String, _ done: @escaping (Bool) -> Void) {
        let ctx = LAContext()
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else { return DispatchQueue.main.async { done(false) } }
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in
            DispatchQueue.main.async { done(ok) }
        }
    }

    /// Nuit : de `nightFrom` h (incluse) à `nightTo` h (exclue), heure locale de l'appareil.
    static func isNight(hour: Int) -> Bool { hour >= nightFrom || hour < nightTo }

    static func isNight(_ date: Date = Date(), calendar: Calendar = .current) -> Bool { isNight(hour: calendar.component(.hour, from: date)) }

    /// Allume ou éteint le mode mural (fil principal) : écran allumé, luminosité de nuit relue chaque minute.
    static func set(_ value: Bool, foreground: Bool) {
        on = value
        timer?.invalidate()
        timer = nil
        if value {
            apply()
            timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in apply() }
        } else if let b = savedBrightness {
            UIScreen.main.brightness = b
            savedBrightness = nil
        }
        UIApplication.shared.isIdleTimerDisabled = (value || NokkerHome.on) && foreground
    }

    private static func apply() {
        if isNight() {
            if savedBrightness == nil { savedBrightness = UIScreen.main.brightness }
            UIScreen.main.brightness = nightBrightness
        } else if let b = savedBrightness {
            UIScreen.main.brightness = b
            savedBrightness = nil
        }
    }

    #if DEBUG
    /// Règle de nuit aux bornes (heures simulées), sans toucher à l'écran.
    static func selfTest() {
        let night = [22, 23, 0, 3, 6].allSatisfy { isNight(hour: $0) }
        let day = [7, 8, 12, 18, 21].allSatisfy { !isNight(hour: $0) }
        NSLog("NokkerWall: self-test night \(night && day ? "ok" : "FAILED") passcode \(hasPasscode())")
    }
    #endif
}
