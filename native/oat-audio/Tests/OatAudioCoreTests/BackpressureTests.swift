import Darwin
import Foundation
import Testing
@testable import OatAudioCore

private func audio(_ src: SourceID, _ t: UInt64, samples: Int = 800) -> Frame {
    Frame.audio(source: src, tUs: t, samples: [Int16](repeating: 1, count: samples))
}

private func eventObject(_ f: Frame) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: f.payload)) as? [String: Any] ?? [:]
}

/// Reads everything from `fd` until EOF on a background thread.
private final class PipeReader: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    private let done = DispatchSemaphore(value: 0)
    init(fd: Int32) {
        Thread {
            var buf = [UInt8](repeating: 0, count: 65536)
            while true {
                let n = read(fd, &buf, buf.count)
                if n <= 0 { break }
                self.lock.lock(); self.data.append(contentsOf: buf[0..<n]); self.lock.unlock()
            }
            self.done.signal()
        }.start()
    }
    func wait() -> Data {
        done.wait()
        lock.lock(); defer { lock.unlock() }
        return data
    }
}

@Suite("Backpressure: bounded output queue")
struct BoundedQueueTests {
    @Test func dropsOldestAudioButKeepsEvents() {
        let frameBytes = OatProtocol.headerSize + 1600
        var q = BoundedFrameQueue(capacityBytes: frameBytes * 3, sampleRate: 16000)
        q.push(CaptureEvent.started(sampleRate: 16000, frameMs: 50, sources: [.mic], synthetic: true).frame(tUs: 0))
        for i in 0..<6 { q.push(audio(.mic, UInt64(i) * 50_000)) }
        #expect(q.queuedBytes <= frameBytes * 3)
        #expect(q.droppedSamples[.mic] == 4 * 800)

        var out: [Frame] = []
        while let f = q.pop() { out.append(f) }
        #expect(eventObject(out[0])["type"] as? String == "started")
        let overrun = eventObject(out[1])
        #expect(overrun["type"] as? String == "overrun")
        #expect(overrun["stage"] as? String == "output")
        #expect(overrun["dropped_samples"] as? Int == 3200)
        #expect(overrun["dropped_ms"] as? Int == 200)
        #expect(out[1].tUs == 0) // first dropped frame's time
        // Surviving audio = the newest frames, in order.
        #expect(out.dropFirst(2).map(\.tUs) == [200_000, 250_000])
        #expect(q.isEmpty && q.queuedBytes == 0)
    }

    @Test func overrunMarkersMergePerSource() {
        let frameBytes = OatProtocol.headerSize + 1600
        var q = BoundedFrameQueue(capacityBytes: frameBytes * 2, sampleRate: 16000)
        for i in 0..<10 {
            q.push(audio(.mic, UInt64(i) * 50_000))
            q.push(audio(.system, UInt64(i) * 50_000 + 1))
        }
        var out: [Frame] = []
        while let f = q.pop() { out.append(f) }
        let overruns = out.filter { $0.kind == .event }.map(eventObject)
        #expect(overruns.count == 2, "one merged marker per source")
        let dropped = overruns.reduce(0) { $0 + ($1["dropped_samples"] as? Int ?? 0) }
        let kept = out.filter { $0.kind == .audio }.reduce(0) { $0 + $1.payload.count / 2 }
        #expect(dropped + kept == 20 * 800, "every sample is either delivered or reported dropped")
    }
}

