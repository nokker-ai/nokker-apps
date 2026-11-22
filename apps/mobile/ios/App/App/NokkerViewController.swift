import Capacitor
import UIKit
import WebKit

/// Contrôleur de la coque : celui de Capacitor, plus les plugins maison de l'app (ils vivent dans la cible App, pas dans
/// un paquet npm). Référencé par Main.storyboard.
class NokkerViewController: CAPBridgeViewController {
    /// Gardé ici : `uiDelegate` d'une WKWebView est une référence faible.
    private var mediaGuard: NokkerMediaGuard?

    override open func capacitorDidLoad() {
        // NSLog (pas print) : seul NSLog atteint le journal unifié que lit le CI.
        NSLog("NokkerShare: registering plugin (bridge %@)", bridge == nil ? "absent" : "present")
        bridge?.registerPluginInstance(NokkerSharePlugin())
        bridge?.registerPluginInstance(NokkerZonesPlugin())
        let pim = NokkerPimPlugin()
        bridge?.registerPluginInstance(pim)
        bridge?.registerPluginInstance(NokkerTextPlugin())
        let node = NokkerNodePlugin()
        node.pim = pim
        bridge?.registerPluginInstance(node)
        bridge?.registerPluginInstance(NokkerVaultPlugin())
        installMediaGuard()
    }

    override open func viewDidLoad() {
        super.viewDidLoad()
        installMediaGuard()
    }

    /// Mandataire du `uiDelegate` de Capacitor (une seule fois) : seule la décision de capture micro/caméra change.
    private func installMediaGuard() {
        guard mediaGuard == nil, let wv = webView else { return }
        let g = NokkerMediaGuard(inner: wv.uiDelegate)
        mediaGuard = g
        wv.uiDelegate = g
        NSLog("NokkerMediaGuard: installed %@", wv.uiDelegate === g ? "yes" : "no")
        #if DEBUG
        NokkerMediaGuard.selfTest(installed: wv.uiDelegate === g)
        #endif
    }
}

/// Deuxième couche de « aucune écoute permanente » en mode nœud maison ou écran mural (décision dev 06.11) : Capacitor
/// accorde par défaut toute capture micro et caméra demandée par la page (`getUserMedia`) ; ici elle est REFUSÉE dans
/// ces modes, quoi que fasse la page. Tout le reste est transmis tel quel au délégué de Capacitor. La caméra de veille
/// (AVCaptureSession) et la dictée (AVAudioEngine) sont natives : elles ne passent pas par ce délégué.
final class NokkerMediaGuard: NSObject, WKUIDelegate {
    private weak var inner: WKUIDelegate?

    init(inner: WKUIDelegate?) {
        self.inner = inner
    }

    /// Règle : la page n'obtient ni micro ni caméra en mode maison ou mur ; sinon, la décision de Capacitor.
    static func pageMayCapture(home: Bool, wall: Bool) -> Bool { !(home || wall) }

    static var homeOrWall: (home: Bool, wall: Bool) { (NokkerHome.on, NokkerWall.on || NokkerWall.active) }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || (inner?.responds(to: aSelector) ?? false)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        (inner?.responds(to: aSelector) ?? false) ? inner : nil
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let m = Self.homeOrWall
        guard Self.pageMayCapture(home: m.home, wall: m.wall) else {
            NSLog("NokkerMediaGuard: page capture denied (home %@, wall %@)", m.home ? "on" : "off", m.wall ? "on" : "off")
            return decisionHandler(.deny)
        }
        if let i = inner, i.responds(to: #selector(WKUIDelegate.webView(_:requestMediaCapturePermissionFor:initiatedByFrame:type:decisionHandler:))) {
            i.webView?(webView, requestMediaCapturePermissionFor: origin, initiatedByFrame: frame, type: type, decisionHandler: decisionHandler)
        } else {
            decisionHandler(.prompt)
        }
    }

    #if DEBUG
    /// La règle (refus en mode maison ou mur), le mandataire réellement posé sur la WebView, et SA méthode de décision
    /// vue par WebKit (`own`) : si la signature ne correspondait plus à l'exigence du protocole, WebKit ne l'appellerait
    /// jamais et la garde serait muette ; `instancesRespond` ne regarde que cette classe, pas le délégué transmis.
    static func selfTest(installed: Bool) {
        let rule = !pageMayCapture(home: true, wall: false) && !pageMayCapture(home: false, wall: true) && !pageMayCapture(home: true, wall: true) && pageMayCapture(home: false, wall: false)
        let own = NokkerMediaGuard.instancesRespond(to: #selector(WKUIDelegate.webView(_:requestMediaCapturePermissionFor:initiatedByFrame:type:decisionHandler:)))
        NSLog("NokkerMediaGuard: self-test \(rule && installed && own ? "ok" : "FAILED") (rule \(rule), installed \(installed), own \(own))")
    }
    #endif
}
