import CoreGraphics
import Foundation
import Testing
@testable import OatAudioCore

/// Repo-root `fixtures/calendar/…` (shared with the TypeScript tests).
private func fixtureURL(_ name: String) -> URL {
    URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // OatAudioCoreTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // oat-audio
        .deletingLastPathComponent() // native
        .deletingLastPathComponent() // repo root
        .appendingPathComponent("fixtures/calendar/\(name)")
}

private func date(_ s: String) -> Date { CalendarDates.parseInstant(s)! }
private let la = TimeZone(identifier: "America/Los_Angeles")!
private let work = RawCalendar(id: "cal-work", title: "Work", color: "#3B82F6")

private func event(_ id: String? = "E1", start: String = "2026-11-16T17:00:00Z", end: String = "2026-11-16T18:00:00Z",
                   configure: (inout RawCalendarEvent) -> Void = { _ in }) -> RawCalendarEvent
{
    var e = RawCalendarEvent(eventIdentifier: id, calendar: work, title: "Sync", start: date(start), end: date(end))
    configure(&e)
    return e
}

/// An injectable store with canned events; records whether events were read.
private final class MockStore: CalendarEventStore, @unchecked Sendable {
    var auth: CalendarAuthorization
    var raws: [RawCalendarEvent]
    var queried: [(Date, Date)] = []
    let timeZone: TimeZone

    init(auth: CalendarAuthorization = .fullAccess, raws: [RawCalendarEvent] = [], timeZone: TimeZone = la) {
        self.auth = auth
        self.raws = raws
        self.timeZone = timeZone
    }

    func authorization() -> CalendarAuthorization { auth }
    func events(from: Date, to: Date) throws -> [RawCalendarEvent] {
        queried.append((from, to))
        return raws
    }

    func observeChanges(_ onChange: @escaping @Sendable () -> Void) throws {}
}

// MARK: - Conference links

private struct LinkCases: Decodable {
    struct Case: Decodable {
        struct Expect: Decodable, Equatable {
            var provider: String
            var url: String
        }

        var name: String
        var url: String?
        var location: String?
        var notes: String?
        var expect: Expect?
    }

    var cases: [Case]
}

@Suite("calendar: conference links")
struct ConferenceLinkTests {
    @Test func sharedCases() throws {
        let data = try Data(contentsOf: fixtureURL("conference-links.json"))
        let cases = try JSONDecoder().decode(LinkCases.self, from: data).cases
        #expect(cases.count >= 20)
        for c in cases {
            let got = ConferenceLinks.detect(url: c.url, location: c.location, notes: c.notes)
            let gotExpect = got.map { LinkCases.Case.Expect(provider: $0.provider.rawValue, url: $0.url) }
            #expect(gotExpect == c.expect, "case: \(c.name)")
        }
    }

    @Test func providerNamesMatchCore() {
        #expect(ConferenceProvider.allCases.map(\.rawValue) == ["zoom", "google_meet", "teams"])
    }
}

// MARK: - Normaliser

@Suite("calendar: normalisation")
struct CalendarNormalizerTests {
    let n = CalendarNormalizer(timeZone: la)

    @Test func oneOffEventIdsAndFields() {
        let r = n.normalize(event { e in
            e.externalIdentifier = "uid-1@oat.test"
            e.title = "  Planning \n"
            e.location = "  "
            e.url = "https://zoom.us/j/123"
            e.timeZone = "America/New_York"
        })
        #expect(r.id == "eventkit:E1")
        #expect(r.source == "eventkit")
        #expect(r.recurrenceId == nil)
        #expect(r.icalUid == "uid-1@oat.test")
        #expect(r.title == "Planning")
        #expect(r.location == nil, "blank strings become null")
        #expect(r.url == "https://zoom.us/j/123")
        #expect(r.conference == ConferenceLink(provider: .zoom, url: "https://zoom.us/j/123"))
        #expect(r.timeZone == "America/New_York")
        #expect(r.status == .confirmed)
        #expect(!r.allDay && r.allDayStart == nil && r.allDayEnd == nil)
    }

