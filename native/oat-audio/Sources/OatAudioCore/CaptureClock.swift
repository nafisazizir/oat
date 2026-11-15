import Darwin
import Foundation

/// The single clock both sources are stamped with: microseconds since capture start.
public protocol CaptureClock: Sendable {
    /// Microseconds since the clock's origin (capture start). Never decreases.
    func nowUs() -> UInt64
    /// Convert a Core Audio / AVAudioTime host time (mach_absolute_time ticks) to capture-clock µs.
    /// Host times before the origin clamp to 0.
    func hostTimeToUs(_ hostTime: UInt64) -> UInt64
}

/// Clock based on `mach_absolute_time`, the same timebase Core Audio uses for `mHostTime`, so audio
/// buffer timestamps from both the mic (AVAudioTime.hostTime) and the tap IO proc (AudioTimeStamp.mHostTime)
/// map onto one timeline without cross-clock conversion.
public final class HostCaptureClock: CaptureClock, @unchecked Sendable {
    private let originTicks: UInt64
    private let numer: UInt64
    private let denom: UInt64
    private let lock = NSLock()
    private var lastUs: UInt64 = 0

    public init(originTicks: UInt64 = mach_absolute_time()) {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        self.numer = UInt64(info.numer)
        self.denom = UInt64(info.denom)
        self.originTicks = originTicks
    }

    public func ticksToUs(_ ticks: UInt64) -> UInt64 {
        // ns = ticks * numer / denom; split to avoid overflow for long uptimes.
        let ns = (ticks / denom) * numer + (ticks % denom) * numer / denom
        return ns / 1000
    }

    public func hostTimeToUs(_ hostTime: UInt64) -> UInt64 {
        guard hostTime > originTicks else { return 0 }
        return ticksToUs(hostTime - originTicks)
    }

    public func nowUs() -> UInt64 {
        let raw = hostTimeToUs(mach_absolute_time())
        lock.lock()
        defer { lock.unlock() }
        // mach_absolute_time is monotonic; the clamp makes the guarantee explicit across threads.
        if raw > lastUs { lastUs = raw }
        return lastUs
    }
}

/// Test clock advanced by hand.
public final class ManualClock: CaptureClock, @unchecked Sendable {
    private let lock = NSLock()
    private var now: UInt64

    public init(startUs: UInt64 = 0) { now = startUs }

    public func advance(byUs delta: UInt64) {
        lock.lock(); now += delta; lock.unlock()
    }

    public func nowUs() -> UInt64 {
        lock.lock(); defer { lock.unlock() }
        return now
    }

    public func hostTimeToUs(_ hostTime: UInt64) -> UInt64 { hostTime }
}
