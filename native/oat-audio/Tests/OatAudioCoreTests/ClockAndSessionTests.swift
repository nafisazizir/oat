import Darwin
import Foundation
import Testing
@testable import OatAudioCore

@Suite("Capture clock")
struct ClockTests {
    @Test func hostClockIsMonotonicAcrossThreads() async {
        let clock = HostCaptureClock()
        await withTaskGroup(of: Bool.self) { group in
            for _ in 0..<4 {
                group.addTask {
                    var last: UInt64 = 0
                    for _ in 0..<20_000 {
                        let now = clock.nowUs()
                        if now < last { return false }
                        last = now
                    }
                    return true
                }
            }
            for await ok in group { #expect(ok) }
        }
    }

    @Test func hostTimeMapsOntoTheSameTimeline() {
        let clock = HostCaptureClock()
        usleep(20_000)
        let viaHost = clock.hostTimeToUs(mach_absolute_time())
        let now = clock.nowUs()
        #expect(viaHost >= 19_000)
        #expect(now >= viaHost && now - viaHost < 5_000)
        // Host times before the origin clamp to 0.
        #expect(HostCaptureClock(originTicks: mach_absolute_time()).hostTimeToUs(1) == 0)
    }
}

@Suite("Frame assembly & timestamps")
struct AssemblerTests {
    @Test func emitsFixedFramesWithSampleBasedTimestamps() {
        var a = FrameAssembler(source: .mic, sampleRate: 16000, frameMs: 50)
        var frames: [Frame] = []
        // 10 ms chunks arriving with small jitter.
        for i in 0..<25 {
            let jitter: UInt64 = i % 2 == 0 ? 0 : 3_000
            frames += a.append([Int16](repeating: 1, count: 160), timeUs: 1_000 + UInt64(i) * 10_000 + jitter)
        }
        #expect(frames.count == 5)
        #expect(frames.map(\.tUs) == [1_000, 51_000, 101_000, 151_000, 201_000])
        #expect(frames.allSatisfy { $0.payload.count == 1600 })
        #expect(a.flush().isEmpty)
    }

    @Test func reanchorsAfterAGapAndStaysMonotonic() {
        var a = FrameAssembler(source: .system, sampleRate: 16000, frameMs: 50)
        var t: [UInt64] = []
        t += a.append([Int16](repeating: 0, count: 1200), timeUs: 0).map(\.tUs) // 1 frame + 400 pending
        // 500 ms gap (e.g. device switch): pending flushed as a short frame, new anchor.
        let gapFrames = a.append([Int16](repeating: 0, count: 800), timeUs: 575_000)
        #expect(gapFrames.count == 2)
        #expect(gapFrames[0].payload.count == 800)
        #expect(gapFrames[1].tUs == 575_000)
        t += gapFrames.map(\.tUs)
        // Input time jumps *backwards* (clock correction): output must still increase.
        t += a.append([Int16](repeating: 0, count: 800), timeUs: 100_000).map(\.tUs)
        #expect(zip(t, t.dropFirst()).allSatisfy { $0 < $1 }, "\(t)")
    }

    @Test func resetStartsNewSegment() {
        var a = FrameAssembler(source: .mic, sampleRate: 16000, frameMs: 20)
        _ = a.append([Int16](repeating: 0, count: 400), timeUs: 0)
        #expect(a.reset().count == 1) // 80 pending samples flushed
        let f = a.append([Int16](repeating: 0, count: 320), timeUs: 900_000)
        #expect(f.first?.tUs == 900_000)
        #expect(a.totalSamplesEmitted == 720)
    }