    @Test func recurringOccurrencesGetDistinctIdsAndShareSeries() {
        let a = n.normalize(event("S1", start: "2026-11-16T17:30:00Z", end: "2026-11-16T17:45:00Z") {
            $0.hasRecurrenceRules = true
            $0.occurrenceDate = date("2026-11-16T17:30:00Z")
        })
        // A detached (moved) occurrence keeps its *original* occurrence date in the id.
        let b = n.normalize(event("S1", start: "2026-11-18T18:00:00Z", end: "2026-11-18T18:15:00Z") {
            $0.isDetached = true
            $0.occurrenceDate = date("2026-11-18T17:30:00Z")
        })
        #expect(a.id == "eventkit:S1/2026-11-16T17:30:00.000Z")
        #expect(b.id == "eventkit:S1/2026-11-18T17:30:00.000Z")
        #expect(a.recurrenceId == "eventkit:S1" && b.recurrenceId == "eventkit:S1")
    }

    @Test func missingIdentifiersFallBack() {
        let ext = n.normalize(event(nil) { $0.externalIdentifier = "uid@x" })
        #expect(ext.id == "eventkit:uid@x")
        let anon = n.normalize(event(nil))
        #expect(anon.id == "eventkit:anon:cal-work:2026-11-16T17:00:00.000Z")
    }

    @Test func statusMapping() {
        #expect(CalendarNormalizer.status(.none) == .confirmed)
        #expect(CalendarNormalizer.status(.confirmed) == .confirmed)
        #expect(CalendarNormalizer.status(.tentative) == .tentative)
        #expect(CalendarNormalizer.status(.canceled) == .cancelled)
    }

