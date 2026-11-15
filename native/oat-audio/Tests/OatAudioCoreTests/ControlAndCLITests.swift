import Foundation
import Testing
@testable import OatAudioCore

@Suite("stdin control commands")
struct ControlTests {
    @Test func parsesCommands() throws {
        #expect(try ControlCommand.parse(line: #"{"cmd":"pause"}"#) == .pause)
        #expect(try ControlCommand.parse(line: #"  {"cmd": "resume"}  "#) == .resume)
        #expect(try ControlCommand.parse(line: #"{"cmd":"stop","why":"user"}"#) == .stop)
        #expect(try ControlCommand.parse(line: "") == nil)
        #expect(try ControlCommand.parse(line: "   \r") == nil)
    }

    @Test func rejectsBadLines() {
        #expect(throws: ControlParseError.unknownCmd("explode")) { try ControlCommand.parse(line: #"{"cmd":"explode"}"#) }
        #expect(throws: ControlParseError.missingCmd) { try ControlCommand.parse(line: #"{"command":"stop"}"#) }
        #expect(throws: ControlParseError.missingCmd) { try ControlCommand.parse(line: #"{"cmd":1}"#) }
        #expect(throws: ControlParseError.notJSONObject) { try ControlCommand.parse(line: "stop") }
        #expect(throws: ControlParseError.notJSONObject) { try ControlCommand.parse(line: #"["stop"]"#) }
    }

    @Test func lineSplitterAcrossChunks() {
        var s = LineSplitter()
        #expect(s.feed(Data(#"{"cmd":"pa"#.utf8)).isEmpty)
        #expect(s.feed(Data("use\"}\r\n{\"cmd\":\"resume\"}\n{\"cmd\"".utf8)) == [#"{"cmd":"pause"}"#, #"{"cmd":"resume"}"#])
        #expect(s.finish() == #"{"cmd""#)
        #expect(s.finish() == nil)
    }

    @Test func lineSplitterDropsOverlongLines() {
        var s = LineSplitter(maxLineLength: 8)
        #expect(s.feed(Data("0123456789abcdef\nok\n".utf8)) == ["ok"])
    }

    @Test func stdinModeForDevNullIsIgnore() throws {
        let fd = open("/dev/null", O_RDONLY)
        defer { close(fd) }
        #expect(StdinMode.detect(fd: fd) == .ignore)
        var fds: [Int32] = [0, 0]
        #expect(pipe(&fds) == 0)
        defer { close(fds[0]); close(fds[1]) }
        #expect(StdinMode.detect(fd: fds[0]) == .commandsStopOnEOF)
    }
}

@Suite("CLI arguments")
struct CLITests {
    @Test func defaultsCaptureBothSources() throws {
        guard case .capture(let o) = try CLI.parse(["capture"]) else { Issue.record("not capture"); return }
        #expect(o.sources == [.mic, .system])
        #expect(o.sampleRate == 16000)
        #expect(o.frameMs == 50)
        #expect(!o.synthetic)
        #expect(o.durationSeconds == nil)
        #expect(o.aec, "echo cancellation is on by default")
    }

    @Test func noAecFlagDisablesEchoCancellation() throws {
        guard case .capture(let o) = try CLI.parse(["capture", "--mic", "--no-aec"]) else { Issue.record("not capture"); return }
        #expect(!o.aec)
        #expect(o.sources == [.mic])
    }

    @Test func flagsSelectSources() throws {
        guard case .capture(let o) = try CLI.parse(["capture", "--system", "--synthetic", "--duration", "2.5",
                                                    "--sample-rate=24000", "--exclude-pid", "42"])
        else { Issue.record("not capture"); return }
        #expect(o.sources == [.system])
        #expect(o.synthetic)
        #expect(o.durationSeconds == 2.5)
        #expect(o.sampleRate == 24000)
        #expect(o.excludePIDs == [42])
    }

    @Test func otherCommands() throws {
        #expect(try CLI.parse(["version"]) == .version)
        #expect(try CLI.parse(["permissions"]) == .permissions)
        #expect(try CLI.parse([]) == .help)
    }

    @Test func rejectsBadInput() {
        #expect(throws: CLIError.self) { try CLI.parse(["capture", "--duration", "-1"]) }
        #expect(throws: CLIError.self) { try CLI.parse(["capture", "--sample-rate", "abc"]) }
        #expect(throws: CLIError.self) { try CLI.parse(["capture", "--frame-ms", "500"]) }
        #expect(throws: CLIError.self) { try CLI.parse(["capture", "--loud"]) }
        #expect(throws: CLIError.self) { try CLI.parse(["capture", "--duration"]) }
        #expect(throws: CLIError.self) { try CLI.parse(["record"]) }
        #expect(throws: CLIError.self) { try CLI.parse(["version", "extra"]) }
    }
}
