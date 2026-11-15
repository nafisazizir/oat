import CoreGraphics
@preconcurrency import EventKit
import Foundation

/// The real calendar store. Agents never exercise this in tests or CI: reading events needs the Calendars
/// permission (a human checkpoint). `authorization()` and `observeChanges` never prompt; only
/// `requestAccess()` does.
public final class EventKitCalendarStore: CalendarEventStore, @unchecked Sendable {
    private let store = EKEventStore()
    private var observer: NSObjectProtocol?
    public let timeZone: TimeZone = .current

    public init() {}

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    public static func authorization() -> CalendarAuthorization {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: return .fullAccess
        case .writeOnly: return .writeOnly
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        @unknown default: return .unknown
        }
    }

    public func authorization() -> CalendarAuthorization { Self.authorization() }

    /// Shows the macOS Calendars prompt if undecided (human only). Returns the resulting status.
    public func requestAccess() async -> CalendarAuthorization {
        do {
            _ = try await store.requestFullAccessToEvents()
        } catch {
            Log.info("calendar: request access failed: \(error)")
        }
        return Self.authorization()
    }

    public func events(from: Date, to: Date) throws -> [RawCalendarEvent] {
        let predicate = store.predicateForEvents(withStart: from, end: to, calendars: nil)
        return store.events(matching: predicate).map(Self.raw)
    }

    public func observeChanges(_ onChange: @escaping @Sendable () -> Void) throws {
        // Touch the store first so its daemon connection exists; a store that never fetched may not be sent
        // EKEventStoreChanged. (Only called with full access — `watch` checks authorization first.)
        _ = store.calendars(for: .event)
        observer = NotificationCenter.default.addObserver(
            forName: .EKEventStoreChanged, object: store, queue: nil) { _ in onChange() }
    }

    // MARK: - EKEvent → RawCalendarEvent

    static func raw(_ e: EKEvent) -> RawCalendarEvent {
        RawCalendarEvent(
            eventIdentifier: e.eventIdentifier,
            externalIdentifier: e.calendarItemExternalIdentifier,
            calendar: RawCalendar(id: e.calendar?.calendarIdentifier ?? "unknown",
                                  title: e.calendar?.title ?? "",
                                  color: e.calendar?.cgColor.flatMap(hex)),
            title: e.title,
            start: e.startDate,
            end: e.endDate,
            isAllDay: e.isAllDay,
            timeZone: e.timeZone?.identifier,
            location: e.location,
            url: e.url?.absoluteString,
            notes: e.notes,
            status: status(e.status),
            hasRecurrenceRules: e.hasRecurrenceRules,
            isDetached: e.isDetached,
            occurrenceDate: e.occurrenceDate,
            attendees: (e.attendees ?? []).map(participant),
            organizer: e.organizer.map(participant))
    }

    static func participant(_ p: EKParticipant) -> RawParticipant {
        let status: RawParticipantStatus = switch p.participantStatus {
        case .pending: .pending
        case .accepted: .accepted
        case .declined: .declined
        case .tentative: .tentative
        case .delegated: .delegated
        case .completed: .completed
        case .inProcess: .inProcess
        default: .unknown
        }
        let type: RawParticipantType = switch p.participantType {
        case .person: .person
        case .room: .room
        case .resource: .resource
        case .group: .group
        default: .unknown
        }
        return RawParticipant(name: p.name, url: p.url.absoluteString, status: status, type: type,
                              isCurrentUser: p.isCurrentUser)
    }

    static func status(_ s: EKEventStatus) -> RawEventStatus {
        switch s {
        case .confirmed: return .confirmed
        case .tentative: return .tentative
        case .canceled: return .canceled
        default: return .none
        }
    }

    static func hex(_ color: CGColor) -> String? {
        guard let srgb = CGColorSpace(name: CGColorSpace.sRGB),
              let c = color.converted(to: srgb, intent: .defaultIntent, options: nil),
              let comps = c.components, comps.count >= 3
        else { return nil }
        func byte(_ v: CGFloat) -> Int { Int((max(0, min(1, v)) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", byte(comps[0]), byte(comps[1]), byte(comps[2]))
    }

}