    @Test func attendeeStatusMapping() {
        let map: [(RawParticipantStatus, AttendeeStatus)] = [
            (.accepted, .accepted), (.completed, .accepted), (.inProcess, .accepted),
            (.declined, .declined), (.delegated, .declined), (.tentative, .tentative),
            (.pending, .needsAction), (.unknown, .unknown),
        ]
        for (raw, want) in map { #expect(CalendarNormalizer.attendeeStatus(raw) == want, "\(raw)") }
    }

    @Test func emailFromMailto() {
        #expect(CalendarNormalizer.email(from: "mailto:Ana@Oat.Test") == "ana@oat.test")
        #expect(CalendarNormalizer.email(from: "MAILTO:ana%40oat.test?subject=hi") == "ana@oat.test")
        #expect(CalendarNormalizer.email(from: "mailto:not-an-address") == nil)
        #expect(CalendarNormalizer.email(from: "https://example.com") == nil)
        #expect(CalendarNormalizer.email(from: nil) == nil)
        #expect(CalendarNormalizer.email(from: "  ") == nil)
    }

    @Test func attendeesDropRoomsDedupeAndFlagOrganizer() {
        let r = n.normalize(event { e in
            e.organizer = RawParticipant(name: "Priya", email: "priya@oat.test", status: .accepted)
            e.attendees = [
                RawParticipant(name: "Room 4A", email: "room@resource.test", status: .accepted, type: .room),
                RawParticipant(name: "Projector", email: "proj@resource.test", type: .resource),
                RawParticipant(name: "Alex", email: "alex@oat.test", status: .tentative, isCurrentUser: true),
                RawParticipant(name: "Priya", email: "PRIYA@oat.test", status: .accepted),
                RawParticipant(name: "Priya again", email: "priya@oat.test", status: .declined),
                RawParticipant(name: "Group", email: "eng@oat.test", status: .pending, type: .group),
                RawParticipant(name: "No email", url: nil, status: .unknown),
            ]
        })
        #expect(r.attendees == [
            CalendarAttendeeRecord(name: "Alex", email: "alex@oat.test", status: .tentative, isSelf: true, isOrganizer: false),
            CalendarAttendeeRecord(name: "Priya", email: "priya@oat.test", status: .accepted, isSelf: false, isOrganizer: true),
            CalendarAttendeeRecord(name: "Group", email: "eng@oat.test", status: .needsAction, isSelf: false, isOrganizer: false),
            CalendarAttendeeRecord(name: "No email", email: nil, status: .unknown, isSelf: false, isOrganizer: false),
        ])
    }

    @Test func organizerNotListedIsPrependedAsAccepted() {
        let r = n.normalize(event { e in
            e.organizer = RawParticipant(name: "Chris", email: "chris@acme.example", status: .unknown)
            e.attendees = [RawParticipant(name: "Alex", email: "alex@oat.test", status: .accepted, isCurrentUser: true)]
        })
        #expect(r.attendees.first == CalendarAttendeeRecord(
            name: "Chris", email: "chris@acme.example", status: .accepted, isSelf: false, isOrganizer: true))
        #expect(r.attendees.count == 2)
    }

    @Test func soloEventHasNoAttendees() {
        #expect(n.normalize(event()).attendees.isEmpty)
        // An organizer that is a room, or has neither name nor email, is not added.
        let r = n.normalize(event { $0.organizer = RawParticipant(name: nil, url: nil) })
        #expect(r.attendees.isEmpty)
    }

    @Test func allDayFromEventKitEndOfDay() {
        // EventKit: all-day Fri 20 Nov → start 00:00, end 23:59:59 local.
        let r = n.normalize(event(start: "2026-11-20T00:00:00-08:00", end: "2026-11-20T23:59:59-08:00") {
            $0.isAllDay = true
            $0.timeZone = "America/Los_Angeles"
        })
        #expect(r.allDay)
        #expect(r.allDayStart == "2026-11-20" && r.allDayEnd == "2026-11-21")
        #expect(r.start == date("2026-11-20T08:00:00Z") && r.end == date("2026-11-21T08:00:00Z"))
        #expect(r.timeZone == nil, "all-day events are floating")
    }

    @Test func allDayMultiDayExclusiveMidnightEnd() {
        let r = n.normalize(event(start: "2026-11-17T00:00:00-08:00", end: "2026-11-19T00:00:00-08:00") { $0.isAllDay = true })
        #expect(r.allDayStart == "2026-11-17" && r.allDayEnd == "2026-11-19")
    }

    @Test func allDayZeroLengthBecomesOneDay() {
        let r = n.normalize(event(start: "2026-11-17T00:00:00-08:00", end: "2026-11-17T00:00:00-08:00") { $0.isAllDay = true })
        #expect(r.allDayStart == "2026-11-17" && r.allDayEnd == "2026-11-18")
    }

    @Test func allDayAcrossDSTEndIs25Hours() {
        // 1 Nov 2026: US clocks go back; the local day is 25 h long.
        let r = n.normalize(event(start: "2026-11-01T00:00:00-07:00", end: "2026-11-01T23:59:59-08:00") { $0.isAllDay = true })
        #expect(r.allDayStart == "2026-11-01" && r.allDayEnd == "2026-11-02")
        #expect(r.end.timeIntervalSince(r.start) == 25 * 3600)
    }

    @Test func allDayDependsOnTheNormalizersZone() {
        let tokyo = CalendarNormalizer(timeZone: TimeZone(identifier: "Asia/Tokyo")!)
        let r = tokyo.normalize(event(start: "2026-11-20T00:00:00+09:00", end: "2026-11-20T23:59:59+09:00") { $0.isAllDay = true })
        #expect(r.allDayStart == "2026-11-20")
        #expect(r.start == date("2026-11-19T15:00:00Z"))
    }

    @Test func calendarColorToHex() throws {
        let srgb = try #require(CGColorSpace(name: CGColorSpace.sRGB))
        let blue = try #require(CGColor(colorSpace: srgb, components: [0x3B / 255.0, 0x82 / 255.0, 0xF6 / 255.0, 1]))
        #expect(EventKitCalendarStore.hex(blue) == "#3B82F6")
        #expect(EventKitCalendarStore.hex(CGColor(gray: 1, alpha: 1)) == "#FFFFFF")
    }

    @Test func endBeforeStartIsClamped() {
        let r = n.normalize(event(start: "2026-11-16T18:00:00Z", end: "2026-11-16T17:00:00Z"))
        #expect(r.end == r.start)
    }

    @Test func rangeFilterAndSort() {
        let raws = [
            event("late", start: "2026-11-16T20:00:00Z", end: "2026-11-16T21:00:00Z"),
            event("b", start: "2026-11-16T17:00:00Z", end: "2026-11-16T18:00:00Z"),
            event("a", start: "2026-11-16T17:00:00Z", end: "2026-11-16T18:00:00Z"),
            event("short", start: "2026-11-16T17:00:00Z", end: "2026-11-16T17:30:00Z"),
            event("before", start: "2026-11-16T15:00:00Z", end: "2026-11-16T16:00:00Z"), // ends at `from`
            event("spans", start: "2026-11-16T15:00:00Z", end: "2026-11-16T16:30:00Z"),
            event("at-to", start: "2026-11-16T22:00:00Z", end: "2026-11-16T23:00:00Z"), // starts at `to`
            event("zero", start: "2026-11-16T16:00:00Z", end: "2026-11-16T16:00:00Z"),
        ]
        let out = n.normalize(raws, from: date("2026-11-16T16:00:00Z"), to: date("2026-11-16T22:00:00Z"))
        #expect(out.map(\.id) == ["eventkit:spans", "eventkit:zero", "eventkit:short", "eventkit:a", "eventkit:b", "eventkit:late"])
    }

    @Test func jsonShape() {
        let r = n.normalize(event("E9", start: "2026-11-16T17:00:00Z", end: "2026-11-16T17:30:00Z") { e in
            e.externalIdentifier = "uid9"
            e.title = "Say \"hi\""
            e.notes = "https://meet.google.com/abc-defg-hij"
            e.attendees = [RawParticipant(name: "Alex", email: "alex@oat.test", status: .pending, isCurrentUser: true)]
        })
        #expect(r.json.serialized() == """
        {"id":"eventkit:E9","source":"eventkit","calendar":{"id":"cal-work","title":"Work","color":"#3B82F6"},\
        "title":"Say \\"hi\\"","start":"2026-11-16T17:00:00.000Z","end":"2026-11-16T17:30:00.000Z","allDay":false,\
        "allDayStart":null,"allDayEnd":null,"timeZone":null,"location":null,"url":null,\
        "conferenceUrl":"https://meet.google.com/abc-defg-hij","conferenceProvider":"google_meet","status":"confirmed",\
        "attendees":[{"name":"Alex","email":"alex@oat.test","status":"needs_action","isSelf":true,"isOrganizer":false}],\
        "recurrenceId":null,"icalUid":"uid9"}
        """)
    }
}

// MARK: - Fixture store, runner, CLI

@Suite("calendar: fixture store and runner")
struct CalendarRunnerTests {
    @Test func weekFixtureParses() throws {
        let store = try FixtureCalendarStore(path: fixtureURL("week.json").path)
        #expect(store.authorization() == .fullAccess)
        #expect(store.timeZone == la)
        let raws = try store.events(from: .distantPast, to: .distantFuture)
        #expect(raws.count == 17)
        let offsite = try #require(raws.first { $0.eventIdentifier == "offsite" })
        #expect(offsite.start == date("2026-11-17T08:00:00Z"), "YYYY-MM-DD is midnight in the fixture zone")
    }

    @Test func weekEventsForTheWorkWeek() throws {
        let store = try FixtureCalendarStore(path: fixtureURL("week.json").path)
        let lines = try CalendarRunner.eventLines(
            store: store, options: CalendarOptions(from: .day(year: 2026, month: 11, day: 16), to: .day(year: 2026, month: 11, day: 20)))
        let ids = try lines.map { line -> String in
            let obj = try #require(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
            return try #require(obj["id"] as? String)
        }
        #expect(ids.first == "eventkit:release-window", "the event spanning midnight into Monday overlaps")
        #expect(!ids.contains("eventkit:saturday-hike"))
        #expect(ids.contains("eventkit:standup/2026-11-18T17:30:00.000Z"))
        #expect(ids.count == 16)
        let acme = try #require(lines.first { $0.contains("acme-call") })
        #expect(acme.contains(#""conferenceProvider":"teams""#))
        #expect(acme.contains(#""email":"alex@oat.test","status":"accepted","isSelf":true"#))
    }

    @Test func notAuthorizedNeverReadsEvents() {
        for auth in CalendarAuthorization.allCases where !auth.canRead {
            let store = MockStore(auth: auth, raws: [event()])
            #expect(throws: CalendarError.self) { try CalendarRunner.eventLines(store: store, options: CalendarOptions()) }
            #expect(store.queried.isEmpty)
        }
    }

    @Test func defaultWindowIsYesterdayToTwoWeeks() throws {
        let store = MockStore(raws: [event()])
        let now = date("2026-11-16T12:00:00Z")
        let lines = try CalendarRunner.eventLines(store: store, options: CalendarOptions(), now: now)
        #expect(lines.count == 1)
        #expect(store.queried.count == 1)
        #expect(store.queried[0].0 == date("2026-11-15T12:00:00Z"))
        #expect(store.queried[0].1 == date("2026-11-30T12:00:00Z"))
    }

    @Test func resolveRangeDays() throws {
        let r = try CalendarRunner.resolveRange(from: .day(year: 2026, month: 11, day: 16), to: .day(year: 2026, month: 11, day: 20),
                                                now: Date(), timeZone: la)
        #expect(r.from == date("2026-11-16T08:00:00Z"))
        #expect(r.to == date("2026-11-21T08:00:00Z"), "--to day is inclusive")
        let inst = try CalendarRunner.resolveRange(from: .instant(date("2026-11-16T00:00:00Z")), to: .instant(date("2026-11-16T01:00:00Z")),
                                                   now: Date(), timeZone: la)
        #expect(inst.to == date("2026-11-16T01:00:00Z"))
        // Only --from: the default span follows it.
        let onlyFrom = try CalendarRunner.resolveRange(from: .instant(date("2026-11-16T00:00:00Z")), to: nil, now: Date(), timeZone: la)
        #expect(onlyFrom.to == date("2026-12-01T00:00:00Z"))
    }

    @Test func resolveRangeRejectsBadRanges() {
        #expect(throws: CLIError.self) {
            try CalendarRunner.resolveRange(from: .day(year: 2026, month: 11, day: 20), to: .day(year: 2026, month: 11, day: 19), now: Date(), timeZone: la)
        }
        #expect(throws: CLIError.self) {
            try CalendarRunner.resolveRange(from: .day(year: 2020, month: 1, day: 1), to: .day(year: 2026, month: 1, day: 1), now: Date(), timeZone: la)
        }
    }

    @Test func statusJSONNeverPrompts() {
        #expect(CalendarRunner.statusJSON(.notDetermined, source: "eventkit").serialized()
            == #"{"status":"not_determined","canRead":false,"source":"eventkit","prompted":false}"#)
        #expect(CalendarRunner.watchLine("ready", source: "fixture") == #"{"type":"ready","source":"fixture"}"#)
        #expect(CalendarRunner.watchLine("changed") == #"{"type":"changed"}"#)
    }

    @Test func fixtureErrors() {
        func parse(_ json: String) throws { _ = try FixtureCalendarStore(data: Data(json.utf8)) }
        #expect(throws: CalendarError.self) { try parse("not json") }
        #expect(throws: CalendarError.self) { try parse(#"{"events":[{"calendarId":"x","start":"2026-11-16","end":"2026-11-17"}]}"#) }
        #expect(throws: CalendarError.self) {
            try parse(#"{"calendars":[{"id":"x","title":"X"}],"events":[{"calendarId":"x","start":"16/11/2026","end":"2026-11-17"}]}"#)
        }
        #expect(throws: CalendarError.self) { try parse(#"{"timeZone":"Mars/Olympus","events":[]}"#) }
        #expect(throws: CalendarError.self) { try parse(#"{"authorization":"maybe","events":[]}"#) }
        #expect(throws: CalendarError.self) { _ = try FixtureCalendarStore(path: "/nonexistent/oat-fixture.json") }
    }

    @Test func fixtureAuthorizationAndDefaults() throws {
        let s = try FixtureCalendarStore(data: Data(#"""
        {"authorization":"denied","calendars":[{"id":"c","title":"C"}],
         "events":[{"calendarId":"c","start":"2026-11-16T10:00:00Z","end":"2026-11-16T11:00:00Z",
                    "attendees":[{"email":"a@b.test","self":true}]}]}
        """#.utf8))
        #expect(s.authorization() == .denied)
        let e = try #require(try s.events(from: .distantPast, to: .distantFuture).first)
        #expect(e.status == .confirmed && !e.isAllDay && e.eventIdentifier == nil)
        #expect(e.attendees == [RawParticipant(name: nil, url: "mailto:a@b.test", status: .unknown, type: .person, isCurrentUser: true)])
    }

    @Test func dayParsing() {
        #expect(CalendarDates.parseDay("2026-11-16") == DateComponents(year: 2026, month: 11, day: 16))
        #expect(CalendarDates.parseDay("2026-02-31") == nil)
        #expect(CalendarDates.parseDay("2026-1-16") == nil)
        #expect(CalendarDates.parseDay("16-11-2026") == nil)
        #expect(CalendarDates.parseInstant("2026-11-16T09:00:00+05:30") == date("2026-11-16T03:30:00Z"))
        #expect(CalendarDates.parseInstant("2026-11-16") == nil)
    }
}

@Suite("calendar: CLI")
struct CalendarCLITests {
    @Test func subcommands() throws {
        #expect(try CLI.parse(["calendar", "status"]) == .calendar(.status(fixture: nil)))
        #expect(try CLI.parse(["calendar", "status", "--fixture", "f.json"]) == .calendar(.status(fixture: "f.json")))
        #expect(try CLI.parse(["calendar", "request-access"]) == .calendar(.requestAccess))
        #expect(try CLI.parse(["calendar", "events"]) == .calendar(.events(CalendarOptions())))
        #expect(try CLI.parse(["calendar", "watch", "--debounce-ms=250", "--fixture", "w.json"])
            == .calendar(.watch(CalendarOptions(fixture: "w.json", debounceMs: 250))))
    }

    @Test func eventsRange() throws {
        let cmd = try CLI.parse(["calendar", "events", "--from", "2026-11-16", "--to=2026-11-20T17:00:00Z", "--fixture", "x.json"])
        #expect(cmd == .calendar(.events(CalendarOptions(
            fixture: "x.json", from: .day(year: 2026, month: 11, day: 16), to: .instant(date("2026-11-20T17:00:00Z"))))))
    }

    @Test func errors() {
        for args in [
            ["calendar"],
            ["calendar", "nope"],
            ["calendar", "status", "--from", "2026-11-16"], // option not valid for status
            ["calendar", "request-access", "--fixture", "x.json"], // never fixture-able: it is the prompt
            ["calendar", "events", "--from"],
            ["calendar", "events", "--from", "yesterday"],
            ["calendar", "events", "--to", "2026-11-16T09:00:00"], // no zone
            ["calendar", "events", "--fixture", ""],
            ["calendar", "events", "--debounce-ms", "5"],
            ["calendar", "watch", "--debounce-ms", "-1"],
            ["calendar", "watch", "--debounce-ms", "60001"],
            ["calendar", "watch", "extra"],
        ] {
            #expect(throws: CLIError.self, "\(args)") { try CLI.parse(args) }
        }
    }
}

// MARK: - Watching

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func bump() { lock.lock(); n += 1; lock.unlock() }
    var value: Int { lock.lock(); defer { lock.unlock() }; return n }
}

private func waitUntil(timeout: Double = 3, _ check: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while !check() {
        if Date() > deadline { return }
        try await Task.sleep(for: .milliseconds(10))
    }
}

@Suite("calendar: watch")
struct CalendarWatchTests {
    @Test func debounceCoalescesABurst() async throws {
        let c = Counter()
        // Delay well above the 10 ms signal gap: a loaded CI VM can oversleep a 10 ms sleep past 80 ms.
        let d = Debouncer(delay: 0.3) { c.bump() }
        for _ in 0..<5 {
            d.signal()
            try await Task.sleep(for: .milliseconds(10))
        }
        try await Task.sleep(for: .milliseconds(700))
        #expect(c.value == 1)
        d.signal()
        try await waitUntil { c.value == 2 }
        #expect(c.value == 2, "a later change fires again")
    }

    @Test func debounceMaxWaitBoundsAConstantStream() async throws {
        let c = Counter()
        let d = Debouncer(delay: 0.1, maxWait: 0.2) { c.bump() }
        let t0 = Date()
        while Date().timeIntervalSince(t0) < 0.5 {
            d.signal()
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(c.value >= 1, "fired despite signals every 20 ms")
        d.cancel()
    }

    @Test func debounceCancel() async throws {
        let c = Counter()
        let d = Debouncer(delay: 0.05) { c.bump() }
        d.signal()
        d.cancel()
        try await Task.sleep(for: .milliseconds(150))
        #expect(c.value == 0)
    }

    @Test func fixtureFileChangesAreObserved() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("oat-cal-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("cal.json")
        let body = #"{"calendars":[{"id":"c","title":"C"}],"events":[]}"#
        try Data(body.utf8).write(to: file)

        let store = try FixtureCalendarStore(path: file.path)
        let c = Counter()
        try store.observeChanges { c.bump() }

        // In-place write.
        let h = try FileHandle(forWritingTo: file)
        try h.seekToEnd()
        try h.write(contentsOf: Data(" ".utf8))
        try h.close()
        try await waitUntil { c.value >= 1 }
        #expect(c.value >= 1)

        // Atomic replace (rename over the file) — the watcher re-opens the new file and keeps going.
        let before = c.value
        try Data(body.utf8).write(to: file, options: .atomic)
        try await waitUntil { c.value > before }
        #expect(c.value > before)
        try await Task.sleep(for: .milliseconds(150)) // let the re-open settle
        let afterReplace = c.value
        try Data((body + "\n").utf8).write(to: file, options: .atomic)
        try await waitUntil { c.value > afterReplace }
        #expect(c.value > afterReplace, "still watching after a replace")
    }
}
