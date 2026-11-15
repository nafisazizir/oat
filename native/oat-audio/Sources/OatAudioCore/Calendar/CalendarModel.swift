import Foundation

// Calendar model for the `calendar` subcommands (task 7.1, PROTOCOL.md → "Calendar").
//
// Two layers:
// - `RawCalendarEvent` mirrors what EventKit hands us (EKEvent / EKParticipant fields as plain values), so the
//   normaliser can be tested with fixture events and never needs a real `EKEventStore`.
// - `CalendarEventRecord` is the normalised event written as one JSON line by `calendar events`. Its JSON is
//   the `CalendarEvent` shape in `@oat/core` (camelCase), shared with Google Calendar (task 7.4).

/// Calendar authorization as reported by `calendar status`. Only `fullAccess` can read events.
public enum CalendarAuthorization: String, Sendable, Equatable, CaseIterable {
    case fullAccess = "full_access"
    case writeOnly = "write_only"
    case denied
    case restricted
    case notDetermined = "not_determined"
    case unknown

    public var canRead: Bool { self == .fullAccess }
}

/// EKParticipantStatus, by name.
public enum RawParticipantStatus: String, Sendable, Equatable, Decodable {
    case unknown, pending, accepted, declined, tentative, delegated, completed
    case inProcess = "in_process"
}

/// EKParticipantType, by name. Rooms and resources are not people and are dropped from attendees.
public enum RawParticipantType: String, Sendable, Equatable, Decodable {
    case unknown, person, room, resource, group
}

/// EKEventStatus, by name.
public enum RawEventStatus: String, Sendable, Equatable, Decodable {
    case none, confirmed, tentative
    case canceled = "cancelled"
}

public struct RawParticipant: Sendable, Equatable {
    public var name: String?
    /// EKParticipant.url, usually `mailto:<address>`.
    public var url: String?
    public var status: RawParticipantStatus
    public var type: RawParticipantType
    public var isCurrentUser: Bool

    public init(name: String? = nil, url: String? = nil, status: RawParticipantStatus = .unknown,
                type: RawParticipantType = .person, isCurrentUser: Bool = false)
    {
        self.name = name
        self.url = url
        self.status = status
        self.type = type
        self.isCurrentUser = isCurrentUser
    }

    /// Convenience for tests and fixtures: an email becomes a `mailto:` URL, as EventKit reports it.
    public init(name: String? = nil, email: String, status: RawParticipantStatus = .unknown,
                type: RawParticipantType = .person, isCurrentUser: Bool = false)
    {
        self.init(name: name, url: "mailto:\(email)", status: status, type: type, isCurrentUser: isCurrentUser)
    }
}

public struct RawCalendar: Sendable, Equatable {
    public var id: String
    public var title: String
    /// `#RRGGBB` (sRGB), or nil.
    public var color: String?

    public init(id: String, title: String, color: String? = nil) {
        self.id = id
        self.title = title
        self.color = color
    }
}

public struct RawCalendarEvent: Sendable, Equatable {
    /// EKEvent.eventIdentifier — shared by every occurrence of a recurring event.
    public var eventIdentifier: String?
    /// EKCalendarItem.calendarItemExternalIdentifier (usually the iCalendar UID).
    public var externalIdentifier: String?
    public var calendar: RawCalendar
    public var title: String?
    public var start: Date
    public var end: Date
    public var isAllDay: Bool
    /// EKCalendarItem.timeZone identifier; nil for floating / all-day events.
    public var timeZone: String?
    public var location: String?
    public var url: String?
    public var notes: String?
    public var status: RawEventStatus
    /// EKCalendarItem.hasRecurrenceRules.
    public var hasRecurrenceRules: Bool
    /// EKEvent.isDetached: an occurrence of a recurring event that was changed on its own.
    public var isDetached: Bool
    /// EKEvent.occurrenceDate: the original start of this occurrence (nil = use `start`).
    public var occurrenceDate: Date?
    public var attendees: [RawParticipant]
    public var organizer: RawParticipant?

    public init(eventIdentifier: String?, externalIdentifier: String? = nil, calendar: RawCalendar,
                title: String?, start: Date, end: Date, isAllDay: Bool = false, timeZone: String? = nil,
                location: String? = nil, url: String? = nil, notes: String? = nil,
                status: RawEventStatus = .confirmed, hasRecurrenceRules: Bool = false, isDetached: Bool = false,
                occurrenceDate: Date? = nil, attendees: [RawParticipant] = [], organizer: RawParticipant? = nil)
    {
        self.eventIdentifier = eventIdentifier
        self.externalIdentifier = externalIdentifier
        self.calendar = calendar
        self.title = title
        self.start = start
        self.end = end
        self.isAllDay = isAllDay
        self.timeZone = timeZone
        self.location = location
        self.url = url
        self.notes = notes
        self.status = status
        self.hasRecurrenceRules = hasRecurrenceRules
        self.isDetached = isDetached
        self.occurrenceDate = occurrenceDate
        self.attendees = attendees
        self.organizer = organizer
    }
}

