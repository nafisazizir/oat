import Foundation
import Testing
@testable import OatAudioCore

@Suite("Audio-thread handoff")
struct HandoffTests {
    @Test func preservesOrderAndSplitsLargeCallbacks() {
        let h = SampleHandoff(slotCount: 8, slotCapacity: 100)
        #expect(h.write(frames: 250, sampleRate: 48000, hostTime: 7) { dst, off, n in
            for i in 0..<n { dst[i] = Float(off + i) }
        })
        let d = h.drain()
        #expect(d.chunks.map(\.samples.count) == [100, 100, 50])
        #expect(d.chunks.map(\.frameOffset) == [0, 100, 200])
        #expect(d.chunks.allSatisfy { $0.hostTime == 7 && $0.sampleRate == 48000 })
        #expect(d.chunks.flatMap(\.samples) == (0..<250).map(Float.init))
        #expect(h.drain().chunks.isEmpty)
    }

    @Test func overflowDropsAndCountsInsteadOfWaiting() {
        let h = SampleHandoff(slotCount: 2, slotCapacity: 10)
        #expect(h.write(frames: 10, sampleRate: 16000, hostTime: 1) { d, _, n in d.update(repeating: 1, count: n) })
        #expect(h.write(frames: 10, sampleRate: 16000, hostTime: 2) { d, _, n in d.update(repeating: 2, count: n) })
        #expect(!h.write(frames: 25, sampleRate: 16000, hostTime: 3) { d, _, n in d.update(repeating: 3, count: n) })
        h.markInvalidBuffer()
        let d = h.drain()
        #expect(d.chunks.map(\.hostTime) == [1, 2])
        #expect(d.trailingDropFrames == 25 && d.trailingDropRate == 16000)
        #expect(d.chunks.allSatisfy { $0.gapFrames == 0 })
        #expect(d.invalidBuffers == 1)
        // Counters reset; slots are reusable (ring wraps).
        #expect(h.write(frames: 10, sampleRate: 16000, hostTime: 4) { d, _, n in d.update(repeating: 4, count: n) })
        let d2 = h.drain()
        #expect(d2.trailingDropFrames == 0 && d2.chunks.first?.samples.first == 4)
    }
}

@Suite("Mono mixing")
struct MonoMixTests {
    @Test func interleavedAverageAndOffset() {
        let src: [Float] = [1, 3, 2, 4, 10, 20] // 3 frames × 2 ch
        var dst = [Float](repeating: 0, count: 2)
        src.withUnsafeBufferPointer { s in
            dst.withUnsafeMutableBufferPointer { d in
                MonoMix.interleaved(s.baseAddress!, channels: 2, frameOffset: 1, frames: 2, into: d.baseAddress!)
            }
        }
        #expect(dst == [3, 15])
    }

    @Test func planarFirstChannelOrAverage() {
        var c0: [Float] = [1, 1, 1]
        var c1: [Float] = [3, 5, 7]
        c0.withUnsafeMutableBufferPointer { p0 in
            c1.withUnsafeMutableBufferPointer { p1 in
                let ptrs = [p0.baseAddress!, p1.baseAddress!]
                ptrs.withUnsafeBufferPointer { chans in
                    var avg = [Float](repeating: 0, count: 3)
                    var first = [Float](repeating: 0, count: 2)
                    avg.withUnsafeMutableBufferPointer {
                        MonoMix.planar(chans.baseAddress!, channels: 2, firstChannelOnly: false, frameOffset: 0, frames: 3, into: $0.baseAddress!)
                    }
                    first.withUnsafeMutableBufferPointer {
                        MonoMix.planar(chans.baseAddress!, channels: 2, firstChannelOnly: true, frameOffset: 1, frames: 2, into: $0.baseAddress!)
                    }
                    #expect(avg == [2, 3, 4])
                    #expect(first == [1, 1])
                }
            }
        }
    }
}

@Suite("Tap buffer selection")
struct TapBufferSelectionTests {
    @Test func tapComesAfterSubDeviceInputStreams() {
        // Built-in speakers: no input streams → the only buffer is the tap.
        #expect(TapBufferSelection.index(numberBuffers: 1, subDeviceInputStreams: 0, expectedChannels: 1) { _ in 1 } == 0)
        // USB headset as output device: its mic stream is buffer 0, the tap is buffer 1 — never pick the mic.
        let channels: [UInt32] = [1, 1]
        #expect(TapBufferSelection.index(numberBuffers: 2, subDeviceInputStreams: 1, expectedChannels: 1) { channels[$0] } == 1)
        let headset: [UInt32] = [2, 2, 1]
        #expect(TapBufferSelection.index(numberBuffers: 3, subDeviceInputStreams: 2, expectedChannels: 1) { headset[$0] } == 2)
    }