    @Test func levelMeterReportsPerWindow() {
        var m = LevelMeter(sampleRate: 16000, windowMs: 250)
        let quiet = m.add([Int16](repeating: 0, count: 4000))
        #expect(quiet.count == 1 && quiet[0].rmsDb == -100)
        let loud = m.add([Int16](repeating: 16384, count: 4000))
        #expect(abs(loud[0].rmsDb - -6.02) < 0.1)
    }
}

/// A source that fails to start, or fails later on demand.
final class FailingSource: CaptureSource, @unchecked Sendable {
    let id: SourceID
    let failOnStart: Bool
    weak var delegate: CaptureSourceDelegate?
    init(id: SourceID, failOnStart: Bool) { self.id = id; self.failOnStart = failOnStart }
    func start(delegate: CaptureSourceDelegate) throws {
        if failOnStart { throw CoreAudioError("tap_create_failed", -1, "test") }
        self.delegate = delegate
    }
    func failNow() { delegate?.source(id, didFailWithCode: "device_lost", message: "unplugged", fatal: true) }
    func stop() {}
}

/// A source the test drives by calling the session's delegate methods directly.
final class IdleSource: CaptureSource, @unchecked Sendable {
    let id: SourceID
    init(id: SourceID) { self.id = id }
    func start(delegate: CaptureSourceDelegate) throws {}
    func stop() {}
}

@Suite("Capture session: capture-stage drops")
struct SessionDropTests {
    @Test func dropClosesTheSegmentSoAudioAfterAShortGapKeepsItsRealTime() throws {
        var o = CaptureOptions()
        o.system = false
        let sink = MemoryFrameSink()
        let session = CaptureSession(options: o, sources: [IdleSource(id: .mic)], sink: sink, clock: ManualClock())
        session.start()
        session.source(.mic, didCapture: [Int16](repeating: 1, count: 1000), timeUs: 0)    // 1 frame + 200 pending
        session.source(.mic, didDropSamples: 160, ms: 10)                                   // 10 ms gap (< re-anchor threshold)
        session.source(.mic, didCapture: [Int16](repeating: 2, count: 800), timeUs: 72_500)
        session.source(.mic, formatChangedFrom: 48000, to: 16000, channels: 1)
        session.stop(reason: .command)

        let frames = sink.frames
        let seq = frames.map { f -> String in
            if f.kind == .audio { return "a\(f.payload.count / 2)@\(f.tUs)" }
            return (try? JSONSerialization.jsonObject(with: f.payload) as? [String: Any])?["type"] as? String ?? "?"
        }
        #expect(seq == ["started", "a800@0", "a200@50000", "overrun", "a800@72500", "format_changed", "stopped"], "\(seq)")
        let overrun = try JSONSerialization.jsonObject(with: frames[3].payload) as! [String: Any]
        #expect(overrun["stage"] as? String == "capture")
        #expect(overrun["dropped_samples"] as? Int == 160)
        let fmt = try JSONSerialization.jsonObject(with: frames[5].payload) as! [String: Any]
        #expect(fmt["device_sample_rate"] as? Int == 16000 && fmt["previous_device_sample_rate"] as? Int == 48000)
        #expect(fmt["source"] as? String == "mic")
    }
}

@Suite("Capture session (synthetic)", .serialized)
struct SessionTests {
    func run(_ options: CaptureOptions, sources: (CaptureClock) -> [CaptureSource],
             during: @escaping @Sendable (CaptureSession) async throws -> Void = { _ in })
        async throws -> (frames: [Frame], code: Int32)
    {
        let clock = HostCaptureClock()
        let sink = MemoryFrameSink()
        let session = CaptureSession(options: options, sources: sources(clock), sink: sink, clock: clock)
        let driver = Task { try await during(session) }
        let code: Int32 = await withCheckedContinuation { cont in
            session.onFinished { cont.resume(returning: $0) }
            session.start()
        }
        try await driver.value
        return (sink.frames, code)
    }

    func synthetic(_ o: CaptureOptions) -> (CaptureClock) -> [CaptureSource] {
        { clock in
            o.sources.map {
                SyntheticSource(id: $0, sampleRate: o.sampleRate, clock: clock,
                                maxSamples: o.durationSeconds.map { Int($0 * Double(o.sampleRate)) })
            }
        }
    }

    func events(_ frames: [Frame]) -> [[String: Any]] {
        frames.filter { $0.kind == .event }.map { try! JSONSerialization.jsonObject(with: $0.payload) as! [String: Any] }
    }

