import Foundation

/// A `--from` / `--to` value: an instant, or a calendar day resolved in the store's zone.
public enum CalendarDateArg: Equatable, Sendable {
    case instant(Date)
    /// `YYYY-MM-DD`: `--from` = that day's midnight, `--to` = the next midnight (the day is included).
    case day(year: Int, month: Int, day: Int)
}

public struct CalendarOptions: Equatable, Sendable {
    /// Serve events from this JSON file instead of EventKit (no permission needed).
    public var fixture: String?
    public var from: CalendarDateArg?
    public var to: CalendarDateArg?
    /// `watch` only: quiet period before reporting a burst of store changes.
    public var debounceMs = 500

    public init(fixture: String? = nil, from: CalendarDateArg? = nil, to: CalendarDateArg? = nil,
                debounceMs: Int = 500)
    {
        self.fixture = fixture
        self.from = from
        self.to = to
        self.debounceMs = debounceMs
    }
}

public enum CalendarCommand: Equatable, Sendable {
    case status(fixture: String?)
    case requestAccess
    case events(CalendarOptions)
    case watch(CalendarOptions)
}

extension CLI {
    static func parseCalendar(_ args: [String]) throws -> CalendarCommand {
        guard let sub = args.first else { throw CLIError("calendar: missing subcommand (status, request-access, events, watch)") }
        let rest = Array(args.dropFirst())
        switch sub {
        case "status":
            let o = try parseCalendarOptions(rest, sub, allowed: ["--fixture"])
            return .status(fixture: o.fixture)
        case "request-access":
            try expectNoArgs(rest, "calendar request-access")
            return .requestAccess
        case "events":
            return .events(try parseCalendarOptions(rest, sub, allowed: ["--fixture", "--from", "--to"]))
        case "watch":
            return .watch(try parseCalendarOptions(rest, sub, allowed: ["--fixture", "--debounce-ms"]))
        default:
            throw CLIError("calendar: unknown subcommand \"\(sub)\"")
        }
    }

    static func parseCalendarOptions(_ input: [String], _ sub: String, allowed: Set<String>) throws -> CalendarOptions {
        // Expand --flag=value.
        var args: [String] = []
        for a in input {
            if a.hasPrefix("--"), let eq = a.firstIndex(of: "=") {
                args.append(String(a[..<eq]))
                args.append(String(a[a.index(after: eq)...]))
            } else {
                args.append(a)
            }
        }
        var opts = CalendarOptions()
        var i = 0
        func value(_ name: String) throws -> String {
            i += 1
            guard i < args.count else { throw CLIError("\(name) needs a value") }
            return args[i]
        }
        while i < args.count {
            let arg = args[i]
            guard allowed.contains(arg) else { throw CLIError("calendar \(sub): unknown option \"\(arg)\"") }
            switch arg {
            case "--fixture":
                let v = try value(arg)
                guard !v.isEmpty else { throw CLIError("--fixture needs a file path") }
                opts.fixture = v
            case "--from": opts.from = try parseDateArg(try value(arg), arg)
            case "--to": opts.to = try parseDateArg(try value(arg), arg)
            case "--debounce-ms":
                let raw = try value(arg)
                guard let v = Int(raw), (0...60_000).contains(v) else {
                    throw CLIError("--debounce-ms must be an integer in 0...60000, got \"\(raw)\"")
                }
                opts.debounceMs = v
            default:
                throw CLIError("calendar \(sub): unknown option \"\(arg)\"")
            }
            i += 1
        }
        return opts
    }

    static func parseDateArg(_ s: String, _ name: String) throws -> CalendarDateArg {
        if let d = CalendarDates.parseInstant(s) { return .instant(d) }
        if let c = CalendarDates.parseDay(s), let y = c.year, let m = c.month, let d = c.day {
            return .day(year: y, month: m, day: d)
        }
        throw CLIError("\(name) must be an ISO 8601 date-time with zone (2026-11-16T09:00:00Z) or a day (2026-11-16), got \"\(s)\"")
    }
}

/// The testable part of the `calendar` subcommands (main.swift only wires stdout, signals and stdin).
public enum CalendarRunner {
    /// Default window when `--from` / `--to` are omitted: 24 h back, 14 days ahead.
    public static let defaultPast: TimeInterval = 24 * 3600
    public static let defaultFuture: TimeInterval = 14 * 24 * 3600
    /// EventKit silently truncates predicates longer than four years; we refuse instead.
    public static let maxSpan: TimeInterval = 4 * 365 * 24 * 3600

    public static func statusJSON(_ auth: CalendarAuthorization, source: String) -> JSONValue {
        .object([
            ("status", .string(auth.rawValue)),
            ("canRead", .bool(auth.canRead)),
            ("source", .string(source)),
            ("prompted", .bool(false)),
        ])
    }

    public static func resolveRange(from: CalendarDateArg?, to: CalendarDateArg?, now: Date,
                                    timeZone: TimeZone) throws -> (from: Date, to: Date)
    {
        func resolve(_ arg: CalendarDateArg, isEnd: Bool) -> Date {
            switch arg {
            case .instant(let d): return d
            case let .day(y, m, d):
                let day = DateComponents(year: y, month: m, day: d)
                let start = CalendarDates.startOfDay(day, in: timeZone)!
                guard isEnd else { return start }
                var cal = Calendar(identifier: .gregorian)
                cal.timeZone = timeZone
                return cal.date(byAdding: .day, value: 1, to: start)!
            }
        }
        let f = from.map { resolve($0, isEnd: false) } ?? now.addingTimeInterval(-defaultPast)
        let t = to.map { resolve($0, isEnd: true) } ?? f.addingTimeInterval(defaultPast + defaultFuture)
        guard f < t else { throw CLIError("--from must be before --to") }
        guard t.timeIntervalSince(f) <= maxSpan else { throw CLIError("--from … --to may span at most 4 years") }
        return (f, t)
    }

    /// One normalised event JSON object per line, sorted by start. Throws `.notAuthorized` without full access.
    public static func eventLines(store: CalendarEventStore, options: CalendarOptions, now: Date = Date(),
                                  source: String = "eventkit") throws -> [String]
    {
        let auth = store.authorization()
        guard auth.canRead else {
            throw CalendarError(.notAuthorized, "calendar access is \(auth.rawValue); run `oat-audio calendar request-access` (prompts)")
        }
        let range = try resolveRange(from: options.from, to: options.to, now: now, timeZone: store.timeZone)
        let raws = try store.events(from: range.from, to: range.to)
        let normalizer = CalendarNormalizer(timeZone: store.timeZone, source: source)
        return normalizer.normalize(raws, from: range.from, to: range.to).map { $0.json.serialized() }
    }

    public static func watchLine(_ type: String, source: String? = nil) -> String {
        var pairs: [(String, JSONValue)] = [("type", .string(type))]
        if let source { pairs.append(("source", .string(source))) }
        return JSONValue.object(pairs).serialized()
    }
}
