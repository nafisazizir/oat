import Darwin
import Foundation

/// Bounded FIFO of outgoing frames (pure value type; `QueuedFrameSink` wraps it with a writer thread).
///
/// Capacity is counted in encoded bytes of queued frames. When a push exceeds it, the **oldest audio** frames are
/// dropped (events are never dropped) and replaced in place by an `overrun` marker that becomes an
/// `{"type":"overrun","stage":"output",…}` event when popped — so the reader sees exactly where audio is missing.
/// Adjacent markers for the same source are merged.
public struct BoundedFrameQueue: Sendable {
    enum Item: Sendable {
        case frame(Frame)
        case overrun(source: SourceID, samples: Int, firstTUs: UInt64)
    }

    public let capacityBytes: Int
    public let sampleRate: Int
    private var items: [Item] = []
    private var head = 0
    public private(set) var queuedBytes = 0
    /// Total audio samples dropped per source since creation.
    public private(set) var droppedSamples: [SourceID: Int] = [:]

    public init(capacityBytes: Int, sampleRate: Int) {
        self.capacityBytes = max(1, capacityBytes)
        self.sampleRate = sampleRate
    }

    public var isEmpty: Bool { head >= items.count }
    public var count: Int { items.count - head }

    static func size(_ f: Frame) -> Int { OatProtocol.headerSize + f.payload.count }

    public mutating func push(_ frame: Frame) {
        items.append(.frame(frame))
        queuedBytes += Self.size(frame)
        while queuedBytes > capacityBytes, dropOldestAudio() {}
    }

    public mutating func pop() -> Frame? {
        guard head < items.count else { return nil }
        let item = items[head]
        head += 1
        if head > 256 && head * 2 > items.count {
            items.removeFirst(head)
            head = 0
        }
        switch item {
        case .frame(let f):
            queuedBytes -= Self.size(f)
            return f
        case let .overrun(source, samples, firstTUs):
            return CaptureEvent.overrun(source: source, stage: "output", droppedSamples: samples,
                                        droppedMs: samples * 1000 / max(1, sampleRate)).frame(tUs: firstTUs)
        }
    }

    private mutating func dropOldestAudio() -> Bool {
        var i = head
        while i < items.count {
            if case .frame(let f) = items[i], f.kind == .audio {
                queuedBytes -= Self.size(f)
                let samples = f.payload.count / 2
                droppedSamples[f.source, default: 0] += samples
                // Merge into an overrun marker for the same source in the run of markers just before i.
                var j = i - 1
                while j >= head, case .overrun(let s, let n, let t) = items[j] {
                    if s == f.source {
                        items[j] = .overrun(source: s, samples: n + samples, firstTUs: t)
                        items.remove(at: i)
                        return true
                    }
                    j -= 1
                }
                items[i] = .overrun(source: f.source, samples: samples, firstTUs: f.tUs)
                return true
            }
            i += 1
        }
        return false
    }
}

/// Writes `data` fully to `fd`. Blocks (never spins): on EAGAIN (non-blocking fd) it waits in `poll(POLLOUT)`.
/// Returns false when the reader is gone (EPIPE etc.).
public func writeAll(fd: Int32, _ data: Data) -> Bool {
    data.withUnsafeBytes { raw -> Bool in
        guard var p = raw.baseAddress else { return true }
        var remaining = raw.count
        while remaining > 0 {
            let n = Darwin.write(fd, p, remaining)
            if n < 0 {
                switch errno {
                case EINTR: continue
                case EAGAIN:
                    var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                    _ = poll(&pfd, 1, 1000)
                    if pfd.revents & Int16(POLLERR | POLLHUP | POLLNVAL) != 0 { return false }
                    continue
                default: return false
                }
            }
            remaining -= n
            p = p.advanced(by: n)
        }
        return true
    }
}

/// Non-blocking `FrameSink`: `write` only enqueues into a `BoundedFrameQueue`; a dedicated writer thread does the
/// (possibly blocking) `write(2)` to stdout. A slow reader therefore never stalls capture — at worst the oldest
/// queued audio is dropped and an `overrun` event marks the gap.
public final class QueuedFrameSink: FrameSink, @unchecked Sendable {
    private let fd: Int32
    private let cond = NSCondition()
    private var queue: BoundedFrameQueue
    private var broken = false
    private var writing = false

    public init(fd: Int32 = STDOUT_FILENO, capacityBytes: Int, sampleRate: Int) {
        self.fd = fd
        queue = BoundedFrameQueue(capacityBytes: capacityBytes, sampleRate: sampleRate)
        let thread = Thread { [self] in self.run() }
        thread.name = "oat-audio.writer"
        thread.qualityOfService = .userInitiated
        thread.start()
    }

    public func write(_ frame: Frame) -> Bool {
        cond.lock()
        defer { cond.unlock() }
        if broken { return false }
        queue.push(frame)
        cond.signal()
        return true
    }

    public func finish(timeout: TimeInterval) {
        let deadline = Date().addingTimeInterval(timeout)
        cond.lock()
        while (!queue.isEmpty || writing) && !broken {
            if !cond.wait(until: deadline) { break }
        }
        cond.unlock()
    }

    /// Dropped samples per source so far (diagnostics/tests).
    public var droppedSamples: [SourceID: Int] {
        cond.lock(); defer { cond.unlock() }
        return queue.droppedSamples
    }

    private func run() {
        while true {
            cond.lock()
            while queue.isEmpty { cond.wait() }
            let frame = queue.pop()!
            writing = true
            cond.unlock()

            let ok = writeAll(fd: fd, frame.encoded())

            cond.lock()
            writing = false
            if !ok { broken = true }
            cond.broadcast()
            cond.unlock()
            if !ok { return }
        }
    }
}