    @Test func requiresExactlyOneTapAfterTheDeviceInputs() {
        // An extra buffer (unexpected layout) fails closed even if a mono buffer sits at the expected index.
        #expect(TapBufferSelection.index(numberBuffers: 3, subDeviceInputStreams: 1, expectedChannels: 1) { _ in 1 } == nil)
        #expect(TapBufferSelection.index(numberBuffers: 2, subDeviceInputStreams: 0, expectedChannels: 1) { _ in 1 } == nil)
    }

    @Test func rejectsInconsistentLayouts() {
        // Tap buffer missing.
        #expect(TapBufferSelection.index(numberBuffers: 1, subDeviceInputStreams: 1, expectedChannels: 1) { _ in 1 } == nil)
        #expect(TapBufferSelection.index(numberBuffers: 0, subDeviceInputStreams: 0, expectedChannels: 1) { _ in 1 } == nil)
        // Channel count does not match the tap format → don't guess.
        #expect(TapBufferSelection.index(numberBuffers: 2, subDeviceInputStreams: 1, expectedChannels: 1) { _ in 2 } == nil)
    }
}

/// Records deliveries from a pipeline.
final class RecordingDelegate: CaptureSourceDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var chunks: [(samples: [Int16], timeUs: UInt64)] = []
    private(set) var overrunMs = 0
    private(set) var droppedSamples = 0
    private(set) var errors: [String] = []
    /// Order of callbacks: "audio" / "drop" / "format".
    private(set) var log: [String] = []
    func source(_ source: SourceID, didCapture samples: [Int16], timeUs: UInt64) {
        lock.lock(); chunks.append((samples, timeUs)); log.append("audio"); lock.unlock()
    }
    func source(_ source: SourceID, didFailWithCode code: String, message: String, fatal: Bool) {
        lock.lock(); errors.append(code); lock.unlock()
    }
    func source(_ source: SourceID, deviceChanged device: String) {}
    func source(_ source: SourceID, didDropSamples samples: Int, ms: Int) {
        lock.lock(); overrunMs += ms; droppedSamples += samples; log.append("drop"); lock.unlock()
    }
    func source(_ source: SourceID, formatChangedFrom previousRate: Double, to sampleRate: Double, channels: UInt32) {
        lock.lock(); log.append("format"); lock.unlock()
    }
}

@Suite("Source pipeline")
struct SourcePipelineTests {
    @Test func convertsOffTheAudioThreadAndStampsTailAsContinuation() {
        let clock = ManualClock() // hostTimeToUs is identity: host time given in µs
        // Enough slots for the whole burst (real callbacks arrive every 10 ms, not all at once).
        let p = SourcePipeline(id: .system, targetRate: 16000, clock: clock, handoff: SampleHandoff(slotCount: 128),
                               invalidBufferCode: "tap_buffer_invalid", invalidBufferMessage: "x")
        let d = RecordingDelegate()
        p.setDelegate(d)
        // 1 s of 48 kHz in 10 ms callbacks.
        for k in 0..<100 {
            p.push(frames: 480, sampleRate: 48000, hostTime: UInt64(k) * 10_000) { dst, off, n in
                for i in 0..<n { dst[i] = Float(0.5 * sin(2 * Double.pi * 440 * Double(k * 480 + off + i) / 48000)) }
            }
        }
        p.flush()
        p.cancel()
        let total = d.chunks.reduce(0) { $0 + $1.samples.count }
        #expect(abs(total - 16000) <= 16)
        #expect(zip(d.chunks, d.chunks.dropFirst()).allSatisfy { $0.timeUs < $1.timeUs })
        // Converter tail: contiguous with the previous chunk instead of "now".
        let prev = d.chunks[d.chunks.count - 2]
        let last = d.chunks[d.chunks.count - 1]
        #expect(last.timeUs == prev.timeUs + UInt64(prev.samples.count) * 1_000_000 / 16000)
        #expect(d.errors.isEmpty)
        #expect(d.overrunMs == 0)
    }

