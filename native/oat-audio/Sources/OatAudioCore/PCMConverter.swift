@preconcurrency import AVFoundation
import Foundation

public enum PCMConverterError: Error, CustomStringConvertible {
    case cannotCreateConverter(String)
    case conversionFailed(String)

    public var description: String {
        switch self {
        case .cannotCreateConverter(let f): return "cannot create AVAudioConverter from \(f)"
        case .conversionFailed(let m): return "conversion failed: \(m)"
        }
    }
}

/// Wraps AVAudioConverter: any input PCM format (rate, channel count, float/int) → mono s16 at `targetRate`.
/// Rebuilds the converter when the input format changes (device switch). Not thread-safe; use from one queue.
public final class PCMConverter {
    public let targetRate: Int
    public let outputFormat: AVAudioFormat
    private var converter: AVAudioConverter?
    private var inputFormat: AVAudioFormat?

    public init(targetRate: Int) {
        self.targetRate = targetRate
        outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16, sampleRate: Double(targetRate), channels: 1, interleaved: true)!
    }

    private func converterFor(_ format: AVAudioFormat) throws -> AVAudioConverter {
        if let converter, let inputFormat, inputFormat == format { return converter }
        guard let c = AVAudioConverter(from: format, to: outputFormat) else {
            throw PCMConverterError.cannotCreateConverter("\(format)")
        }
        c.downmix = true
        c.sampleRateConverterQuality = AVAudioQuality.high.rawValue
        converter = c
        inputFormat = format
        return c
    }

    /// Convert one buffer. Resampling converters hold back a few samples (filter latency) until `flush()`.
    /// On an input-format change the old converter is drained first, so its held-back samples are not lost
    /// (they are returned ahead of the new buffer's output).
    public func convert(_ buffer: AVAudioPCMBuffer) throws -> [Int16] {
        guard buffer.frameLength > 0 else { return [] }
        var out: [Int16] = []
        if converter != nil, let inputFormat, inputFormat != buffer.format {
            out = try flush()
        }
        let c = try converterFor(buffer.format)
        out += try run(c, input: buffer, endOfStream: false)
        return out
    }

    /// Drain samples held inside the converter (call on stop / before switching formats).
    public func flush() throws -> [Int16] {
        guard let c = converter else { return [] }
        let out = try run(c, input: nil, endOfStream: true)
        c.reset()
        return out
    }

    private func run(_ c: AVAudioConverter, input: AVAudioPCMBuffer?, endOfStream: Bool) throws -> [Int16] {
        let ratio = outputFormat.sampleRate / c.inputFormat.sampleRate
        let inFrames = Double(input?.frameLength ?? 0)
        let capacity = AVAudioFrameCount((inFrames * ratio).rounded(.up)) + 1024
        let state = InputState(buffer: input, endOfStream: endOfStream)
        var result: [Int16] = []
        // Loop because a single call may not drain everything (e.g. at end of stream).
        for _ in 0..<64 {
            guard let out = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
                throw PCMConverterError.conversionFailed("cannot allocate output buffer")
            }
            var error: NSError?
            let status = c.convert(to: out, error: &error) { _, outStatus in
                if let b = state.take() {
                    outStatus.pointee = .haveData
                    return b
                }
                outStatus.pointee = state.endOfStream ? .endOfStream : .noDataNow
                return nil
            }
            if status == .error {
                throw PCMConverterError.conversionFailed(error?.localizedDescription ?? "unknown")
            }
            if out.frameLength > 0, let ch = out.int16ChannelData {
                result.append(contentsOf: UnsafeBufferPointer(start: ch[0], count: Int(out.frameLength)))
            }
            if status != .haveData || out.frameLength == 0 { break }
        }
        return result
    }
}

/// Hands the input buffer to the converter exactly once.
private final class InputState: @unchecked Sendable {
    private var buffer: AVAudioPCMBuffer?
    let endOfStream: Bool
    init(buffer: AVAudioPCMBuffer?, endOfStream: Bool) {
        self.buffer = buffer
        self.endOfStream = endOfStream
    }
    func take() -> AVAudioPCMBuffer? {
        defer { buffer = nil }
        return buffer
    }
}
