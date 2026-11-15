import Foundation

/// Wire protocol constants. See `PROTOCOL.md` — any change to framing bumps `version`.
public enum OatProtocol {
    public static let version = 1
    /// Tool version reported by `oat-audio version`.
    public static let toolVersion = "0.1.0"
    /// `u8 kind` + `u8 source` + `u64 t_us` + `u32 payload_len`.
    public static let headerSize = 14
    /// Decoders reject frames larger than this (defensive; real frames are a few KiB).
    public static let maxPayloadSize = 16 * 1024 * 1024
}

public enum FrameKind: UInt8, Sendable {
    case audio = 1
    case event = 2
}

public enum SourceID: UInt8, Sendable, CaseIterable, CustomStringConvertible {
    case mic = 0
    case system = 1
    case none = 255

    public var name: String {
        switch self {
        case .mic: return "mic"
        case .system: return "system"
        case .none: return "none"
        }
    }

    public var description: String { name }
}

/// One frame on stdout.
public struct Frame: Equatable, Sendable {
    public var kind: FrameKind
    public var source: SourceID
    /// Microseconds since capture start on the shared capture clock.
    public var tUs: UInt64
    public var payload: Data

    public init(kind: FrameKind, source: SourceID, tUs: UInt64, payload: Data) {
        self.kind = kind
        self.source = source
        self.tUs = tUs
        self.payload = payload
    }

    /// Audio frame from mono s16 samples (little-endian on the wire).
    public static func audio(source: SourceID, tUs: UInt64, samples: [Int16]) -> Frame {
        Frame(kind: .audio, source: source, tUs: tUs, payload: pcmData(samples))
    }

    public func encoded() -> Data {
        var out = Data(capacity: OatProtocol.headerSize + payload.count)
        out.append(kind.rawValue)
        out.append(source.rawValue)
        appendLE(&out, tUs)
        appendLE(&out, UInt32(payload.count))
        out.append(payload)
        return out
    }

    /// Payload interpreted as s16le samples (audio frames).
    public var samples: [Int16] {
        var result = [Int16](repeating: 0, count: payload.count / 2)
        payload.withUnsafeBytes { raw in
            for i in 0..<result.count {
                result[i] = Int16(bitPattern: UInt16(raw[2 * i]) | (UInt16(raw[2 * i + 1]) << 8))
            }
        }
        return result
    }
}

public func pcmData(_ samples: [Int16]) -> Data {
    var bytes = [UInt8](repeating: 0, count: samples.count * 2)
    for (i, s) in samples.enumerated() {
        let u = UInt16(bitPattern: s)
        bytes[2 * i] = UInt8(truncatingIfNeeded: u)
        bytes[2 * i + 1] = UInt8(truncatingIfNeeded: u >> 8)
    }
    return Data(bytes)
}

private func appendLE<T: FixedWidthInteger>(_ data: inout Data, _ value: T) {
    var le = value.littleEndian
    withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
}

public enum FrameDecodeError: Error, Equatable {
    case unknownKind(UInt8)
    case unknownSource(UInt8)
    case payloadTooLarge(Int)
    case oddAudioPayload(Int)
}

/// Incremental decoder: feed arbitrary byte chunks, get whole frames back.
public struct FrameDecoder {
    private var buffer = Data()

    public init() {}

    /// Bytes received but not yet forming a full frame.
    public var pendingByteCount: Int { buffer.count }

    public mutating func feed(_ chunk: Data) throws -> [Frame] {
        buffer.append(chunk)
        var frames: [Frame] = []
        var offset = buffer.startIndex
        while buffer.endIndex - offset >= OatProtocol.headerSize {
            let kindRaw = buffer[offset]
            let sourceRaw = buffer[offset + 1]
            let tUs = readLE(UInt64.self, buffer, at: offset + 2)
            let len = Int(readLE(UInt32.self, buffer, at: offset + 10))
            guard let kind = FrameKind(rawValue: kindRaw) else { throw FrameDecodeError.unknownKind(kindRaw) }
            guard let source = SourceID(rawValue: sourceRaw) else { throw FrameDecodeError.unknownSource(sourceRaw) }
            guard len <= OatProtocol.maxPayloadSize else { throw FrameDecodeError.payloadTooLarge(len) }
            if kind == .audio && len % 2 != 0 { throw FrameDecodeError.oddAudioPayload(len) }
            let start = offset + OatProtocol.headerSize
            guard buffer.endIndex - start >= len else { break }
            frames.append(Frame(kind: kind, source: source, tUs: tUs, payload: Data(buffer[start..<(start + len)])))
            offset = start + len
        }
        buffer = Data(buffer[offset...])
        return frames
    }
}

private func readLE<T: FixedWidthInteger>(_: T.Type, _ data: Data, at offset: Int) -> T {
    var value: T = 0
    for i in 0..<MemoryLayout<T>.size {
        value |= T(data[offset + i]) << (8 * i)
    }
    return value
}