@Suite("Backpressure: slow reader", .serialized)
struct SlowReaderTests {
    @Test func writeNeverBlocksOnAFullPipe() throws {
        var fds: [Int32] = [0, 0]
        #expect(pipe(&fds) == 0)
        let capacity = 10 * (OatProtocol.headerSize + 1600)
        let sink = QueuedFrameSink(fd: fds[1], capacityBytes: capacity, sampleRate: 16000)

        // 20 s of audio into a pipe nobody reads (pipe buffer ≤ 64 KB): must not block.
        let start = Date()
        for i in 0..<400 { #expect(sink.write(audio(.mic, UInt64(i) * 50_000))) }
        #expect(Date().timeIntervalSince(start) < 0.5, "write() blocked on a slow reader")
        #expect((sink.droppedSamples[.mic] ?? 0) > 0)

        let reader = PipeReader(fd: fds[0])
        sink.finish(timeout: 5)
        close(fds[1])
        let data = reader.wait()
        close(fds[0])

        var dec = FrameDecoder()
        let frames = try dec.feed(data)
        #expect(dec.pendingByteCount == 0)
        let audioFrames = frames.filter { $0.kind == .audio }
        #expect(zip(audioFrames, audioFrames.dropFirst()).allSatisfy { $0.tUs < $1.tUs })
        let overruns = frames.filter { $0.kind == .event }.map(eventObject)
        #expect(!overruns.isEmpty && overruns.allSatisfy { $0["type"] as? String == "overrun" })
        let dropped = overruns.reduce(0) { $0 + ($1["dropped_samples"] as? Int ?? 0) }
        let kept = audioFrames.reduce(0) { $0 + $1.payload.count / 2 }
        #expect(dropped + kept == 400 * 800)
        #expect(audioFrames.last?.tUs == 399 * 50_000, "newest audio survives")
    }

    @Test func writeAllWaitsOnNonBlockingFdInsteadOfFailing() throws {
        var fds: [Int32] = [0, 0]
        #expect(pipe(&fds) == 0)
        _ = fcntl(fds[1], F_SETFL, fcntl(fds[1], F_GETFL) | O_NONBLOCK)
        let payload = Data(repeating: 7, count: 512 * 1024) // ≫ pipe buffer → EAGAIN path
        let reader = PipeReader(fd: fds[0])
        #expect(writeAll(fd: fds[1], payload))
        close(fds[1])
        #expect(reader.wait() == payload)
        close(fds[0])
    }

    @Test func sessionKeepsCapturingWhileReaderStalls() async throws {
        var fds: [Int32] = [0, 0]
        #expect(pipe(&fds) == 0)
        var o = CaptureOptions()
        o.synthetic = true
        o.durationSeconds = 3 // 3 s × 2 sources ≈ 192 KB ≫ the 64 KB pipe buffer
        let clock = HostCaptureClock()
        let sink = QueuedFrameSink(fd: fds[1], capacityBytes: 4 * (OatProtocol.headerSize + 1600), sampleRate: 16000)
        let sources: [CaptureSource] = o.sources.map {
            SyntheticSource(id: $0, sampleRate: 16000, clock: clock, maxSamples: 48000)
        }
        let session = CaptureSession(options: o, sources: sources, sink: sink, clock: clock, finishTimeout: 5)
        let readFd = fds[0]
        // Reader stays away for 3.3 s (past the 3 s capture), then drains.
        let readerBox = ReaderBox()
        DispatchQueue.global().asyncAfter(deadline: .now() + 3.3) { readerBox.set(PipeReader(fd: readFd)) }
        let start = Date()
        let code: Int32 = await withCheckedContinuation { cont in
            session.onFinished { cont.resume(returning: $0) }
            session.start()
        }
        #expect(code == 0)
        // Stop waited for the stalled reader to drain `stopped` (bounded by finishTimeout).
        #expect(Date().timeIntervalSince(start) >= 3.2)
        #expect(Date().timeIntervalSince(start) < 7)
        close(fds[1])
        let data = try #require(readerBox.get()).wait()
        close(readFd)

        var dec = FrameDecoder()
        let frames = try dec.feed(data)
        let events = frames.filter { $0.kind == .event }.map(eventObject)
        #expect(events.first?["type"] as? String == "started")
        #expect(events.last?["type"] as? String == "stopped")
        // Producers were never blocked: the session generated the full second for each source…
        let stopped = events.last?["samples"] as? [String: Int]
        #expect(stopped?["mic"] == 48000 && stopped?["system"] == 48000)
        // …and what the stalled reader missed is accounted for by overrun events.
        for src in [SourceID.mic, .system] {
            let kept = frames.filter { $0.kind == .audio && $0.source == src }.reduce(0) { $0 + $1.payload.count / 2 }
            let dropped = events.filter { $0["type"] as? String == "overrun" && $0["source"] as? String == src.name }
                .reduce(0) { $0 + ($1["dropped_samples"] as? Int ?? 0) }
            #expect(dropped > 0)
            #expect(kept + dropped == 48000)
        }
    }
}

private final class ReaderBox: @unchecked Sendable {
    private let lock = NSLock()
    private var reader: PipeReader?
    func set(_ r: PipeReader) { lock.lock(); reader = r; lock.unlock() }
    func get() -> PipeReader? { lock.lock(); defer { lock.unlock() }; return reader }
}
