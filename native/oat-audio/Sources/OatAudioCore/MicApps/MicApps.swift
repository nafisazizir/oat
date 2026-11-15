import Foundation

// `mic-apps` subcommands (task 7.2, D-21, PROTOCOL.md → "Mic apps"): which processes are running audio input
// right now, read from Core Audio process objects. The sidecar only reports processes; deciding which of them
// are meeting apps (allowlist, helper → parent mapping, debounce, prompts) is `@oat/detection` on the Node side.

/// One process that is running audio input (`kAudioProcessPropertyIsRunningInput` = 1).
public struct MicAppProcess: Sendable, Equatable, Hashable, Comparable {
    public var pid: Int32
    /// `kAudioProcessPropertyBundleID` (the process's own bundle, e.g. a browser helper's). Nil when unknown.
    public var bundleId: String?
    /// Bundle id of the outermost `.app` containing the executable (e.g. the browser for a helper app), when
    /// it differs from `bundleId`. Nil when unknown or the same.
    public var appBundleId: String?

    public init(pid: Int32, bundleId: String?, appBundleId: String? = nil) {
        self.pid = pid
        self.bundleId = bundleId
        self.appBundleId = appBundleId == bundleId ? nil : appBundleId
    }

    public static func < (a: MicAppProcess, b: MicAppProcess) -> Bool {
        if a.pid != b.pid { return a.pid < b.pid }
        return (a.bundleId ?? "", a.appBundleId ?? "") < (b.bundleId ?? "", b.appBundleId ?? "")
    }

    public var json: JSONValue {
        .object([
            ("pid", .int(Int(pid))),
            ("bundleId", bundleId.map(JSONValue.string) ?? .null),
            ("appBundleId", appBundleId.map(JSONValue.string) ?? .null),
        ])
    }
}

/// Where mic-using processes come from: Core Audio in real use, a scripted timeline for `--fixture` and tests.
/// Implementations never prompt for any permission.
public protocol MicAppsProvider: AnyObject {
    /// Processes running audio input now, in any order (the runner sorts and de-duplicates).
    func snapshot() throws -> [MicAppProcess]
}

public struct MicAppsError: Error, Equatable, CustomStringConvertible {
    public enum Kind: Sendable, Equatable { case fixture, coreAudio }
    public let kind: Kind
    public let message: String
    public init(_ kind: Kind, _ message: String) {
        self.kind = kind
        self.message = message
    }

    public var description: String { message }
}

// MARK: - Fixture provider

/// Replays the `steps[].micApps` of a detection timeline fixture (`fixtures/detection/*.json`, PROTOCOL.md →
/// "Mic-apps fixtures"): `snapshot()` returns the apps of the last step whose `at` (ms since start) has
/// passed. Steps without `micApps` (recording, calendar, … used by the Node tests) are ignored. Before the
/// first `micApps` step the list is empty.
public final class FixtureMicAppsProvider: MicAppsProvider, @unchecked Sendable {
    public struct Step: Sendable, Equatable {
        public var atMs: Int
        public var apps: [MicAppProcess]
    }

    public let steps: [Step]
    private let elapsedMs: @Sendable () -> Int

    /// `elapsedMs`: time since the replay started (default: a monotonic clock started now).
    public convenience init(path: String, elapsedMs: (@Sendable () -> Int)? = nil) throws {
        guard let data = FileManager.default.contents(atPath: path) else {
            throw MicAppsError(.fixture, "cannot read fixture \(path)")
        }
        try self.init(data: data, elapsedMs: elapsedMs)
    }

    public init(data: Data, elapsedMs: (@Sendable () -> Int)? = nil) throws {
        steps = try Self.parse(data)
        if let elapsedMs {
            self.elapsedMs = elapsedMs
        } else {
            let start = DispatchTime.now().uptimeNanoseconds
            self.elapsedMs = { Int((DispatchTime.now().uptimeNanoseconds - start) / 1_000_000) }
        }
    }

    /// Time of the last step (ms).
    public var durationMs: Int { steps.last?.atMs ?? 0 }

    public func snapshot() throws -> [MicAppProcess] {
        let now = elapsedMs()
        return steps.last(where: { $0.atMs <= now })?.apps ?? []
    }

    struct File: Decodable {
        var steps: [RawStep]
    }

    struct RawStep: Decodable {
        var at: Int
        var micApps: [RawApp]?
    }

    struct RawApp: Decodable {
        var pid: Int32
        var bundleId: String?
        var appBundleId: String?
    }

