import Foundation

/// Receives converted audio (target-rate mono s16) and status from a source. Called from source threads.
public protocol CaptureSourceDelegate: AnyObject, Sendable {
    /// `timeUs`: capture-clock time of the first sample in `samples`.
    func source(_ source: SourceID, didCapture samples: [Int16], timeUs: UInt64)
    func source(_ source: SourceID, didFailWithCode code: String, message: String, fatal: Bool)
    func source(_ source: SourceID, deviceChanged device: String)
    /// Audio was dropped before it reached the session (processing fell behind the audio callback). Called in
    /// stream order: everything delivered before belongs before the gap. `samples` is exact at the target rate.
    func source(_ source: SourceID, didDropSamples samples: Int, ms: Int)
    /// The device-side format changed on the same device (e.g. Bluetooth headset 48 → 16 kHz); capture continues.
    func source(_ source: SourceID, formatChangedFrom previousRate: Double, to sampleRate: Double, channels: UInt32)
}

/// One capture stream (mic, system tap, or synthetic).
public protocol CaptureSource: AnyObject, Sendable {
    var id: SourceID { get }
    /// Start delivering audio. Throwing = this source could not start (others continue).
    func start(delegate: CaptureSourceDelegate) throws
    /// Stop synchronously. Remaining buffered audio must be delivered before returning; nothing after.
    func stop()
}

/// Orchestrates sources → frame assembly → sink, plus pause/resume/stop and the event stream.
public final class CaptureSession: CaptureSourceDelegate, @unchecked Sendable {
    public enum State: Equatable, Sendable { case idle, running, paused, stopping, stopped }

    private let options: CaptureOptions
    private let sources: [CaptureSource]
    private let sink: FrameSink
    private let clock: CaptureClock
    private let queue = DispatchQueue(label: "oat-audio.session")
    private let lock = NSLock()

    private var state: State = .idle
    private var assemblers: [SourceID: FrameAssembler] = [:]
    private var meters: [SourceID: LevelMeter] = [:]
    private var active: Set<SourceID> = []
    private var openingSources = false
    private var captureReady = false
    private var durationTimer: DispatchSourceTimer?
    private var finishedCallbacks: [@Sendable (Int32) -> Void] = []
    private var exitCode: Int32?
    private var stopFromPaused = false

    /// How long `stop` waits for the sink to write out queued frames before finishing anyway.
    private let finishTimeout: TimeInterval

    public init(options: CaptureOptions, sources: [CaptureSource], sink: FrameSink, clock: CaptureClock,
                finishTimeout: TimeInterval = 3)
    {
        self.finishTimeout = finishTimeout
        self.options = options
        self.sources = sources
        self.sink = sink
        self.clock = clock
        for s in sources {
            assemblers[s.id] = FrameAssembler(source: s.id, sampleRate: options.sampleRate, frameMs: options.frameMs)
            meters[s.id] = LevelMeter(sampleRate: options.sampleRate)
        }
    }

    public var currentState: State {
        lock.lock(); defer { lock.unlock() }
        return state
    }

    /// Called once with the process exit code after `stopped` has been written.
    public func onFinished(_ callback: @escaping @Sendable (Int32) -> Void) {
        lock.lock()
        if let code = exitCode {
            lock.unlock()
            callback(code)
            return
        }
        finishedCallbacks.append(callback)
        lock.unlock()
    }

    // MARK: lifecycle

