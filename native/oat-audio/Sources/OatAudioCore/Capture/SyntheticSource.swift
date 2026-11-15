import Foundation

/// Generates deterministic audio in real time (paced by the capture clock) and feeds it through the same
/// session → FrameAssembler → sink path as real capture. Needs no permissions.
public final class SyntheticSource: CaptureSource, @unchecked Sendable {
    public let id: SourceID
    private let generator: SyntheticGenerator
    private let clock: CaptureClock
    private let sampleRate: Int
    /// Stop generating after this many samples (the `--duration` cap), nil = unbounded.
    private let maxSamples: Int?
    private let tickMs: Int
    private let queue: DispatchQueue
    private var timer: DispatchSourceTimer?
    private weak var delegate: CaptureSourceDelegate?
    private var startUs: UInt64 = 0
    private var produced = 0
    private var running = false

    public init(id: SourceID, sampleRate: Int, clock: CaptureClock, maxSamples: Int? = nil, tickMs: Int = 20) {
        self.id = id
        self.sampleRate = sampleRate
        self.clock = clock
        self.maxSamples = maxSamples
        self.tickMs = tickMs
        generator = SyntheticGenerator(source: id, sampleRate: sampleRate)
        queue = DispatchQueue(label: "oat-audio.synthetic.\(id.name)")
    }

    public func start(delegate: CaptureSourceDelegate) throws {
        queue.sync {
            self.delegate = delegate
            startUs = clock.nowUs()
            produced = 0
            running = true
            let t = DispatchSource.makeTimerSource(queue: queue)
            t.schedule(deadline: .now() + .milliseconds(tickMs), repeating: .milliseconds(tickMs),
                       leeway: .milliseconds(2))
            t.setEventHandler { [weak self] in self?.tick() }
            timer = t
            t.resume()
        }
    }

    /// Runs on `queue`: emit everything due up to now.
    private func tick() {
        guard running, let delegate else { return }
        let elapsedUs = clock.nowUs() &- startUs
        var target = Int(elapsedUs * UInt64(sampleRate) / 1_000_000)
        if let maxSamples { target = min(target, maxSamples) }
        guard target > produced else { return }
        let samples = generator.samples(from: produced, count: target - produced)
        let timeUs = startUs + UInt64(produced) * 1_000_000 / UInt64(sampleRate)
        produced = target
        delegate.source(id, didCapture: samples, timeUs: timeUs)
    }

    public func stop() {
        queue.sync {
            guard running else { return }
            tick() // deliver what is due before stopping
            running = false
            timer?.cancel()
            timer = nil
        }
    }
}
