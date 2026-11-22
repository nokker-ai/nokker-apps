import Capacitor
import CoreLocation
import UIKit

/// `Capacitor.Plugins.NokkerZones` — zones de géorepérage du membre (LOKKAL-PHONE §4.2, lot P6).
/// Les zones (centre, rayon ≥ 150 m, 18 au plus) vivent SUR l'appareil ; seuls leur id, leur nom et les transitions
/// « entrée / sortie » sortent, jamais une position. Les transitions sont mises en file (fichier de l'app) : l'interface
/// les envoie au noyau quand elle tourne (`events`, puis `clearEvents`), et reçoit `zoneEvent` en direct.
@objc(NokkerZonesPlugin)
public class NokkerZonesPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "NokkerZonesPlugin"
    public let jsName = "NokkerZones"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestWhenInUse", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAlways", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setZones", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pick", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "events", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearEvents", returnType: CAPPluginReturnPromise)
    ]

    static let minRadius: Double = 150
    static let maxZones = 18

    struct Zone: Codable {
        var id: String
        var name: String
        var lat: Double
        var lon: Double
        var radius: Double
    }

    struct Event: Codable {
        /// UUID de l'appareil : le noyau ignore un doublon (la file peut renvoyer après une coupure).
        var event_id: String
        var zone_id: String
        var event: String
        var at: String
    }

    private var manager: CLLocationManager?
    private var authCalls: [CAPPluginCall] = []

    private static func file(_ name: String) -> URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent(name)
    }
    static var zonesURL: URL { file("nokker-zones.json") }
    static var eventsURL: URL { file("nokker-zone-events.json") }
    /// Dernier état connu par zone (`inside`, `since`) : lu par l'opération `zone.state` du nœud téléphone (P7).
    static var stateURL: URL { file("nokker-zone-state.json") }

    struct ZoneState: Codable {
        var inside: Bool
        var since: String
    }
    static func readStates() -> [String: ZoneState] {
        (try? JSONDecoder().decode([String: ZoneState].self, from: Data(contentsOf: stateURL))) ?? [:]
    }
    static func writeState(_ id: String, inside: Bool) {
        var all = readStates()
        if all[id]?.inside == inside { return }
        all[id] = ZoneState(inside: inside, since: ISO8601DateFormatter().string(from: Date()))
        try? JSONEncoder().encode(all).write(to: stateURL, options: .atomic)
    }

    static func readZones() -> [Zone] {
        (try? JSONDecoder().decode([Zone].self, from: Data(contentsOf: zonesURL))) ?? []
    }
    static func readEvents() -> [Event] {
        (try? JSONDecoder().decode([Event].self, from: Data(contentsOf: eventsURL))) ?? []
    }

    override public func load() {
        DispatchQueue.main.async {
            let m = CLLocationManager()
            m.delegate = self
            self.manager = m
            let zones = Self.readZones()
            self.monitor(zones)
            NSLog("NokkerZones: loaded, \(zones.count) zones, auth \(Self.authName(m.authorizationStatus))")
        }
    }

    // MARK: - Autorisation

    static func authName(_ s: CLAuthorizationStatus) -> String {
        switch s {
        case .notDetermined: return "not_determined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .authorizedAlways: return "always"
        case .authorizedWhenInUse: return "when_in_use"
        @unknown default: return "unknown"
        }
    }

    private func statusPayload() -> [String: Any] {
        guard let m = manager else { return ["status": "unknown"] }
        return [
            "status": Self.authName(m.authorizationStatus),
            "precise": m.accuracyAuthorization == .fullAccuracy,
            "monitoring": CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self)
        ]
    }

    @objc func status(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(self.statusPayload()) }
    }

    @objc func requestWhenInUse(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let m = self.manager else { return call.reject("not_ready") }
            if m.authorizationStatus != .notDetermined { return call.resolve(self.statusPayload()) }
            self.authCalls.append(call)
            m.requestWhenInUseAuthorization()
        }
    }

    @objc func requestAlways(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let m = self.manager else { return call.reject("not_ready") }
            if m.authorizationStatus == .authorizedAlways || m.authorizationStatus == .denied || m.authorizationStatus == .restricted {
                return call.resolve(self.statusPayload())
            }
            self.authCalls.append(call)
            m.requestAlwaysAuthorization()
            // iOS peut ne rien répondre (demande déjà faite) : on rend l'état tel quel au bout de 8 s.
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) { self.flushAuthCalls() }
        }
    }

    private func flushAuthCalls() {
        let calls = authCalls
        authCalls = []
        for c in calls { c.resolve(statusPayload()) }
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        NSLog("NokkerZones: auth \(Self.authName(manager.authorizationStatus))")
        if manager.authorizationStatus != .notDetermined { flushAuthCalls() }
        monitor(Self.readZones())
    }

    // MARK: - Zones

    private func monitor(_ zones: [Zone]) {
        guard let m = manager else { return }
        let ids = Set(zones.map(\.id))
        for r in m.monitoredRegions where !ids.contains(r.identifier) { m.stopMonitoring(for: r) }
        guard m.authorizationStatus == .authorizedAlways || m.authorizationStatus == .authorizedWhenInUse else { return }
        for z in zones {
            let region = CLCircularRegion(center: CLLocationCoordinate2D(latitude: z.lat, longitude: z.lon),
                                          radius: min(max(z.radius, Self.minRadius), m.maximumRegionMonitoringDistance),
                                          identifier: z.id)
            region.notifyOnEntry = true
            region.notifyOnExit = true
            m.startMonitoring(for: region)
            m.requestState(for: region)
        }
    }

    @objc func list(_ call: CAPPluginCall) {
        let zones = Self.readZones().map { ["id": $0.id, "name": $0.name, "lat": $0.lat, "lon": $0.lon, "radius": $0.radius] as [String: Any] }
        call.resolve(["zones": zones])
    }

    /// Remplace toutes les zones de l'appareil (l'interface tient la liste) ; refuse un rayon < 150 m ou plus de 18 zones.
    @objc func setZones(_ call: CAPPluginCall) {
        let raw = call.getArray("zones", JSObject.self) ?? []
        var zones: [Zone] = []
        for o in raw {
            guard let id = o["id"] as? String, let name = o["name"] as? String,
                  let lat = o["lat"] as? Double, let lon = o["lon"] as? Double, let radius = o["radius"] as? Double else {
                return call.reject("bad_zone")
            }
            if radius < Self.minRadius { return call.reject("radius_too_small") }
            zones.append(Zone(id: id, name: name, lat: lat, lon: lon, radius: radius))
        }
        if zones.count > Self.maxZones { return call.reject("too_many_zones") }
        do {
            try JSONEncoder().encode(zones).write(to: Self.zonesURL, options: .atomic)
        } catch {
            return call.reject("write_failed")
        }
        DispatchQueue.main.async {
            self.monitor(zones)
            NSLog("NokkerZones: \(zones.count) zones set")
            call.resolve(["count": zones.count])
        }
    }

    // MARK: - Transitions

    private func record(_ region: CLRegion, _ event: String) {
        let e = Event(event_id: UUID().uuidString.lowercased(), zone_id: region.identifier, event: event, at: ISO8601DateFormatter().string(from: Date()))
        Self.writeState(region.identifier, inside: event == "enter")
        var all = Self.readEvents()
        if all.last?.zone_id == e.zone_id && all.last?.event == e.event { return } // doublon (état initial puis transition)
        all.append(e)
        try? JSONEncoder().encode(Array(all.suffix(200))).write(to: Self.eventsURL, options: .atomic)
        NSLog("NokkerZones: \(event) \(region.identifier)")
        notifyListeners("zoneEvent", data: ["event_id": e.event_id, "zone_id": e.zone_id, "event": e.event, "at": e.at])
    }

    public func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) { record(region, "enter") }
    public func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) { record(region, "exit") }

    public func locationManager(_ manager: CLLocationManager, didDetermineState state: CLRegionState, for region: CLRegion) {
        NSLog("NokkerZones: state \(region.identifier) \(state == .inside ? "inside" : state == .outside ? "outside" : "unknown")")
        if state != .unknown { Self.writeState(region.identifier, inside: state == .inside) }
    }

    public func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {
        NSLog("NokkerZones: monitoring failed \(region?.identifier ?? "-"): \(error.localizedDescription)")
    }

    @objc func events(_ call: CAPPluginCall) {
        call.resolve(["events": Self.readEvents().map { ["event_id": $0.event_id, "zone_id": $0.zone_id, "event": $0.event, "at": $0.at] }])
    }

    /// Retire de la file les transitions que le noyau a prises (`ids` : leurs `event_id`, doublons compris).
    @objc func clearEvents(_ call: CAPPluginCall) {
        let ids = Set((call.getArray("ids", String.self)) ?? [])
        let rest = Self.readEvents().filter { !ids.contains($0.event_id) }
        try? JSONEncoder().encode(rest).write(to: Self.eventsURL, options: .atomic)
        call.resolve(["left": rest.count])
    }

    // MARK: - Sélecteur

    @objc func pick(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else { return call.reject("no_view") }
            let picker = ZonePickerViewController(
                title: call.getString("name") ?? "",
                radius: max(call.getDouble("radius") ?? 200, Self.minRadius),
                center: call.getDouble("lat").flatMap { lat in call.getDouble("lon").map { CLLocationCoordinate2D(latitude: lat, longitude: $0) } },
                labels: (call.getString("ok") ?? "OK", call.getString("cancel") ?? "Cancel", call.getString("radiusLabel") ?? "%d m")
            ) { result in
                if let r = result { call.resolve(["lat": r.lat, "lon": r.lon, "radius": r.radius]) } else { call.reject("cancelled") }
            }
            host.present(UINavigationController(rootViewController: picker), animated: true)
        }
    }
}