    public func start() {
        lock.lock()
        guard state == .idle else { lock.unlock(); return }
        state = .running
        openingSources = true
        emitLocked(.started(sampleRate: options.sampleRate, frameMs: options.frameMs,
                            sources: sources.map(\.id), synthetic: options.synthetic,
                            aec: options.aec && options.mic && !options.synthetic))
        lock.unlock()

        for s in sources {
            lock.lock()
            guard state == .running || state == .paused else { lock.unlock(); return }
            active.insert(s.id)
            lock.unlock()
            do {
                try s.start(delegate: self)
                lock.lock()
                if state == .running && active.contains(s.id) { announceCaptureReadyLocked() }
                lock.unlock()
            } catch {
                lock.lock()
                active.remove(s.id)
                let code = (error as? CodedError)?.code ?? "start_failed"
                emitLocked(.error(source: s.id, code: code, message: "\(error)", fatal: true))
                lock.unlock()
                Log.info("\(s.id) failed to start: \(error)")
            }
        }

        lock.lock()
        openingSources = false
        guard state == .running || state == .paused else { lock.unlock(); return }
        let anyActive = !active.isEmpty
        lock.unlock()
        if !anyActive {
            stop(reason: .error)
            return
        }

        if let d = options.durationSeconds {
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + d)
            timer.setEventHandler { [weak self] in self?.stop(reason: .duration) }
            lock.lock(); durationTimer = timer; lock.unlock()
            timer.resume()
        }
    }

    public func handle(_ command: ControlCommand) {
        switch command {
        case .stop:
            stop(reason: .command)
        case .pause:
            lock.lock()
            if state == .running {
                state = .paused
                for id in assemblers.keys { writeLocked(assemblers[id]!.reset()) }
                emitLocked(.paused)
            }
            lock.unlock()
        case .resume:
            lock.lock()
            if state == .paused {
                state = .running
                emitLocked(.resumed)
            }
            lock.unlock()
        }
    }

    /// Report a non-audio problem (e.g. a malformed control line).
    public func reportError(code: String, message: String) {
        lock.lock()
        if state != .stopped { emitLocked(.error(source: .none, code: code, message: message, fatal: false)) }
        lock.unlock()
    }

    /// Graceful stop: sources flush, pending partial frames are written, then `stopped`. Idempotent.
    public func stop(reason: StopReason) {
        lock.lock()
        guard state != .stopping && state != .stopped else { lock.unlock(); return }
        let wasPaused = state == .paused
        state = .stopping
        stopFromPaused = wasPaused
        durationTimer?.cancel()
        durationTimer = nil
        lock.unlock()

        // Outside the lock: sources may deliver their last samples while stopping.
        for s in sources { s.stop() }

        lock.lock()
        state = .stopped
        if !wasPaused {
            for id in assemblers.keys.sorted(by: { $0.rawValue < $1.rawValue }) {
                writeLocked(assemblers[id]!.flush())
            }
        }
        let samples = sources.map { ($0.id, assemblers[$0.id]?.totalSamplesEmitted ?? 0) }
        emitLocked(.stopped(reason: reason, samples: samples))
        let code: Int32 = reason == .error ? 1 : 0
        exitCode = code
        let callbacks = finishedCallbacks
        finishedCallbacks = []
        lock.unlock()
        // Let the writer get `stopped` (and everything before it) out; bounded so a dead reader can't hang us.
        sink.finish(timeout: finishTimeout)
        callbacks.forEach { $0(code) }
    }

    // MARK: CaptureSourceDelegate

    public func source(_ source: SourceID, didCapture samples: [Int16], timeUs: UInt64) {
        lock.lock()
        defer { lock.unlock() }
        // Accept audio while running and while sources flush during stop; drop while paused.
        guard state == .running || (state == .stopping && !stopFromPaused), var a = assemblers[source] else { return }
        // A source can deliver audio before its start() returns.
        if state == .running && active.contains(source) { announceCaptureReadyLocked() }
        guard captureReady else { return }
        let frames = a.append(samples, timeUs: timeUs)
        assemblers[source] = a
        writeLocked(frames)
        if var m = meters[source] {
            for level in m.add(samples) {
                emitLocked(.level(source: source, rmsDb: level.rmsDb, peakDb: level.peakDb))
            }
            meters[source] = m
        }
    }

    public func source(_ source: SourceID, didFailWithCode code: String, message: String, fatal: Bool) {
        lock.lock()
        guard state != .stopped else { lock.unlock(); return }
        emitLocked(.error(source: source, code: code, message: message, fatal: fatal))
        var noneLeft = false
        if fatal {
            active.remove(source)
            noneLeft = !openingSources && active.isEmpty && (state == .running || state == .paused)
        }
        lock.unlock()
        Log.info("\(source) error \(code): \(message)\(fatal ? " (fatal for this source)" : "")")
        if noneLeft {
            queue.async { [weak self] in self?.stop(reason: .error) }
        }
    }

    public func source(_ source: SourceID, didDropSamples samples: Int, ms: Int) {
        lock.lock()
        if state != .stopped {
            // Close the current timeline segment so audio after the gap is stamped at its real time,
            // however short the gap (no re-anchor threshold involved).
            if var a = assemblers[source] {
                writeLocked(a.reset())
                assemblers[source] = a
            }
            emitLocked(.overrun(source: source, stage: "capture", droppedSamples: samples, droppedMs: ms))
        }
        lock.unlock()
        Log.info("\(source) overrun: dropped \(ms) ms before processing")
    }

    public func source(_ source: SourceID, formatChangedFrom previousRate: Double, to sampleRate: Double,
                       channels: UInt32)
    {
        lock.lock()
        if state != .stopped {
            emitLocked(.formatChanged(source: source, deviceSampleRate: sampleRate,
                                      previousDeviceSampleRate: previousRate, channels: Int(channels)))
        }
        lock.unlock()
        Log.info("\(source) device format changed \(previousRate) → \(sampleRate) Hz, \(channels) ch")
    }

    public func source(_ source: SourceID, deviceChanged device: String) {
        lock.lock()
        if state != .stopped { emitLocked(.deviceChanged(source: source, device: device)) }
        lock.unlock()
        Log.info("\(source) device changed → \(device)")
    }

    // MARK: output (lock held)

    private func announceCaptureReadyLocked() {
        guard !captureReady else { return }
        captureReady = true
        emitLocked(.captureReady)
    }

    private func emitLocked(_ event: CaptureEvent) {
        write(event.frame(tUs: clock.nowUs()))
    }

    private func writeLocked(_ frames: [Frame]) {
        frames.forEach(write)
    }

    /// `sink.write` never blocks (QueuedFrameSink only enqueues), so holding the lock here is cheap.
    private func write(_ frame: Frame) {
        if !sink.write(frame) {
            // Reader is gone; nothing more can be delivered. Stop asynchronously (we hold the lock).
            queue.async { [weak self] in self?.stop(reason: .outputClosed) }
        }
    }
}