// MARK: - Normalised output

/// Attendee response, aligned with Google Calendar's `responseStatus` (needsAction → `needs_action`).
public enum AttendeeStatus: String, Sendable, Equatable {
    case accepted, declined, tentative
    case needsAction = "needs_action"
    case unknown
}

public enum CalendarEventStatus: String, Sendable, Equatable {
    case confirmed, tentative, cancelled
}

public struct CalendarAttendeeRecord: Sendable, Equatable {
    public var name: String?
    public var email: String?
    public var status: AttendeeStatus
    public var isSelf: Bool
    public var isOrganizer: Bool

    public var json: JSONValue {
        .object([
            ("name", name.map(JSONValue.string) ?? .null),
            ("email", email.map(JSONValue.string) ?? .null),
            ("status", .string(status.rawValue)),
            ("isSelf", .bool(isSelf)),
            ("isOrganizer", .bool(isOrganizer)),
        ])
    }
}

public struct CalendarEventRecord: Sendable, Equatable {
    public var id: String
    public var source: String
    public var calendar: RawCalendar
    public var title: String
    public var start: Date
    public var end: Date
    public var allDay: Bool
    /// All-day events only: first day and the day after the last day (`YYYY-MM-DD`, end exclusive).
    public var allDayStart: String?
    public var allDayEnd: String?
    public var timeZone: String?
    public var location: String?
    public var url: String?
    public var conference: ConferenceLink?
    public var status: CalendarEventStatus
    public var attendees: [CalendarAttendeeRecord]
    /// Identifies the recurring series this occurrence belongs to; nil for one-off events.
    public var recurrenceId: String?
    public var icalUid: String?

    public var json: JSONValue {
        func opt(_ s: String?) -> JSONValue { s.map(JSONValue.string) ?? .null }
        return .object([
            ("id", .string(id)),
            ("source", .string(source)),
            ("calendar", .object([("id", .string(calendar.id)), ("title", .string(calendar.title)),
                                  ("color", opt(calendar.color))])),
            ("title", .string(title)),
            ("start", .string(CalendarDates.iso(start))),
            ("end", .string(CalendarDates.iso(end))),
            ("allDay", .bool(allDay)),
            ("allDayStart", opt(allDayStart)),
            ("allDayEnd", opt(allDayEnd)),
            ("timeZone", opt(timeZone)),
            ("location", opt(location)),
            ("url", opt(url)),
            ("conferenceUrl", opt(conference?.url)),
            ("conferenceProvider", opt(conference?.provider.rawValue)),
            ("status", .string(status.rawValue)),
            ("attendees", .array(attendees.map(\.json))),
            ("recurrenceId", opt(recurrenceId)),
            ("icalUid", opt(icalUid)),
        ])
    }
}

// MARK: - Dates

public enum CalendarDates {
    private static let isoOut = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let isoIn = Date.ISO8601FormatStyle()

    /// `2026-11-16T17:00:00.000Z` — the same form as JavaScript's `Date.prototype.toISOString`.
    public static func iso(_ date: Date) -> String { isoOut.format(date) }

    /// Parses an ISO 8601 date-time with `Z` or an offset, with or without fractional seconds.
    public static func parseInstant(_ s: String) -> Date? {
        (try? isoIn.parse(s)) ?? (try? isoOut.parse(s))
    }

    /// `YYYY-MM-DD` → (year, month, day), validated.
    public static func parseDay(_ s: String) -> DateComponents? {
        let parts = s.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]),
              (1...12).contains(m), (1...31).contains(d)
        else { return nil }
        var c = DateComponents(year: y, month: m, day: d)
        // Reject 2026-02-31 and friends.
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        guard let date = cal.date(from: c), cal.dateComponents([.year, .month, .day], from: date) == c else {
            return nil
        }
        c.calendar = nil
        return c
    }

    /// Midnight starting `day` in `timeZone`.
    public static func startOfDay(_ day: DateComponents, in timeZone: TimeZone) -> Date? {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        var c = day
        c.hour = 0
        c.minute = 0
        c.second = 0
        return cal.date(from: c)
    }

    /// `YYYY-MM-DD` of `date` in `timeZone`.
    public static func dayString(_ date: Date, in timeZone: TimeZone) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        let c = cal.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }
}
