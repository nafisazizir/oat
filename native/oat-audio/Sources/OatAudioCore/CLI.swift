import Foundation

public struct CaptureOptions: Equatable, Sendable {
    public var mic = true
    public var system = true
    public var sampleRate = 16_000
    public var frameMs = 50
    public var synthetic = false
    /// Acoustic echo cancellation on the mic via Apple voice processing (VPIO). On by default; `--no-aec`
    /// turns it off (e.g. on headphones, where there is no echo and VPIO's processing only costs fidelity).
    public var aec = true
    /// Stop automatically after this many seconds (nil = until stop / EOF / signal).
    public var durationSeconds: Double?
    /// Extra PIDs to exclude from the system-audio tap (e.g. the Electron app's own playback).
    public var excludePIDs: [Int32] = []

    public init() {}

    public var sources: [SourceID] {
        (mic ? [SourceID.mic] : []) + (system ? [SourceID.system] : [])
    }
}

public enum CLICommand: Equatable, Sendable {
    case capture(CaptureOptions)
    case permissions
    case version
    case help
}

public struct CLIError: Error, Equatable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

public enum CLI {
    public static let usage = """
    usage:
      oat-audio capture [--mic] [--system] [--sample-rate <hz>] [--frame-ms <ms>]
                        [--synthetic] [--duration <seconds>] [--exclude-pid <pid>]... [--no-aec]
          Capture mic and/or system audio (default: both) and write framed PCM to stdout
          (see PROTOCOL.md). Control via stdin: {"cmd":"pause"|"resume"|"stop"}; EOF on a stdin
          pipe = stop. --synthetic generates deterministic test tones and needs no permissions.
          Mic echo cancellation (Apple voice processing) is on by default; --no-aec disables it.
      oat-audio permissions   Print microphone / system-audio permission status as JSON (never prompts).
      oat-audio version       Print {"version","protocol"} as JSON.
    """

    public static func parse(_ args: [String]) throws -> CLICommand {
        guard let sub = args.first else { return .help }
        let rest = Array(args.dropFirst())
        switch sub {
        case "capture":
            return .capture(try parseCapture(rest))
        case "permissions":
            try expectNoArgs(rest, sub)
            return .permissions
        case "version", "--version":
            try expectNoArgs(rest, sub)
            return .version
        case "help", "--help", "-h":
            return .help
        default:
            throw CLIError("unknown command \"\(sub)\"")
        }
    }

    private static func expectNoArgs(_ rest: [String], _ sub: String) throws {
        if let extra = rest.first { throw CLIError("\(sub): unexpected argument \"\(extra)\"") }
    }

    static func parseCapture(_ args: [String]) throws -> CaptureOptions {
        var opts = CaptureOptions()
        var micFlag = false
        var systemFlag = false
        var i = 0
        func value(_ name: String) throws -> String {
            i += 1
            guard i < args.count else { throw CLIError("\(name) needs a value") }
            return args[i]
        }
        while i < args.count {
            var arg = args[i]
            // Support --flag=value.
            if arg.hasPrefix("--"), let eq = arg.firstIndex(of: "=") {
                let v = String(arg[arg.index(after: eq)...])
                arg = String(arg[..<eq])
                var expanded = args
                expanded.replaceSubrange(i...i, with: [arg, v])
                return try parseCapture(expanded)
            }
            switch arg {
            case "--mic": micFlag = true
            case "--system": systemFlag = true
            case "--synthetic": opts.synthetic = true
            case "--no-aec": opts.aec = false
            case "--sample-rate":
                let raw = try value(arg)
                guard let v = Int(raw), (8_000...48_000).contains(v) else {
                    throw CLIError("--sample-rate must be an integer in 8000...48000, got \"\(raw)\"")
                }
                opts.sampleRate = v
            case "--frame-ms":
                let raw = try value(arg)
                guard let v = Int(raw), (20...100).contains(v) else {
                    throw CLIError("--frame-ms must be an integer in 20...100, got \"\(raw)\"")
                }
                opts.frameMs = v
            case "--duration":
                let raw = try value(arg)
                guard let v = Double(raw), v > 0, v.isFinite else {
                    throw CLIError("--duration must be a positive number of seconds, got \"\(raw)\"")
                }
                opts.durationSeconds = v
            case "--exclude-pid":
                let raw = try value(arg)
                guard let v = Int32(raw), v > 0 else { throw CLIError("--exclude-pid needs a pid, got \"\(raw)\"") }
                opts.excludePIDs.append(v)
            default:
                throw CLIError("capture: unknown option \"\(arg)\"")
            }
            i += 1
        }
        if micFlag || systemFlag {
            opts.mic = micFlag
            opts.system = systemFlag
        }
        return opts
    }
}
