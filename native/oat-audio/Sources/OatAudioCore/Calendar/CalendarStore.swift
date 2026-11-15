import Foundation

/// Where calendar events come from. `EventKitCalendarStore` in real use; `FixtureCalendarStore` (a JSON file)
/// for `--fixture` and tests. Nothing behind this protocol may prompt for permission except
/// `EventKitCalendarStore.requestAccess`, which only `calendar request-access` calls.
public protocol CalendarEventStore: AnyObject {
    /// Zone used for all-day events and `YYYY-MM-DD` arguments.
    var timeZone: TimeZone { get }
    /// Current authorization. Never prompts.
    func authorization() -> CalendarAuthorization
    /// Raw events overlapping [from, to). Only called when `authorization().canRead`.
    func events(from: Date, to: Date) throws -> [RawCalendarEvent]
    /// Calls `onChange` (on any thread) whenever the store's contents may have changed. Never prompts.
    func observeChanges(_ onChange: @escaping @Sendable () -> Void) throws
}

public struct CalendarError: Error, Equatable, CustomStringConvertible {
    public enum Kind: Sendable, Equatable { case notAuthorized, fixture, other }
    public let kind: Kind
    public let message: String
    public init(_ kind: Kind, _ message: String) {
        self.kind = kind
        self.message = message
    }

    public var description: String { message }
}

// MARK: - Fixture store

/// Serves events from a JSON fixture (PROTOCOL.md → "Calendar fixtures"); never touches EventKit.
/// `observeChanges` watches the file, so editing the fixture simulates `EKEventStoreChanged`.
public final class FixtureCalendarStore: CalendarEventStore, @unchecked Sendable {
    public let path: String?
    public private(set) var timeZone: TimeZone
    private var auth: CalendarAuthorization
    private var raws: [RawCalendarEvent]
    private var watcher: FileChangeWatcher?

    /// Loads `path`; throws `CalendarError(.fixture)` on unreadable / invalid JSON.
    public convenience init(path: String) throws {
        guard let data = FileManager.default.contents(atPath: path) else {
            throw CalendarError(.fixture, "cannot read fixture \(path)")
        }
        try self.init(data: data, path: path)
    }

    public init(data: Data, path: String? = nil) throws {
        self.path = path
        (timeZone, auth, raws) = try Self.parse(data)
    }

    public func authorization() -> CalendarAuthorization { auth }

    public func events(from: Date, to: Date) throws -> [RawCalendarEvent] {
        if let path { // re-read so a long-lived process sees edits
            guard let data = FileManager.default.contents(atPath: path) else {
                throw CalendarError(.fixture, "cannot read fixture \(path)")
            }
            (timeZone, auth, raws) = try Self.parse(data)
        }
        return raws.filter { $0.start < to && max($0.end, $0.start) >= from }
    }

    public func observeChanges(_ onChange: @escaping @Sendable () -> Void) throws {
        guard let path else { return }
        let w = FileChangeWatcher(path: path, onChange: onChange)
        try w.start()
        watcher = w
    }

    // MARK: Parsing

    struct File: Decodable {
        var timeZone: String?
        var authorization: String?
        var calendars: [Cal]?
        var events: [Event]
    }

    struct Cal: Decodable {
        var id: String
        var title: String
        var color: String?
    }

    struct Participant: Decodable {
        var name: String?
        var email: String?
        var url: String?
        var status: RawParticipantStatus?
        var type: RawParticipantType?
        var isSelf: Bool?

        enum CodingKeys: String, CodingKey {
            case name, email, url, status, type
            case isSelf = "self"
        }

        var raw: RawParticipant {
            RawParticipant(name: name, url: url ?? email.map { "mailto:\($0)" }, status: status ?? .unknown,
                           type: type ?? .person, isCurrentUser: isSelf ?? false)
        }
    }

    struct Event: Decodable {
        var id: String?
        var externalId: String?
        var calendarId: String
        var title: String?
        var start: String
        var end: String
        var allDay: Bool?
        var timeZone: String?
        var location: String?
        var url: String?
        var notes: String?
        var status: RawEventStatus?
        var recurring: Bool?
        var detached: Bool?
        var occurrenceDate: String?
        var attendees: [Participant]?
        var organizer: Participant?
    }