    @Test func reportsCaptureStageOverrunAndInvalidBuffersOnce() {
        let p = SourcePipeline(id: .mic, targetRate: 16000, clock: ManualClock(),
                               handoff: SampleHandoff(slotCount: 1, slotCapacity: 480),
                               invalidBufferCode: "mic_buffer_invalid", invalidBufferMessage: "mic buffers skipped")
        let d = RecordingDelegate()
        p.setDelegate(d)
        // Fill the only slot directly on the handoff (no signal) so the next push overflows.
        p.handoff.write(frames: 480, sampleRate: 48000, hostTime: 0) { dst, _, n in dst.update(repeating: 0, count: n) }
        p.push(frames: 4800, sampleRate: 48000, hostTime: 10_000) { dst, _, n in dst.update(repeating: 0, count: n) }
        p.markInvalidBuffer()
        p.markInvalidBuffer()
        p.flush()
        p.cancel()
        #expect(d.overrunMs == 100)
        #expect(d.droppedSamples == 1600, "exact: 4800 frames @ 48 kHz = 1600 samples @ 16 kHz")
        #expect(d.errors == ["mic_buffer_invalid"], "source-specific code, reported once")
        // Audio from before the gap (incl. converter tail) is delivered before the drop is reported.
        #expect(d.log.last == "drop")
        #expect(d.log.dropLast().allSatisfy { $0 == "audio" } && d.log.count > 1)
    }

    @Test func rateChangeDrainsTheOldConverterFirst() {
        let clock = ManualClock()
        let p = SourcePipeline(id: .system, targetRate: 16000, clock: clock, handoff: SampleHandoff(slotCount: 128),
                               invalidBufferCode: "tap_buffer_invalid", invalidBufferMessage: "x")
        let d = RecordingDelegate()
        p.setDelegate(d)
        // 0.5 s at 48 kHz, then (Bluetooth renegotiation) 0.5 s at 16 kHz, no explicit flush in between.
        for k in 0..<50 {
            p.push(frames: 480, sampleRate: 48000, hostTime: UInt64(k) * 10_000) { dst, _, n in dst.update(repeating: 0.25, count: n) }
        }
        for k in 0..<50 {
            p.push(frames: 160, sampleRate: 16000, hostTime: 500_000 + UInt64(k) * 10_000) { dst, _, n in dst.update(repeating: 0.25, count: n) }
        }
        p.flush()
        p.cancel()
        let total = d.chunks.reduce(0) { $0 + $1.samples.count }
        #expect(abs(total - 16000) <= 16, "no samples lost at the rate switch: \(total)")
        #expect(zip(d.chunks, d.chunks.dropFirst()).allSatisfy { $0.timeUs < $1.timeUs })
    }
}

@Suite("Format change decision")
struct FormatChangeTests {
    let base = StreamLayout(sampleRate: 48000, channels: 1, bufferIndex: 0)

    @Test func unchangedOrUnreadableMeansNothing() {
        #expect(FormatChange.evaluate(current: base, observed: base) == .none)
        #expect(FormatChange.evaluate(current: base, observed: StreamLayout(sampleRate: 48000.0001, channels: 1)) == .none)
        #expect(FormatChange.evaluate(current: base, observed: nil) == .none)
        #expect(FormatChange.evaluate(current: base, observed: StreamLayout(sampleRate: 0, channels: 1)) == .none,
                "transient rate 0 during Bluetooth renegotiation")
        #expect(FormatChange.evaluate(current: base, observed: StreamLayout(sampleRate: .nan, channels: 1)) == .none)
        #expect(FormatChange.evaluate(current: nil, observed: base) == .none)
    }

    @Test func rateChannelOrLayoutChangeReconfigures() {
        let bt = StreamLayout(sampleRate: 16000, channels: 1, bufferIndex: 0)
        #expect(FormatChange.evaluate(current: base, observed: bt) == .changed(from: base, to: bt))
        let stereo = StreamLayout(sampleRate: 48000, channels: 2, bufferIndex: 0)
        #expect(FormatChange.evaluate(current: base, observed: stereo) == .changed(from: base, to: stereo))
        let headsetMicAppeared = StreamLayout(sampleRate: 48000, channels: 1, bufferIndex: 1)
        #expect(FormatChange.evaluate(current: base, observed: headsetMicAppeared) == .changed(from: base, to: headsetMicAppeared))
    }
}
