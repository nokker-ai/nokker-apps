import Capacitor
import Contacts
import EventKit
import Foundation

/// `Capacitor.Plugins.NokkerPim` — agenda, contacts et rappels DU TÉLÉPHONE, en lecture (LOKKAL-PHONE §4.3, lot P8).
/// Rien ne part d'ici tout seul : l'interface répond à une demande `device.request` du noyau, pendant un tour, avec les
/// champs minimaux du contrat (50 éléments au plus, notes coupées à 300 caractères, ni pièces jointes ni identifiants).
@objc(NokkerPimPlugin)
public class NokkerPimPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NokkerPimPlugin"
    public let jsName = "NokkerPim"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "calendarList", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "contactsSearch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remindersList", returnType: CAPPluginReturnPromise)
    ]

    static let maxItems = 50
    static let notesMax = 300
    static let maxDays: TimeInterval = 31 * 86_400

    private let events = EKEventStore()
    private let contacts = CNContactStore()
    private let iso = ISO8601DateFormatter()

    // MARK: - Autorisations

    static func eventStatus(_ type: EKEntityType) -> String {
        let s = EKEventStore.authorizationStatus(for: type)
        if #available(iOS 17.0, *) {
            switch s {
            case .fullAccess: return "granted"
            case .writeOnly: return "write_only"
            default: break
            }
        }
        switch s {
        case .notDetermined: return "not_determined"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .authorized: return "granted"
        default: return "unknown"
        }
    }

    static func contactsStatus() -> String {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .notDetermined: return "not_determined"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .authorized: return "granted"
        default: return "limited"
        }
    }

    private func statusPayload() -> [String: String] {
        ["calendar": Self.eventStatus(.event), "reminders": Self.eventStatus(.reminder), "contacts": Self.contactsStatus()]
    }

    @objc func status(_ call: CAPPluginCall) { call.resolve(statusPayload()) }

    /// `{kind: "calendar"|"reminders"|"contacts"}` : invite système (accès complet pour lire l'agenda et les rappels).
    @objc func request(_ call: CAPPluginCall) {
        let done: (Bool, Error?) -> Void = { _, _ in DispatchQueue.main.async { call.resolve(self.statusPayload()) } }
        switch call.getString("kind") ?? "" {
        case "calendar":
            if #available(iOS 17.0, *) { events.requestFullAccessToEvents(completion: done) } else { events.requestAccess(to: .event, completion: done) }
        case "reminders":
            if #available(iOS 17.0, *) { events.requestFullAccessToReminders(completion: done) } else { events.requestAccess(to: .reminder, completion: done) }
        case "contacts":
            contacts.requestAccess(for: .contacts, completionHandler: done)
        default:
            call.reject("bad_kind")
        }
    }

    // MARK: - Lectures

    private static func cut(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s.count > notesMax ? String(s.prefix(notesMax - 1)) + "…" : s
    }

    func readCalendar(from: Date, to: Date, q: String?) -> [[String: Any]] {
        let end = min(to, from.addingTimeInterval(Self.maxDays))
        let pred = events.predicateForEvents(withStart: from, end: end, calendars: nil)
        let needle = q?.lowercased().trimmingCharacters(in: .whitespaces) ?? ""
        return events.events(matching: pred)
            .filter { needle.isEmpty || ($0.title ?? "").lowercased().contains(needle) || ($0.location ?? "").lowercased().contains(needle) }
            .sorted { $0.startDate < $1.startDate }
            .prefix(Self.maxItems)
            .map { e in
                var o: [String: Any] = ["title": e.title ?? "", "start": iso.string(from: e.startDate), "end": iso.string(from: e.endDate),
                                        "all_day": e.isAllDay, "calendar": e.calendar?.title ?? ""]
                if let l = e.location, !l.isEmpty { o["location"] = l }
                if let n = Self.cut(e.notes) { o["notes"] = n }
                return o
            }
    }

    @objc func calendarList(_ call: CAPPluginCall) {
        guard Self.eventStatus(.event) == "granted" else { return call.resolve(["error": "denied"]) }
        let from = call.getString("from").flatMap(iso.date(from:)) ?? Date()
        let to = call.getString("to").flatMap(iso.date(from:)) ?? from.addingTimeInterval(7 * 86_400)
        call.resolve(["items": readCalendar(from: from, to: to, q: call.getString("q"))])
    }

    func readContacts(q: String, limit: Int) throws -> [[String: Any]] {
        let keys = [CNContactGivenNameKey, CNContactFamilyNameKey, CNContactEmailAddressesKey, CNContactPhoneNumbersKey, CNContactOrganizationNameKey] as [CNKeyDescriptor]
        let found = try contacts.unifiedContacts(matching: CNContact.predicateForContacts(matchingName: q), keysToFetch: keys)
        return found.prefix(min(max(limit, 1), 10)).map { c in
            var o: [String: Any] = [
                "name": [c.givenName, c.familyName].filter { !$0.isEmpty }.joined(separator: " "),
                "emails": c.emailAddresses.map { String($0.value) },
                "phones": c.phoneNumbers.map { $0.value.stringValue }
            ]
            if !c.organizationName.isEmpty { o["org"] = c.organizationName }
            return o
        }
    }

    @objc func contactsSearch(_ call: CAPPluginCall) {
        guard Self.contactsStatus() == "granted" else { return call.resolve(["error": "denied"]) }
        let q = (call.getString("q") ?? "").trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return call.resolve(["items": []]) }
        do { call.resolve(["items": try readContacts(q: q, limit: call.getInt("limit") ?? 10)]) } catch { call.resolve(["error": "unavailable"]) }
    }

    func readReminders(includeDone: Bool, dueBefore: Date?, _ done: @escaping ([[String: Any]]) -> Void) {
        let pred = includeDone ? events.predicateForReminders(in: nil)
                               : events.predicateForIncompleteReminders(withDueDateStarting: nil, ending: dueBefore, calendars: nil)
        events.fetchReminders(matching: pred) { found in
            let items = (found ?? []).prefix(Self.maxItems).map { r -> [String: Any] in
                var o: [String: Any] = ["title": r.title ?? "", "done": r.isCompleted, "list": r.calendar?.title ?? ""]
                if let d = r.dueDateComponents?.date { o["due"] = self.iso.string(from: d) }
                if let n = Self.cut(r.notes) { o["notes"] = n }
                return o
            }
            done(Array(items))
        }
    }

    @objc func remindersList(_ call: CAPPluginCall) {
        guard Self.eventStatus(.reminder) == "granted" else { return call.resolve(["error": "denied"]) }
        readReminders(includeDone: call.getBool("include_done") ?? false, dueBefore: call.getString("due_before").flatMap(iso.date(from:))) { items in
            call.resolve(["items": items])
        }
    }

    // MARK: - Autotest du CI (debug seulement)

    override public func load() {
        NSLog("NokkerPim: loaded, calendar \(Self.eventStatus(.event)), reminders \(Self.eventStatus(.reminder)), contacts \(Self.contactsStatus())")
        #if DEBUG
        let flag = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("nokker-ci-pim")
        if FileManager.default.fileExists(atPath: flag.path) {
            try? FileManager.default.removeItem(at: flag)
            DispatchQueue.global().async { self.selfTest() }
        }
        #endif
    }

    #if DEBUG
    /// Pose un événement, un rappel et un contact de test, puis relit par les mêmes chemins que les demandes du noyau.
    private func selfTest() {
        let tomorrow = Calendar.current.startOfDay(for: Date().addingTimeInterval(86_400)).addingTimeInterval(9 * 3600)
        if let cal = events.defaultCalendarForNewEvents {
            let e = EKEvent(eventStore: events)
            e.title = "Rendez-vous de test"
            e.startDate = tomorrow
            e.endDate = tomorrow.addingTimeInterval(1800)
            e.calendar = cal
            try? events.save(e, span: .thisEvent)
        }
        if let list = events.defaultCalendarForNewReminders() {
            let r = EKReminder(eventStore: events)
            r.title = "Rappel de test"
            r.calendar = list
            try? events.save(r, commit: true)
        }
        let c = CNMutableContact()
        c.givenName = "Camille"
        c.familyName = "Essai"
        c.emailAddresses = [CNLabeledValue(label: CNLabelHome, value: "camille@example.org" as NSString)]
        let save = CNSaveRequest()
        save.add(c, toContainerWithIdentifier: nil)
        try? contacts.execute(save)

        let cal = readCalendar(from: Date(), to: Date().addingTimeInterval(3 * 86_400), q: "test").count
        let con = (try? readContacts(q: "Camille", limit: 10).count) ?? -1
        readReminders(includeDone: false, dueBefore: nil) { items in
            let rem = items.filter { ($0["title"] as? String) == "Rappel de test" }.count
            NSLog("NokkerPim: self-test calendar \(cal), contacts \(con), reminders \(rem)")
        }
    }
    #endif
}
