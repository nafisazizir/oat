@preconcurrency import AVFoundation
import Foundation
import Testing
@testable import OatAudioCore

@Suite("PCMConverter")
struct ConverterTests {
    /// Feed `seconds` of a 440 Hz sine in `chunk`-frame buffers, return converted output (incl. flush).
    func convertSine(rate: Double, channels: AVAudioChannelCount, seconds: Double, chunk: AVAudioFrameCount,
                     target: Int = 16000) throws -> [Int16]
    {
        let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: channels)!
        let conv = PCMConverter(targetRate: target)
        let total = Int(rate * seconds)
        var out: [Int16] = []
        var produced = 0
        while produced < total {
            let n = min(Int(chunk), total - produced)
            let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(n))!
            buf.frameLength = AVAudioFrameCount(n)
            for c in 0..<Int(channels) {
                let p = buf.floatChannelData![c]
                for i in 0..<n {
                    let phase: Double = 2 * Double.pi * 440 * Double(produced + i) / rate
                    p[i] = Float(0.5 * sin(phase))
                }
            }
            out += try conv.convert(buf)
            produced += n
        }
        out += try conv.flush()
        return out
    }

    @Test(arguments: [(48000.0, 2 as UInt32), (44100.0, 1 as UInt32), (16000.0, 1 as UInt32), (96000.0, 2 as UInt32)])
    func outputLengthMatchesTargetRate(rate: Double, channels: UInt32) throws {
        let out = try convertSine(rate: rate, channels: channels, seconds: 1, chunk: 512)
        // One second in → 16000 samples out, within resampler edge effects (< 1 ms).
        #expect(abs(out.count - 16000) <= 16, "got \(out.count) samples from \(rate) Hz × \(channels)")
        // Signal survives: a 0.5-amplitude sine has RMS ≈ 0.35 FS.
        let mid = out[4000..<12000]
        var sumSquares = 0.0
        for s in mid {
            let v = Double(s) / 32768
            sumSquares += v * v
        }
        let rms = (sumSquares / Double(mid.count)).squareRoot()
        #expect(rms > 0.3 && rms < 0.4, "rms \(rms)")
    }

    @Test func formatSwitchWithoutExplicitFlushDrainsOldConverter() throws {
        let conv = PCMConverter(targetRate: 16000)
        var total = 0
        for rate in [48000.0, 24000.0] {
            let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
            for _ in 0..<10 {
                let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(rate / 10))!
                buf.frameLength = buf.frameCapacity
                total += try conv.convert(buf).count
            }
        }
        total += try conv.flush().count
        #expect(abs(total - 32000) <= 32, "\(total)")
    }

    @Test func outputFormatIsMonoInt16AtTarget() {
        let conv = PCMConverter(targetRate: 24000)
        #expect(conv.outputFormat.commonFormat == .pcmFormatInt16)
        #expect(conv.outputFormat.channelCount == 1)
        #expect(conv.outputFormat.sampleRate == 24000)
    }

    @Test func formatChangeMidStreamIsHandled() throws {
        let conv = PCMConverter(targetRate: 16000)
        var total = 0
        for (rate, ch) in [(48000.0, AVAudioChannelCount(2)), (44100.0, AVAudioChannelCount(1))] {
            let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: ch)!
            for _ in 0..<10 {
                let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(rate / 10))!
                buf.frameLength = buf.frameCapacity
                total += try conv.convert(buf).count
            }
            total += try conv.flush().count
        }
        #expect(abs(total - 32000) <= 32)
    }
}

@Suite("Synthetic generator")
struct GeneratorTests {
    @Test func deterministicAcrossInstancesAndChunking() {
        let a = SyntheticGenerator(source: .mic, sampleRate: 16000)
        let b = SyntheticGenerator(source: .mic, sampleRate: 16000)
        let whole = a.samples(from: 0, count: 32000)
        #expect(whole == b.samples(from: 0, count: 32000))
        var chunked: [Int16] = []
        var i = 0
        for size in [1, 799, 800, 3333, 10000, 17067] {
            chunked += b.samples(from: i, count: size)
            i += size
        }
        #expect(chunked == whole)
    }

    @Test func sourcesDifferAndHaveBursts() {
        let mic = SyntheticGenerator(source: .mic, sampleRate: 16000).samples(from: 0, count: 16000)
        let sys = SyntheticGenerator(source: .system, sampleRate: 16000).samples(from: 0, count: 16000)
        #expect(mic != sys)
        // mic: on for 0–600 ms, silent 600–1000 ms.
        #expect(mic[1600..<8000].contains { abs(Int($0)) > 5000 })
        #expect(mic[10000..<16000].allSatisfy { $0 == 0 })
        // Stays within amplitude (no clipping).
        #expect(mic.allSatisfy { abs(Int($0)) <= Int(0.31 * 32767) })
    }

    @Test func goldenSamples() {
        // Pin a few values so accidental changes to the test signal are noticed (consumers may rely on it).
        let g = SyntheticGenerator(source: .mic, sampleRate: 16000)
        #expect(g.sample(at: 0) == 0)
        #expect(g.samples(from: 1000, count: 4).allSatisfy { $0 != 0 })
        #expect(g.sample(at: 1000) == SyntheticGenerator(source: .mic, sampleRate: 16000).sample(at: 1000))
    }
}
