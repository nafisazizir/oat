import Foundation

/// Turns a stream of target-rate mono s16 sample chunks into fixed-size audio frames for one source.
///
/// Timestamps are sample-count based (stable, no jitter) and anchored to the capture clock: the anchor is the
/// clock time of the first sample after start / pause / a gap. If the arrival time of a chunk deviates from the
/// sample-based expectation by more than `reanchorThresholdUs` (device switch, dropped buffers, clock drift),
/// the pending partial frame is flushed and the timeline is re-anchored. Emitted `t_us` is strictly increasing.
public struct FrameAssembler: Sendable {
    public let source: SourceID
    public let sampleRate: Int
    public let frameSamples: Int
    public let reanchorThresholdUs: UInt64

    private var anchorUs: UInt64?
    /// Samples received since the anchor (emitted + pending).
    private var consumed: UInt64 = 0
    private var pending: [Int16] = []
    private var lastEmittedUs: UInt64?
    public private(set) var totalSamplesEmitted: Int = 0

    public init(source: SourceID, sampleRate: Int, frameMs: Int, reanchorThresholdUs: UInt64 = 100_000) {
        precondition(sampleRate > 0 && frameMs > 0)
        self.source = source
        self.sampleRate = sampleRate
        self.frameSamples = max(1, sampleRate * frameMs / 1000)
        self.reanchorThresholdUs = reanchorThresholdUs
    }

    private func offsetUs(_ samples: UInt64) -> UInt64 {
        samples * 1_000_000 / UInt64(sampleRate)
    }

    /// Append samples whose first sample was captured at `timeUs` (capture clock). Returns complete frames.
    public mutating func append(_ samples: [Int16], timeUs: UInt64) -> [Frame] {
        guard !samples.isEmpty else { return [] }
        var frames: [Frame] = []
        if let anchor = anchorUs {
            let expected = anchor + offsetUs(consumed)
            let drift = expected > timeUs ? expected - timeUs : timeUs - expected
            if drift > reanchorThresholdUs {
                frames += flush()
                anchorUs = timeUs
                consumed = 0
            }
        } else {
            anchorUs = timeUs
            consumed = 0
        }
        pending += samples
        consumed += UInt64(samples.count)
        while pending.count >= frameSamples {
            frames.append(makeFrame(count: frameSamples))
        }
        return frames
    }

    /// Emit whatever is pending as a (short) frame and forget the anchor, e.g. on pause or stop.
    public mutating func flush() -> [Frame] {
        var frames: [Frame] = []
        if !pending.isEmpty {
            frames.append(makeFrame(count: pending.count))
        }
        return frames
    }

    /// Flush and drop the anchor so the next chunk starts a new timeline segment (pause/resume).
    public mutating func reset() -> [Frame] {
        let frames = flush()
        anchorUs = nil
        consumed = 0
        return frames
    }

    private mutating func makeFrame(count: Int) -> Frame {
        let startIndex = consumed - UInt64(pending.count)
        var t = (anchorUs ?? 0) + offsetUs(startIndex)
        if let last = lastEmittedUs, t <= last { t = last + 1 }
        lastEmittedUs = t
        let chunk = Array(pending[0..<count])
        pending.removeFirst(count)
        totalSamplesEmitted += count
        return Frame.audio(source: source, tUs: t, samples: chunk)
    }
}

/// Accumulates RMS / peak over a window and reports dBFS once per window.
public struct LevelMeter: Sendable {
    public let windowSamples: Int
    private var sumSquares: Double = 0
    private var peak: Int32 = 0
    private var count = 0

    public init(sampleRate: Int, windowMs: Int = 250) {
        windowSamples = max(1, sampleRate * windowMs / 1000)
    }

    /// Returns (rmsDb, peakDb) each time a full window has been accumulated.
    public mutating func add(_ samples: [Int16]) -> [(rmsDb: Double, peakDb: Double)] {
        var out: [(Double, Double)] = []
        for s in samples {
            let v = Double(s) / 32768.0
            sumSquares += v * v
            peak = max(peak, abs(Int32(s)))
            count += 1
            if count == windowSamples {
                let rms = (sumSquares / Double(count)).squareRoot()
                out.append((LevelMeter.db(rms), LevelMeter.db(Double(peak) / 32768.0)))
                sumSquares = 0; peak = 0; count = 0
            }
        }
        return out
    }

    static func db(_ amplitude: Double) -> Double {
        amplitude > 0 ? max(-100, 20 * log10(amplitude)) : -100
    }
}