    static func parse(_ data: Data) throws -> [Step] {
        let file: File
        do {
            file = try JSONDecoder().decode(File.self, from: data)
        } catch {
            throw MicAppsError(.fixture, "invalid fixture: \(error)")
        }
        var last = Int.min
        var steps: [Step] = []
        for (i, s) in file.steps.enumerated() {
            guard s.at >= 0, s.at >= last else {
                throw MicAppsError(.fixture, "steps[\(i)].at must be >= 0 and non-decreasing, got \(s.at)")
            }
            last = s.at
            guard let apps = s.micApps else { continue }
            steps.append(Step(atMs: s.at, apps: apps.map {
                MicAppProcess(pid: $0.pid, bundleId: $0.bundleId, appBundleId: $0.appBundleId)
            }))
        }
        return steps
    }
}

// MARK: - Change detection

/// Turns successive snapshots into "changed" notifications: the list is normalised (sorted by pid, duplicates
/// dropped) and reported the first time and whenever it differs from the last reported one.
public struct MicAppsDiffer: Sendable {
    public private(set) var last: [MicAppProcess]?

    public init() {}

    public static func normalize(_ apps: [MicAppProcess]) -> [MicAppProcess] {
        Array(Set(apps)).sorted()
    }

    /// The normalised list if it changed (always on the first call), else nil.
    public mutating func update(_ apps: [MicAppProcess]) -> [MicAppProcess]? {
        let n = Self.normalize(apps)
        if n == last { return nil }
        last = n
        return n
    }
}

/// The testable part of `mic-apps list` / `watch` (main.swift wires stdout, the timer, signals and stdin).
public enum MicAppsRunner {
    public static func appsLine(_ apps: [MicAppProcess]) -> String {
        JSONValue.object([
            ("type", .string("apps")),
            ("apps", .array(apps.map(\.json))),
        ]).serialized()
    }

    public static func readyLine(source: String, intervalMs: Int) -> String {
        JSONValue.object([
            ("type", .string("ready")),
            ("source", .string(source)),
            ("intervalMs", .int(intervalMs)),
        ]).serialized()
    }

    public static func errorLine(code: String, message: String) -> String {
        JSONValue.object([
            ("type", .string("error")),
            ("code", .string(code)),
            ("message", .string(message)),
        ]).serialized()
    }

    /// One poll of `watch`: the lines to print (an `apps` line on change; an `error` line when a poll fails,
    /// once until a poll succeeds again).
    public struct Poller {
        public let provider: MicAppsProvider
        public private(set) var differ = MicAppsDiffer()
        private var failing = false

        public init(provider: MicAppsProvider) { self.provider = provider }

        public mutating func poll() -> [String] {
            do {
                let apps = try provider.snapshot()
                failing = false
                return differ.update(apps).map { [MicAppsRunner.appsLine($0)] } ?? []
            } catch {
                defer { failing = true }
                return failing ? [] : [MicAppsRunner.errorLine(code: "poll_failed", message: "\(error)")]
            }
        }
    }
}

// MARK: - CLI

public struct MicAppsOptions: Equatable, Sendable {
    /// Replay `steps[].micApps` of this timeline file instead of reading Core Audio.
    public var fixture: String?
    /// `watch` only: poll interval.
    public var intervalMs = 1000

    public init(fixture: String? = nil, intervalMs: Int = 1000) {
        self.fixture = fixture
        self.intervalMs = intervalMs
    }
}

public enum MicAppsCommand: Equatable, Sendable {
    case list(MicAppsOptions)
    case watch(MicAppsOptions)
}

extension CLI {
    static func parseMicApps(_ input: [String]) throws -> MicAppsCommand {
        guard let sub = input.first else { throw CLIError("mic-apps: missing subcommand (list, watch)") }
        guard sub == "list" || sub == "watch" else { throw CLIError("mic-apps: unknown subcommand \"\(sub)\"") }
        var args: [String] = []
        for a in input.dropFirst() {
            if a.hasPrefix("--"), let eq = a.firstIndex(of: "=") {
                args.append(String(a[..<eq]))
                args.append(String(a[a.index(after: eq)...]))
            } else {
                args.append(a)
            }
        }
        var opts = MicAppsOptions()
        var i = 0
        func value(_ name: String) throws -> String {
            i += 1
            guard i < args.count else { throw CLIError("\(name) needs a value") }
            return args[i]
        }
        while i < args.count {
            let arg = args[i]
            switch arg {
            case "--fixture":
                let v = try value(arg)
                guard !v.isEmpty else { throw CLIError("--fixture needs a file path") }
                opts.fixture = v
            case "--interval-ms" where sub == "watch":
                let raw = try value(arg)
                guard let v = Int(raw), (10...60_000).contains(v) else {
                    throw CLIError("--interval-ms must be an integer in 10...60000, got \"\(raw)\"")
                }
                opts.intervalMs = v
            default:
                throw CLIError("mic-apps \(sub): unknown option \"\(arg)\"")
            }
            i += 1
        }
        return sub == "list" ? .list(opts) : .watch(opts)
    }
}
