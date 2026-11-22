import Capacitor
import Foundation

/// `Capacitor.Plugins.NokkerShare` : ce que l'extension « Partager vers Nokker » a déposé dans la boîte de l'App Group.
/// `pending()` → {shares: [{id, created_at, items: [{kind, text?, url?, name?, data_url?}]}]} (images en data URL
/// JPEG) ; `clear({id})` efface un partage une fois repris par l'interface. Rien ne sort de l'appareil ici.
@objc(NokkerSharePlugin)
public class NokkerSharePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NokkerSharePlugin"
    public let jsName = "NokkerShare"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pending", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise)
    ]

    override public func load() {
        // Preuve côté natif, sans le JS : le plugin est chargé et voit la boîte de l'App Group.
        if let inbox = NokkerShared.inbox() {
            let n = ((try? FileManager.default.contentsOfDirectory(atPath: inbox.path)) ?? []).count
            NSLog("NokkerShare: loaded, \(n) waiting in the App Group")
        } else {
            NSLog("NokkerShare: loaded, App Group container unavailable")
        }
    }

    @objc func pending(_ call: CAPPluginCall) {
        guard let inbox = NokkerShared.inbox() else {
            NSLog("NokkerShare: App Group container unavailable")
            call.resolve(["shares": [], "available": false])
            return
        }
        let dirs = (try? FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil)) ?? []
        var out: [[String: Any]] = []
        for dir in dirs {
            let manifestURL = dir.appendingPathComponent("manifest.json")
            guard let data = try? Data(contentsOf: manifestURL),
                  let manifest = try? JSONDecoder().decode(NokkerShared.Manifest.self, from: data) else { continue }
            var items: [[String: Any]] = []
            for item in manifest.items {
                var entry: [String: Any] = ["kind": item.kind]
                if let text = item.text { entry["text"] = text }
                if let url = item.url { entry["url"] = url }
                if let name = item.name { entry["name"] = name }
                if let file = item.file, let bytes = try? Data(contentsOf: dir.appendingPathComponent(file)) {
                    entry["data_url"] = "data:image/jpeg;base64," + bytes.base64EncodedString()
                }
                items.append(entry)
            }
            out.append(["id": manifest.id, "created_at": manifest.created_at, "items": items])
        }
        out.sort { ($0["created_at"] as? String ?? "") < ($1["created_at"] as? String ?? "") }
        NSLog("NokkerShare: \(out.count) pending")
        call.resolve(["shares": out, "available": true])
    }

    @objc func clear(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.contains("/"), !id.contains(".."), let inbox = NokkerShared.inbox() else {
            call.reject("bad_id")
            return
        }
        try? FileManager.default.removeItem(at: inbox.appendingPathComponent(id, isDirectory: true))
        call.resolve()
    }
}
