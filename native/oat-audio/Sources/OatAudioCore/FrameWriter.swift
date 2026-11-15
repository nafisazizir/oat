import Darwin
import Foundation

/// Destination for frames. `write` must never block (it is called with the session lock held, from capture
/// processing queues); `finish` blocks until everything queued is out or the timeout passes (called once at stop).
public protocol FrameSink: AnyObject, Sendable {
    /// Returns false when the output is gone (e.g. EPIPE); the session then stops.
    func write(_ frame: Frame) -> Bool
    func finish(timeout: TimeInterval)
}

/// Collects frames in memory (tests).
public final class MemoryFrameSink: FrameSink, @unchecked Sendable {
    private let lock = NSLock()
    private var _frames: [Frame] = []

    public init() {}

    public func write(_ frame: Frame) -> Bool {
        lock.lock(); _frames.append(frame); lock.unlock()
        return true
    }

    public func finish(timeout: TimeInterval) {}

    public var frames: [Frame] {
        lock.lock(); defer { lock.unlock() }
        return _frames
    }
}

/// Logs go to stderr only — stdout is reserved for frames.
public enum Log {
    private static let lock = NSLock()
    nonisolated(unsafe) public static var enabled = true

    public static func info(_ message: @autoclosure () -> String) {
        guard enabled else { return }
        let line = "oat-audio: \(message())\n"
        lock.lock()
        FileHandle.standardError.write(Data(line.utf8))
        lock.unlock()
    }
}