    @Test func durationProducesExactSampleCounts() async throws {
        var o = CaptureOptions()
        o.synthetic = true
        o.durationSeconds = 0.3
        let (frames, code) = try await run(o, sources: synthetic(o))
        #expect(code == 0)
        let ev = events(frames)
        #expect(ev.first?["type"] as? String == "started")
        #expect(ev.last?["type"] as? String == "stopped")
        #expect(ev.last?["reason"] as? String == "duration")
        for src in [SourceID.mic, .system] {
            let audio = frames.filter { $0.kind == .audio && $0.source == src }
            #expect(audio.reduce(0) { $0 + $1.payload.count } == 4800 * 2)
            #expect(zip(audio, audio.dropFirst()).allSatisfy { $0.tUs < $1.tUs })
            // Same content the generator produces: frames are the generator output, in order.
            let joined = audio.flatMap(\.samples)
            #expect(joined == SyntheticGenerator(source: src, sampleRate: 16000).samples(from: 0, count: 4800))
        }
    }

    @Test func stopCommandStopsEarly() async throws {
        var o = CaptureOptions()
        o.synthetic = true
        o.durationSeconds = 10
        let start = Date()
        let (frames, code) = try await run(o, sources: synthetic(o)) { s in
            try await Task.sleep(for: .milliseconds(200))
            s.handle(.stop)
        }
        #expect(code == 0)
        #expect(Date().timeIntervalSince(start) < 2)
        #expect(events(frames).last?["reason"] as? String == "command")
        let micBytes = frames.filter { $0.kind == .audio && $0.source == .mic }.reduce(0) { $0 + $1.payload.count }
        #expect(micBytes > 0 && micBytes < 16000 * 2)
    }

    @Test func pauseDropsAudioAndResumeContinuesLater() async throws {
        var o = CaptureOptions()
        o.synthetic = true
        o.mic = true
        o.system = false
        let (frames, _) = try await run(o, sources: synthetic(o)) { s in
            try await Task.sleep(for: .milliseconds(200))
            s.handle(.pause)
            try await Task.sleep(for: .milliseconds(300))
            s.handle(.resume)
            try await Task.sleep(for: .milliseconds(200))
            s.handle(.stop)
        }
        let types = events(frames).map { $0["type"] as! String }.filter { $0 != "level" }
        #expect(types == ["started", "paused", "resumed", "stopped"])
        let audio = frames.filter { $0.kind == .audio }
        let seconds = Double(audio.reduce(0) { $0 + $1.payload.count }) / 32000
        #expect(seconds > 0.25 && seconds < 0.6, "\(seconds)s kept of ~0.7s")
        // A timestamp gap of roughly the pause length exists.
        let gaps = zip(audio, audio.dropFirst()).map { $1.tUs - $0.tUs }
        #expect(gaps.contains { $0 > 250_000 })
    }

    @Test func failingSourceReportsErrorAndOtherContinues() async throws {
        var o = CaptureOptions()
        o.synthetic = true
        o.durationSeconds = 0.2
        let (frames, code) = try await run(o, sources: { clock in
            [SyntheticSource(id: .mic, sampleRate: 16000, clock: clock, maxSamples: 3200),
             FailingSource(id: .system, failOnStart: true)]
        })
        #expect(code == 0)
        let errs = events(frames).filter { $0["type"] as? String == "error" }
        #expect(errs.count == 1)
        #expect(errs.first?["source"] as? String == "system")
        #expect(errs.first?["code"] as? String == "tap_create_failed", "specific code, not generic start_failed")
        #expect(frames.filter { $0.kind == .audio && $0.source == .mic }.reduce(0) { $0 + $1.payload.count } == 6400)
    }

    @Test func allSourcesFailingStopsWithError() async throws {
        let failing = FailingSource(id: .system, failOnStart: false)
        var o = CaptureOptions()
        o.mic = false
        let (frames, code) = try await run(o, sources: { _ in [failing] }) { _ in
            try await Task.sleep(for: .milliseconds(50))
            failing.failNow()
        }
        #expect(code == 1)
        let ev = events(frames)
        #expect(ev.contains { $0["type"] as? String == "error" && $0["fatal"] as? Bool == true })
        #expect(ev.last?["reason"] as? String == "error")
    }
}
