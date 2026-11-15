import Foundation
import Testing
@testable import OatAudioCore

// `mic-apps` tests. Nothing here touches Core Audio: the provider is injected (fixture timelines or a stub);
// only the pure path helpers of `CoreAudioMicAppsProvider` are exercised.

/// Repo-root `fixtures/detection/…` (shared with the TypeScript tests).
private func detectionFixture(_ name: String) -> String {
    URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // OatAudioCoreTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // oat-audio
        .deletingLastPathComponent() // native
        .deletingLastPathComponent() // repo root
        .appendingPathComponent("fixtures/detection/\(name)").path
}

private final class Clock: @unchecked Sendable {
    var ms = 0
}

private final class StubProvider: MicAppsProvider, @unchecked Sendable {
    var results: [Result<[MicAppProcess], Error>]
    init(_ results: [Result<[MicAppProcess], Error>]) { self.results = results }
    func snapshot() throws -> [MicAppProcess] { try results.removeFirst().get() }
}

private let zoom = MicAppProcess(pid: 501, bundleId: "us.zoom.xos")
private let memos = MicAppProcess(pid: 300, bundleId: "com.apple.VoiceMemos")
private let chrome = MicAppProcess(pid: 700, bundleId: "com.google.Chrome.helper", appBundleId: "com.google.Chrome")

