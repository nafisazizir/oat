import Foundation
import Testing
@testable import OatAudioCore

@Suite("Wire protocol framing")
struct ProtocolTests {
    @Test func headerLayoutIsLittleEndian() {
        let f = Frame.audio(source: .system, tUs: 0x0102_0304_0506_0708, samples: [1, -2])
        let bytes = [UInt8](f.encoded())
        #expect(bytes.count == OatProtocol.headerSize + 4)
        #expect(bytes[0] == 1) // kind audio
        #expect(bytes[1] == 1) // source system
        #expect(Array(bytes[2..<10]) == [0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01])
        #expect(Array(bytes[10..<14]) == [4, 0, 0, 0])
        #expect(Array(bytes[14...]) == [0x01, 0x00, 0xFE, 0xFF]) // s16le 1, -2
    }

    @Test func roundTripMixedFrames() throws {
        let frames: [Frame] = [
            CaptureEvent.started(sampleRate: 16000, frameMs: 50, sources: [.mic, .system], synthetic: true).frame(tUs: 0),
            Frame.audio(source: .mic, tUs: 10, samples: (0..<800).map { Int16(truncatingIfNeeded: $0 * 37) }),
            Frame.audio(source: .system, tUs: 11, samples: [Int16.min, Int16.max, 0]),
            CaptureEvent.level(source: .mic, rmsDb: -20.5, peakDb: -3).frame(tUs: 12),
            CaptureEvent.stopped(reason: .command, samples: [(.mic, 800), (.system, 3)]).frame(tUs: 13),
        ]
        let wire = frames.reduce(into: Data()) { $0.append($1.encoded()) }
        var decoder = FrameDecoder()
        let decoded = try decoder.feed(wire)
        #expect(decoded == frames)
        #expect(decoder.pendingByteCount == 0)
        #expect(decoded[2].samples == [Int16.min, Int16.max, 0])
    }

    @Test func decoderHandlesArbitraryChunking() throws {
        var frames: [Frame] = []
        for i in 0..<10 {
            let src: SourceID = i % 2 == 0 ? .mic : .system
            let samples = [Int16](repeating: Int16(i), count: 7 + i)
            frames.append(Frame.audio(source: src, tUs: UInt64(i) * 50_000, samples: samples))
        }
        let wire = frames.reduce(into: Data()) { $0.append($1.encoded()) }
        for chunkSize in [1, 3, 13, 14, 15, 100] {
            var decoder = FrameDecoder()
            var out: [Frame] = []
            var i = 0
            while i < wire.count {
                out += try decoder.feed(wire.subdata(in: i..<min(wire.count, i + chunkSize)))
                i += chunkSize
            }
            #expect(out == frames, "chunk size \(chunkSize)")
            #expect(decoder.pendingByteCount == 0)
        }
    }

    @Test func partialFrameStaysPending() throws {
        let wire = Frame.audio(source: .mic, tUs: 1, samples: [1, 2, 3]).encoded()
        var decoder = FrameDecoder()
        #expect(try decoder.feed(wire.prefix(wire.count - 1)).isEmpty)
        #expect(decoder.pendingByteCount == wire.count - 1)
    }

    @Test func decoderRejectsGarbage() {
        var d1 = FrameDecoder()
        #expect(throws: FrameDecodeError.unknownKind(9)) { try d1.feed(Data([9, 0] + [UInt8](repeating: 0, count: 12))) }
        var d2 = FrameDecoder()
        #expect(throws: FrameDecodeError.unknownSource(7)) { try d2.feed(Data([1, 7] + [UInt8](repeating: 0, count: 12))) }
        var d3 = FrameDecoder()
        #expect(throws: FrameDecodeError.oddAudioPayload(3)) { try d3.feed(Data([1, 0] + [UInt8](repeating: 0, count: 8) + [3, 0, 0, 0])) }
    }

    @Test func eventJSONShapes() throws {
        func obj(_ e: CaptureEvent) throws -> [String: Any] {
            try JSONSerialization.jsonObject(with: e.frame(tUs: 0).payload) as! [String: Any]
        }
        let started = try obj(.started(sampleRate: 16000, frameMs: 50, sources: [.mic], synthetic: false))
        #expect(started["type"] as? String == "started")
        #expect(started["protocol"] as? Int == 1)
        #expect(started["sources"] as? [String] == ["mic"])
        #expect(started["aec"] as? Bool == false)
        let withAec = try obj(.started(sampleRate: 16000, frameMs: 50, sources: [.mic], synthetic: false, aec: true))
        #expect(withAec["aec"] as? Bool == true)
        let err = try obj(.error(source: .system, code: "tap_create_failed", message: "a \"quoted\"\nline", fatal: true))
        #expect(err["message"] as? String == "a \"quoted\"\nline")
        #expect(err["fatal"] as? Bool == true)
        #expect(CaptureEvent.error(source: .system, code: "x", message: "", fatal: false).source == .system)
        #expect(CaptureEvent.paused.source == .none)
        let stopped = try obj(.stopped(reason: .stdinEOF, samples: [(.mic, 5)]))
        #expect(stopped["reason"] as? String == "stdin_eof")
        #expect((stopped["samples"] as? [String: Int])?["mic"] == 5)
        let level = try obj(.level(source: .mic, rmsDb: -.infinity, peakDb: -1))
        #expect(level["rms_db"] is NSNull)
    }
}
