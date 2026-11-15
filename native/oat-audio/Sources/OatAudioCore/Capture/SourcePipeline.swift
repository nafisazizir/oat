@preconcurrency import AVFoundation
import Foundation

/// Non-real-time half of a hardware source: drains the `SampleHandoff` on its own serial queue, converts to the
/// target format and hands samples to the session. Audio callbacks only call `push`.
public final class SourcePipeline: @unchecked Sendable {
    public let id: SourceID
    public let handoff: SampleHandoff
    private let clock: CaptureClock
    private let targetRate: Int
    private let queue: DispatchQueue
    private let signal: DispatchSourceUserDataAdd
    private let converter: PCMConverter
    private let invalidBufferCode: String
    private let invalidBufferMessage: String
    private var formats: [Double: AVAudioFormat] = [:]
    // queue-confined state
    private weak var delegate: CaptureSourceDelegate?
    private var nextTimeUs: UInt64?
    private var lastRate: Double?
    private var invalidReported = false
    private var cancelled = false

    /// `invalidBufferCode` / `invalidBufferMessage`: the one-off non-fatal error reported when the audio callback
    /// had to skip buffers (`markInvalidBuffer`); source-specific so the app can tell mic from tap problems.
    public init(id: SourceID, targetRate: Int, clock: CaptureClock, handoff: SampleHandoff = SampleHandoff(),
                invalidBufferCode: String, invalidBufferMessage: String)
    {
        self.id = id
        self.targetRate = targetRate
        self.clock = clock
        self.handoff = handoff
        self.invalidBufferCode = invalidBufferCode
        self.invalidBufferMessage = invalidBufferMessage
        queue = DispatchQueue(label: "oat-audio.\(id.name).process", qos: .userInitiated)
        signal = DispatchSource.makeUserDataAddSource(queue: queue)
        converter = PCMConverter(targetRate: targetRate)
        signal.setEventHandler { [weak self] in self?.process() }
        signal.activate()
    }

    public func setDelegate(_ delegate: CaptureSourceDelegate) {
        queue.sync { self.delegate = delegate }
    }

    /// Audio-thread entry point: copy only, then poke the processing queue.
    public func push(frames: Int, sampleRate: Double, hostTime: UInt64,
                     fill: (UnsafeMutablePointer<Float>, Int, Int) -> Void)
    {
        guard frames > 0 else { return }
        handoff.write(frames: frames, sampleRate: sampleRate, hostTime: hostTime, fill: fill)
        signal.add(data: 1)
    }

    public func markInvalidBuffer() {
        handoff.markInvalidBuffer()
        signal.add(data: 1)
    }

    /// Synchronously process everything pending and drain converter latency; the tail is stamped as a
    /// continuation of the previous chunk. Call after the producer has stopped (device stop / switch / format
    /// change).
    public func flush() {
        queue.sync {
            process()
            drainConverterTail()
            nextTimeUs = nil
        }
    }

    /// Final stop: nothing is delivered after this returns.
    public func cancel() {
        queue.sync {
            cancelled = true
            delegate = nil
        }
        signal.cancel()
    }

    private func format(for rate: Double) -> AVAudioFormat? {
        if let f = formats[rate] { return f }
        let f = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)
        formats[rate] = f
        return f
    }

    /// Runs on `queue`.
    private func process() {
        guard !cancelled else { return }
        let drained = handoff.drain()
        if drained.invalidBuffers > 0, !invalidReported {
            invalidReported = true
            delegate?.source(id, didFailWithCode: invalidBufferCode,
                             message: "\(drained.invalidBuffers) \(invalidBufferMessage)", fatal: false)
        }
        for chunk in drained.chunks {
            if chunk.gapFrames > 0 { reportDrop(frames: chunk.gapFrames, rate: chunk.gapRate) }
            // Rate change between chunks (device renegotiated): drain the old converter before switching.
            if let lastRate, lastRate != chunk.sampleRate { drainConverterTail() }
            lastRate = chunk.sampleRate
            guard let fmt = format(for: chunk.sampleRate),
                  let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(chunk.samples.count)),
                  let dst = buf.floatChannelData
            else { continue }
            buf.frameLength = AVAudioFrameCount(chunk.samples.count)
            chunk.samples.withUnsafeBufferPointer { dst[0].update(from: $0.baseAddress!, count: $0.count) }
            do {
                let samples = try converter.convert(buf)
                guard !samples.isEmpty else { continue }
                let base = clock.hostTimeToUs(chunk.hostTime)
                let t = base + UInt64(Double(chunk.frameOffset) * 1_000_000 / chunk.sampleRate)
                deliver(samples, timeUs: t)
            } catch {
                delegate?.source(id, didFailWithCode: "convert_failed", message: "\(error)", fatal: false)
            }
        }
        if drained.trailingDropFrames > 0 {
            reportDrop(frames: drained.trailingDropFrames, rate: drained.trailingDropRate)
        }
    }

    /// Audio before the gap is complete (converter drained), then the exact drop is reported and the timeline
    /// restarts at the next chunk's own timestamp.
    private func reportDrop(frames: Int, rate: Double) {
        guard rate > 0 else { return }
        drainConverterTail()
        let samples = Int((Double(frames) * Double(targetRate) / rate).rounded())
        let ms = Int((Double(frames) * 1000 / rate).rounded())
        delegate?.source(id, didDropSamples: samples, ms: ms)
        nextTimeUs = nil
    }

    private func drainConverterTail() {
        if let tail = try? converter.flush(), !tail.isEmpty {
            deliver(tail, timeUs: nextTimeUs ?? clock.nowUs())
        }
    }

    /// Within a continuous segment, never stamp a chunk before the end of the previous one: the converter's
    /// latency makes output lag its input timestamps by a few ms, which would otherwise overlap after a drained
    /// tail. Only overlaps up to `maxLatencyClampUs` are absorbed — larger backward deviations are real clock
    /// drift and are passed through so the frame assembler can re-anchor. After a drop / flush
    /// (`nextTimeUs == nil`) the chunk's own time is used.
    static let maxLatencyClampUs: UInt64 = 20_000

    private func deliver(_ samples: [Int16], timeUs: UInt64) {
        var t = timeUs
        if let n = nextTimeUs, timeUs < n, n - timeUs <= Self.maxLatencyClampUs { t = n }
        delegate?.source(id, didCapture: samples, timeUs: t)
        nextTimeUs = t + UInt64(samples.count) * 1_000_000 / UInt64(targetRate)
    }
}
