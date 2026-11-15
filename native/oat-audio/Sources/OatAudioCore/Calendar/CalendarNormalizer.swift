import Foundation

/// Turns `RawCalendarEvent`s (EventKit's view) into `CalendarEventRecord`s (the shared `CalendarEvent` shape).
///
/// Rules (PROTOCOL.md → "Calendar"):
/// - `id` = `eventkit:<eventIdentifier>`; occurrences of a recurring event share an eventIdentifier, so they get
///   `/<original occurrence start, ISO>` appended. `recurrenceId` = `eventkit:<eventIdentifier>` for those.
/// - All-day events: `start`/`end` are midnights in `timeZone` (the Mac's zone in real use, the fixture's in
///   fixture mode); `allDayStart`/`allDayEnd` are the day strings, end exclusive. EventKit reports an all-day
///   end as the last day 23:59:59, which becomes the next midnight.
/// - Attendees: rooms/resources dropped; email from the `mailto:` URL (lower-cased); de-duplicated by email;
///   the organizer is flagged, or prepended if EventKit did not list them as an attendee.
/// - Status: canceled → `cancelled`, tentative → `tentative`, anything else → `confirmed`.
public struct CalendarNormalizer: Sendable {
    public var timeZone: TimeZone
    public var source: String

    public init(timeZone: TimeZone = .current, source: String = "eventkit") {
        self.timeZone = timeZone
        self.source = source
    }

    public func normalize(_ raw: RawCalendarEvent) -> CalendarEventRecord {
        let recurring = raw.hasRecurrenceRules || raw.isDetached
        let baseId: String
        if let ident = nonEmpty(raw.eventIdentifier) ?? nonEmpty(raw.externalIdentifier) {
            baseId = "\(source):\(ident)"
        } else {
            baseId = "\(source):anon:\(raw.calendar.id):\(CalendarDates.iso(raw.start))"
        }
        let id = recurring ? "\(baseId)/\(CalendarDates.iso(raw.occurrenceDate ?? raw.start))" : baseId

        var start = raw.start
        var end = max(raw.end, raw.start)
        var allDayStart: String?
        var allDayEnd: String?
        if raw.isAllDay {
            (start, end, allDayStart, allDayEnd) = allDayBounds(start: raw.start, end: raw.end)
        }

        return CalendarEventRecord(
            id: id,
            source: source,
            calendar: raw.calendar,
            title: (raw.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
            start: start,
            end: end,
            allDay: raw.isAllDay,
            allDayStart: allDayStart,
            allDayEnd: allDayEnd,
            timeZone: raw.isAllDay ? nil : nonEmpty(raw.timeZone),
            location: nonEmpty(raw.location),
            url: nonEmpty(raw.url),
            conference: ConferenceLinks.detect(url: raw.url, location: raw.location, notes: raw.notes),
            status: Self.status(raw.status),
            attendees: attendees(raw.attendees, organizer: raw.organizer),
            recurrenceId: recurring ? baseId : nil,
            icalUid: nonEmpty(raw.externalIdentifier))
    }

    /// Normalise, keep events overlapping [from, to) (`start < to && end > from`; a zero-length event at
    /// `from` counts), and sort by start, end, id.
    public func normalize(_ raws: [RawCalendarEvent], from: Date, to: Date) -> [CalendarEventRecord] {
        raws.map(normalize)
            .filter { $0.start < to && ($0.end > from || ($0.end == $0.start && $0.start >= from)) }
            .sorted { a, b in
                if a.start != b.start { return a.start < b.start }
                if a.end != b.end { return a.end < b.end }
                return a.id < b.id
            }
    }

    // MARK: - Parts

    func allDayBounds(start: Date, end: Date) -> (Date, Date, String, String) {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        let firstDay = cal.startOfDay(for: start)
        let endMidnight = cal.startOfDay(for: end)
        // Exactly midnight → that day is already exclusive; otherwise (EventKit's 23:59:59) → next midnight.
        var lastExclusive = end == endMidnight ? endMidnight : cal.date(byAdding: .day, value: 1, to: endMidnight)!
        if lastExclusive <= firstDay { lastExclusive = cal.date(byAdding: .day, value: 1, to: firstDay)! }
        return (firstDay, lastExclusive, CalendarDates.dayString(firstDay, in: timeZone),
                CalendarDates.dayString(lastExclusive, in: timeZone))
    }

    static func status(_ raw: RawEventStatus) -> CalendarEventStatus {
        switch raw {
        case .canceled: return .cancelled
        case .tentative: return .tentative
        case .none, .confirmed: return .confirmed
        }
    }

    static func attendeeStatus(_ raw: RawParticipantStatus) -> AttendeeStatus {
        switch raw {
        case .accepted, .completed, .inProcess: return .accepted
        case .declined, .delegated: return .declined // delegated: someone else goes in your place
        case .tentative: return .tentative
        case .pending: return .needsAction
        case .unknown: return .unknown
        }
    }

    /// `mailto:Ana%40x.com?subject=…` → `ana@x.com`; anything that is not a mailto with an `@` → nil.
    static func email(from url: String?) -> String? {
        guard let url = nonEmpty(url) else { return nil }
        let lower = url.lowercased()
        guard lower.hasPrefix("mailto:") else { return nil }
        var addr = String(url.dropFirst("mailto:".count))
        if let q = addr.firstIndex(of: "?") { addr = String(addr[..<q]) }
        addr = (addr.removingPercentEncoding ?? addr).trimmingCharacters(in: .whitespaces).lowercased()
        return addr.contains("@") ? addr : nil
    }

    func attendees(_ raws: [RawParticipant], organizer: RawParticipant?) -> [CalendarAttendeeRecord] {
        let organizerEmail = organizer.flatMap { Self.email(from: $0.url) }
        var out: [CalendarAttendeeRecord] = []
        var seen = Set<String>()
        var organizerListed = false
        for p in raws where p.type != .room && p.type != .resource {
            let email = Self.email(from: p.url)
            if let email {
                if seen.contains(email) { continue }
                seen.insert(email)
            }
            let isOrganizer = organizer != nil && (
                (email != nil && email == organizerEmail)
                    || (email == nil && organizerEmail == nil && nonEmpty(p.name) != nil
                        && nonEmpty(p.name) == nonEmpty(organizer?.name)))
            if isOrganizer { organizerListed = true }
            out.append(CalendarAttendeeRecord(
                name: nonEmpty(p.name), email: email, status: Self.attendeeStatus(p.status),
                isSelf: p.isCurrentUser, isOrganizer: isOrganizer))
        }
        if let organizer, !organizerListed, organizer.type != .room, organizer.type != .resource,
           organizerEmail != nil || nonEmpty(organizer.name) != nil
        {
            // Organizers implicitly attend: an unknown response reads as accepted.
            let status = organizer.status == .unknown ? AttendeeStatus.accepted : Self.attendeeStatus(organizer.status)
            out.insert(CalendarAttendeeRecord(
                name: nonEmpty(organizer.name), email: organizerEmail, status: status,
                isSelf: organizer.isCurrentUser, isOrganizer: true), at: 0)
        }
        return out
    }
}

func nonEmpty(_ s: String?) -> String? {
    guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
    return t
}
