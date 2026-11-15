import Foundation

/// Deterministic test audio: a pure function of (source, sample index, sample rate).
///
/// - mic: 220 Hz tone in "speech-like" bursts — 600 ms on / 400 ms off, 10 ms raised-cosine ramps.
/// - system: 330 Hz + 495 Hz chord, 900 ms on / 400 ms off, phase-shifted by 500 ms so bursts overlap partially.
/// Different tones per source let consumers check that streams were not swapped.
public struct SyntheticGenerator: Sendable {
    public let source: SourceID
    public let sampleRate: Int

    struct Pattern {
        let tones: [Double]
        let amplitude: Double
        let onMs: Int
        let offMs: Int
        let phaseMs: Int
    }

    let pattern: Pattern

    public init(source: SourceID, sampleRate: Int) {
        self.source = source
        self.sampleRate = sampleRate
        switch source {
        case .system:
            pattern = Pattern(tones: [330, 495], amplitude: 0.25, onMs: 900, offMs: 400, phaseMs: 500)
        default:
            pattern = Pattern(tones: [220], amplitude: 0.30, onMs: 600, offMs: 400, phaseMs: 0)
        }
    }

    public func sample(at index: Int) -> Int16 {
        let rate = Double(sampleRate)
        let t = Double(index) / rate
        let periodMs = pattern.onMs + pattern.offMs
        let posMs = Double((index * 1000 / sampleRate + pattern.phaseMs) % periodMs)
            + Double((index * 1000) % sampleRate) / rate
        let ramp = 10.0
        var envelope: Double
        if posMs >= Double(pattern.onMs) {
            envelope = 0
        } else if posMs < ramp {
            envelope = 0.5 - 0.5 * cos(Double.pi * posMs / ramp)
        } else if posMs > Double(pattern.onMs) - ramp {
            envelope = 0.5 - 0.5 * cos(Double.pi * (Double(pattern.onMs) - posMs) / ramp)
        } else {
            envelope = 1
        }
        var v = 0.0
        for f in pattern.tones {
            v += sin(2 * Double.pi * f * t)
        }
        v = v / Double(pattern.tones.count) * pattern.amplitude * envelope
        return Int16(clamping: Int((v * 32767).rounded()))
    }

    public func samples(from start: Int, count: Int) -> [Int16] {
        (0..<max(0, count)).map { sample(at: start + $0) }
    }
}