@Suite("mic-apps")
struct MicAppsTests {
    @Test func parsesCommands() throws {
        #expect(try CLI.parse(["mic-apps", "list"]) == .micApps(.list(MicAppsOptions())))
        #expect(try CLI.parse(["mic-apps", "list", "--fixture", "t.json"])
            == .micApps(.list(MicAppsOptions(fixture: "t.json"))))
        #expect(try CLI.parse(["mic-apps", "watch", "--interval-ms=250", "--fixture=t.json"])
            == .micApps(.watch(MicAppsOptions(fixture: "t.json", intervalMs: 250))))
        #expect(try CLI.parse(["mic-apps", "watch"]) == .micApps(.watch(MicAppsOptions(intervalMs: 1000))))
    }

    @Test func rejectsBadArguments() {
        for args in [
            ["mic-apps"],
            ["mic-apps", "stream"],
            ["mic-apps", "list", "--interval-ms", "100"], // watch only
            ["mic-apps", "watch", "--interval-ms", "5"],
            ["mic-apps", "watch", "--interval-ms", "fast"],
            ["mic-apps", "watch", "--fixture"],
            ["mic-apps", "watch", "--fixture", ""],
            ["mic-apps", "watch", "--verbose"],
        ] {
            #expect(throws: CLIError.self, "\(args)") { try CLI.parse(args) }
        }
    }

    @Test func usageMentionsMicApps() {
        #expect(CLI.usage.contains("mic-apps watch"))
    }

    @Test func processJSON() {
        #expect(zoom.json.serialized() == #"{"pid":501,"bundleId":"us.zoom.xos","appBundleId":null}"#)
        #expect(chrome.json.serialized()
            == #"{"pid":700,"bundleId":"com.google.Chrome.helper","appBundleId":"com.google.Chrome"}"#)
        // appBundleId equal to bundleId carries no information and is dropped.
        #expect(MicAppProcess(pid: 1, bundleId: "a", appBundleId: "a").appBundleId == nil)
        #expect(MicAppProcess(pid: 2, bundleId: nil).json.serialized() == #"{"pid":2,"bundleId":null,"appBundleId":null}"#)
    }

    @Test func lines() {
        #expect(MicAppsRunner.readyLine(source: "fixture", intervalMs: 50)
            == #"{"type":"ready","source":"fixture","intervalMs":50}"#)
        #expect(MicAppsRunner.appsLine([]) == #"{"type":"apps","apps":[]}"#)
        #expect(MicAppsRunner.errorLine(code: "poll_failed", message: "x\"y")
            == #"{"type":"error","code":"poll_failed","message":"x\"y"}"#)
    }

    @Test func differReportsFirstAndChangesOnly() {
        var d = MicAppsDiffer()
        #expect(d.update([]) == [])
        #expect(d.update([]) == nil)
        #expect(d.update([zoom, memos]) == [memos, zoom]) // sorted by pid
        #expect(d.update([memos, zoom, zoom]) == nil) // order and duplicates don't matter
        #expect(d.update([zoom]) == [zoom])
        #expect(d.update([MicAppProcess(pid: 501, bundleId: "us.zoom.xos", appBundleId: "x")]) != nil)
    }

    @Test func pollerEmitsChangesAndOneErrorPerFailureRun() {
        struct Boom: Error, CustomStringConvertible { var description: String { "HAL busy" } }
        let stub = StubProvider([.success([]), .success([]), .failure(Boom()), .failure(Boom()),
                                 .success([zoom]), .failure(Boom())])
        var poller = MicAppsRunner.Poller(provider: stub)
        #expect(poller.poll() == [#"{"type":"apps","apps":[]}"#])
        #expect(poller.poll() == [])
        #expect(poller.poll() == [#"{"type":"error","code":"poll_failed","message":"HAL busy"}"#])
        #expect(poller.poll() == [])
        #expect(poller.poll() == [MicAppsRunner.appsLine([zoom])])
        #expect(poller.poll().count == 1)
    }

    @Test func fixtureReplaysTimelineByElapsedTime() throws {
        let clock = Clock()
        let p = try FixtureMicAppsProvider(path: detectionFixture("sidecar-replay.json"), elapsedMs: { clock.ms })
        #expect(p.durationMs == 3400)
        var poller = MicAppsRunner.Poller(provider: p)
        var out: [String] = []
        // Poll every 100 ms through the timeline, like `watch --interval-ms 100`.
        for t in stride(from: 0, through: 4000, by: 100) {
            clock.ms = t
            out += poller.poll()
        }
        #expect(out == [
            MicAppsRunner.appsLine([]),
            MicAppsRunner.appsLine([memos, zoom]),
            MicAppsRunner.appsLine([memos, zoom, chrome]),
            MicAppsRunner.appsLine([]),
        ])
    }

    @Test func fixtureIgnoresNonMicSteps() throws {
        // Every shared detection fixture parses; steps without micApps (calendar, recording, …) are skipped.
        let dir = URL(fileURLWithPath: detectionFixture(""))
        let files = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".json") }
        #expect(files.count >= 10)
        for f in files {
            let p = try FixtureMicAppsProvider(path: dir.appendingPathComponent(f).path, elapsedMs: { 0 })
            #expect(!p.steps.isEmpty, "\(f)")
        }
        let calendar = try FixtureMicAppsProvider(path: detectionFixture("browser-calendar.json"), elapsedMs: { 0 })
        #expect(calendar.steps.map(\.atMs) == [60000, 600000, 700000, 2000000])
        #expect(try calendar.snapshot() == []) // before the first micApps step
    }

    @Test func fixtureErrors() {
        #expect(throws: MicAppsError.self) { try FixtureMicAppsProvider(path: "/nonexistent/oat.json") }
        #expect(throws: MicAppsError.self) { try FixtureMicAppsProvider(data: Data("{".utf8)) }
        #expect(throws: MicAppsError.self) {
            try FixtureMicAppsProvider(data: Data(#"{"steps":[{"at":5,"micApps":[]},{"at":4,"micApps":[]}]}"#.utf8))
        }
        #expect(throws: MicAppsError.self) {
            try FixtureMicAppsProvider(data: Data(#"{"steps":[{"at":0,"micApps":[{"bundleId":"x"}]}]}"#.utf8))
        }
    }

    @Test func outermostAppPath() {
        let helper = "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper"
        #expect(CoreAudioMicAppsProvider.outermostAppPath(helper) == "/Applications/Google Chrome.app")
        #expect(CoreAudioMicAppsProvider.outermostAppPath("/usr/libexec/avconferenced") == nil)
        #expect(CoreAudioMicAppsProvider.outermostAppBundleId("/nonexistent/Foo.app/Contents/MacOS/Foo") == nil)
    }
}