    static func parse(_ data: Data) throws -> (TimeZone, CalendarAuthorization, [RawCalendarEvent]) {
        let file: File
        do {
            file = try JSONDecoder().decode(File.self, from: data)
        } catch {
            throw CalendarError(.fixture, "invalid fixture: \(error)")
        }
        let tz: TimeZone
        if let name = file.timeZone {
            guard let z = TimeZone(identifier: name) else { throw CalendarError(.fixture, "unknown timeZone \(name)") }
            tz = z
        } else {
            tz = .current
        }
        var auth = CalendarAuthorization.fullAccess
        if let a = file.authorization {
            guard let parsed = CalendarAuthorization(rawValue: a) else {
                throw CalendarError(.fixture, "unknown authorization \(a)")
            }
            auth = parsed
        }
        var calendars: [String: RawCalendar] = [:]
        for c in file.calendars ?? [] { calendars[c.id] = RawCalendar(id: c.id, title: c.title, color: c.color) }

        func date(_ s: String, _ what: String) throws -> Date {
            if let d = CalendarDates.parseInstant(s) { return d }
            if let day = CalendarDates.parseDay(s), let d = CalendarDates.startOfDay(day, in: tz) { return d }
            throw CalendarError(.fixture, "\(what): not an ISO date-time or YYYY-MM-DD: \(s)")
        }

        let events = try file.events.enumerated().map { i, e -> RawCalendarEvent in
            let what = "events[\(i)]"
            guard let cal = calendars[e.calendarId] else {
                throw CalendarError(.fixture, "\(what): unknown calendarId \(e.calendarId)")
            }
            return RawCalendarEvent(
                eventIdentifier: e.id, externalIdentifier: e.externalId, calendar: cal, title: e.title,
                start: try date(e.start, "\(what).start"), end: try date(e.end, "\(what).end"),
                isAllDay: e.allDay ?? false, timeZone: e.timeZone, location: e.location, url: e.url,
                notes: e.notes, status: e.status ?? .confirmed, hasRecurrenceRules: e.recurring ?? false,
                isDetached: e.detached ?? false,
                occurrenceDate: try e.occurrenceDate.map { try date($0, "\(what).occurrenceDate") },
                attendees: (e.attendees ?? []).map(\.raw), organizer: e.organizer?.raw)
        }
        return (tz, auth, events)
    }
}

// MARK: - File watching

/// Watches a file for writes, including atomic replace (rename/delete → re-open). Calls `onChange` per
/// kernel event; callers debounce.
final class FileChangeWatcher: @unchecked Sendable {
    private let path: String
    private let onChange: @Sendable () -> Void
    private let queue = DispatchQueue(label: "oat-audio.calendar.file-watch")
    private var source: DispatchSourceFileSystemObject?

    init(path: String, onChange: @escaping @Sendable () -> Void) {
        self.path = path
        self.onChange = onChange
    }

    func start() throws {
        guard open() else { throw CalendarError(.fixture, "cannot watch \(path)") }
    }

    private func open() -> Bool {
        let fd = Darwin.open(path, O_EVTONLY)
        guard fd >= 0 else { return false }
        let src = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd, eventMask: [.write, .extend, .attrib, .delete, .rename], queue: queue)
        src.setEventHandler { [weak self, weak src] in
            guard let self, let src else { return }
            self.onChange()
            if !src.data.intersection([.delete, .rename]).isEmpty {
                src.cancel()
                self.reopen(attempt: 0)
            }
        }
        src.setCancelHandler { close(fd) }
        source = src
        src.resume()
        return true
    }

    /// The file was replaced: re-open it (it may take a moment to reappear).
    private func reopen(attempt: Int) {
        queue.asyncAfter(deadline: .now() + .milliseconds(50)) { [weak self] in
            guard let self else { return }
            if self.open() {
                self.onChange()
            } else if attempt < 200 {
                self.reopen(attempt: attempt + 1)
            } else {
                Log.info("calendar: fixture \(self.path) disappeared; no longer watching")
            }
        }
    }
}
