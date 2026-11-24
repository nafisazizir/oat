import Foundation

/// Minimal JSON value so events are Sendable and serialise with a stable key order.
public enum JSONValue: Sendable, Equatable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case array([JSONValue])
    case object([(String, JSONValue)])
    case null

    public static func == (lhs: JSONValue, rhs: JSONValue) -> Bool {
        lhs.serialized() == rhs.serialized()
    }

    public func serialized() -> String {
        switch self {
        case .string(let s): return JSONValue.quote(s)
        case .int(let i): return String(i)
        case .double(let d):
            guard d.isFinite else { return "null" }
            return String(format: "%.2f", d)
        case .bool(let b): return b ? "true" : "false"
        case .null: return "null"
        case .array(let items): return "[" + items.map { $0.serialized() }.joined(separator: ",") + "]"
        case .object(let pairs):
            return "{" + pairs.map { JSONValue.quote($0.0) + ":" + $0.1.serialized() }.joined(separator: ",") + "}"
        }
    }

    static func quote(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }
}

public enum StopReason: String, Sendable {
    case duration
    case command
    case stdinEOF = "stdin_eof"
    case signal
    case error
    case outputClosed = "output_closed"
}

/// Events carried in `kind=2` frames (UTF-8 JSON payload). Field names are part of the protocol.
public enum CaptureEvent: Sendable {
    case started(sampleRate: Int, frameMs: Int, sources: [SourceID], synthetic: Bool, aec: Bool = false)
    case captureReady
    case stopped(reason: StopReason, samples: [(SourceID, Int)])
    case paused
    case resumed
    case error(source: SourceID, code: String, message: String, fatal: Bool)
    case deviceChanged(source: SourceID, device: String)
    case level(source: SourceID, rmsDb: Double, peakDb: Double)
    /// Audio was dropped because a consumer fell behind. `stage`: "capture" (processing queue behind the audio
    /// callback) or "output" (stdout reader behind; oldest queued audio dropped).
    case overrun(source: SourceID, stage: String, droppedSamples: Int, droppedMs: Int)
    /// The capture device changed its own format (e.g. Bluetooth headset rate switch). Output stays at
    /// `sample_rate`; this is informational.
    case formatChanged(source: SourceID, deviceSampleRate: Double, previousDeviceSampleRate: Double, channels: Int)

    /// Frame source byte for this event.
    public var source: SourceID {
        switch self {
        case .started, .captureReady, .stopped, .paused, .resumed: return .none
        case .error(let s, _, _, _), .deviceChanged(let s, _), .level(let s, _, _), .overrun(let s, _, _, _),
             .formatChanged(let s, _, _, _): return s
        }
    }

    public var json: JSONValue {
        switch self {
        case let .started(sampleRate, frameMs, sources, synthetic, aec):
            return .object([
                ("type", .string("started")),
                ("protocol", .int(OatProtocol.version)),
                ("version", .string(OatProtocol.toolVersion)),
                ("sample_rate", .int(sampleRate)),
                ("frame_ms", .int(frameMs)),
                ("sources", .array(sources.map { .string($0.name) })),
                ("synthetic", .bool(synthetic)),
                ("aec", .bool(aec)),
                ("await_capture_ready", .bool(true)),
            ])
        case .captureReady:
            return .object([("type", .string("capture_ready"))])
        case let .stopped(reason, samples):
            return .object([
                ("type", .string("stopped")),
                ("reason", .string(reason.rawValue)),
                ("samples", .object(samples.map { ($0.0.name, .int($0.1)) })),
            ])
        case .paused:
            return .object([("type", .string("paused"))])
        case .resumed:
            return .object([("type", .string("resumed"))])
        case let .error(source, code, message, fatal):
            return .object([
                ("type", .string("error")),
                ("source", .string(source.name)),
                ("code", .string(code)),
                ("message", .string(message)),
                ("fatal", .bool(fatal)),
            ])
        case let .deviceChanged(source, device):
            return .object([
                ("type", .string("device_changed")),
                ("source", .string(source.name)),
                ("device", .string(device)),
            ])
        case let .overrun(source, stage, droppedSamples, droppedMs):
            return .object([
                ("type", .string("overrun")),
                ("source", .string(source.name)),
                ("stage", .string(stage)),
                ("dropped_samples", .int(droppedSamples)),
                ("dropped_ms", .int(droppedMs)),
            ])
        case let .formatChanged(source, rate, previous, channels):
            return .object([
                ("type", .string("format_changed")),
                ("source", .string(source.name)),
                ("device_sample_rate", .int(Int(rate.rounded()))),
                ("previous_device_sample_rate", .int(Int(previous.rounded()))),
                ("channels", .int(channels)),
            ])
        case let .level(source, rmsDb, peakDb):
            return .object([
                ("type", .string("level")),
                ("source", .string(source.name)),
                ("rms_db", .double(rmsDb)),
                ("peak_db", .double(peakDb)),
            ])
        }
    }

    public func frame(tUs: UInt64) -> Frame {
        Frame(kind: .event, source: source, tUs: tUs, payload: Data(json.serialized().utf8))
    }
}
