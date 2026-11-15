import Foundation

/// Trailing-edge debounce with a ceiling: `action` runs once `delay` after the last `signal()`, but no later
/// than `maxWait` after the first signal of a burst (so a constant stream of changes still reports).
/// Thread-safe; `action` runs on `queue`.
public final class Debouncer: @unchecked Sendable {
    private let delay: TimeInterval
    private let maxWait: TimeInterval
    private let queue: DispatchQueue
    private let action: @Sendable () -> Void
    private let lock = NSLock()
    private var pending: DispatchWorkItem?
    private var burstStart: DispatchTime?
    private var generation = 0

    public init(delay: TimeInterval, maxWait: TimeInterval? = nil,
                queue: DispatchQueue = DispatchQueue(label: "oat-audio.debounce"),
                action: @escaping @Sendable () -> Void)
    {
        self.delay = max(0, delay)
        self.maxWait = max(self.delay, maxWait ?? self.delay * 4)
        self.queue = queue
        self.action = action
    }

    public func signal() {
        lock.lock()
        defer { lock.unlock() }
        let now = DispatchTime.now()
        let start = burstStart ?? now
        burstStart = start
        pending?.cancel()
        let ceiling = start + maxWait
        let due = min(now + delay, ceiling)
        generation += 1
        let gen = generation
        let item = DispatchWorkItem { [weak self] in self?.fire(gen) }
        pending = item
        queue.asyncAfter(deadline: due, execute: item)
    }

    /// Drops a pending call.
    public func cancel() {
        lock.lock()
        pending?.cancel()
        pending = nil
        burstStart = nil
        lock.unlock()
    }

    private func fire(_ gen: Int) {
        lock.lock()
        guard gen == generation, pending != nil else { // superseded or cancelled after being dequeued
            lock.unlock()
            return
        }
        pending = nil
        burstStart = nil
        lock.unlock()
        action()
    }
}
