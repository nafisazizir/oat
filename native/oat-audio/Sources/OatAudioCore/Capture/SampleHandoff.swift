import Foundation
import os

/// Single-producer / single-consumer handoff from an audio callback to a processing queue.
///
/// All storage is preallocated; the producer (HAL IO block / AVAudioEngine tap) only takes an unfair lock for a
/// few integer updates and copies samples into a free slot — no allocation, no conversion, no I/O, never waits on
/// the consumer. If every slot is full the incoming audio is dropped and counted exactly. The drop is attached to
/// the next committed slot (`gapFrames`), so the consumer knows precisely *where* in the stream audio is missing;
/// drops with no later slot yet are returned as `trailingDropFrames`.
public final class SampleHandoff: @unchecked Sendable {
    public struct Chunk: Sendable {
        public var samples: [Float]
        public var sampleRate: Double
        public var hostTime: UInt64
        /// Frames between `hostTime` and the first sample (a large callback split over several slots).
        public var frameOffset: Int
        /// Frames dropped immediately before this chunk (at `gapRate`), 0 if none.
        public var gapFrames: Int
        public var gapRate: Double
    }

    public struct Drained: Sendable {
        public var chunks: [Chunk]
        /// Frames dropped after the last chunk (no later chunk committed yet), at `trailingDropRate`.
        public var trailingDropFrames: Int
        public var trailingDropRate: Double
        public var invalidBuffers: Int
    }

    struct State {
        var head = 0
        var count = 0
        var pendingDropFrames = 0
        var pendingDropRate = 0.0
        var invalidBuffers = 0
    }

    public let slotCount: Int
    public let slotCapacity: Int
    private let storage: UnsafeMutablePointer<Float>
    private let slotFrames: UnsafeMutablePointer<Int>
    private let slotRate: UnsafeMutablePointer<Double>
    private let slotHost: UnsafeMutablePointer<UInt64>
    private let slotOffset: UnsafeMutablePointer<Int>
    private let slotGap: UnsafeMutablePointer<Int>
    private let slotGapRate: UnsafeMutablePointer<Double>
    private let state = OSAllocatedUnfairLock(initialState: State())

    public init(slotCount: Int = 64, slotCapacity: Int = 8192) {
        precondition(slotCount > 0 && slotCapacity > 0)
        self.slotCount = slotCount
        self.slotCapacity = slotCapacity
        storage = .allocate(capacity: slotCount * slotCapacity)
        storage.initialize(repeating: 0, count: slotCount * slotCapacity)
        slotFrames = .allocate(capacity: slotCount); slotFrames.initialize(repeating: 0, count: slotCount)
        slotRate = .allocate(capacity: slotCount); slotRate.initialize(repeating: 0, count: slotCount)
        slotHost = .allocate(capacity: slotCount); slotHost.initialize(repeating: 0, count: slotCount)
        slotOffset = .allocate(capacity: slotCount); slotOffset.initialize(repeating: 0, count: slotCount)
        slotGap = .allocate(capacity: slotCount); slotGap.initialize(repeating: 0, count: slotCount)
        slotGapRate = .allocate(capacity: slotCount); slotGapRate.initialize(repeating: 0, count: slotCount)
    }

    deinit {
        storage.deallocate(); slotFrames.deallocate(); slotRate.deallocate()
        slotHost.deallocate(); slotOffset.deallocate(); slotGap.deallocate(); slotGapRate.deallocate()
    }

    /// Producer side (audio thread). `fill(dst, frameOffset, frameCount)` writes `frameCount` mono samples.
    /// Returns false if (part of) the audio was dropped because the consumer is behind.
    @discardableResult
    public func write(frames: Int, sampleRate: Double, hostTime: UInt64,
                      fill: (UnsafeMutablePointer<Float>, Int, Int) -> Void) -> Bool
    {
        var offset = 0
        while offset < frames {
            let n = min(slotCapacity, frames - offset)
            let capacity = slotCount
            let slot: Int? = state.withLockUnchecked { s in
                s.count < capacity ? (s.head + s.count) % capacity : nil
            }
            guard let slot else {
                let lost = frames - offset
                state.withLockUnchecked { s in
                    s.pendingDropFrames += lost
                    s.pendingDropRate = sampleRate
                }
                return false
            }
            fill(storage + slot * slotCapacity, offset, n)
            slotFrames[slot] = n
            slotRate[slot] = sampleRate
            slotHost[slot] = hostTime
            slotOffset[slot] = offset
            let gap = slotGap, gapRate = slotGapRate
            // Commit: attach pending drops to this slot; lock release publishes the slot contents.
            state.withLockUnchecked { s in
                gap[slot] = s.pendingDropFrames
                gapRate[slot] = s.pendingDropRate
                s.pendingDropFrames = 0
                s.count += 1
            }
            offset += n
        }
        return true
    }

    /// Producer side: the callback delivered a buffer we could not use (counted, reported once by the consumer).
    public func markInvalidBuffer() {
        state.withLockUnchecked { $0.invalidBuffers += 1 }
    }

    /// Consumer side (processing queue).
    public func drain() -> Drained {
        let snapshot = state.withLockUnchecked { s -> State in
            let copy = s
            s.pendingDropFrames = 0
            s.invalidBuffers = 0
            return copy
        }
        var chunks: [Chunk] = []
        chunks.reserveCapacity(snapshot.count)
        for k in 0..<snapshot.count {
            let slot = (snapshot.head + k) % slotCount
            let base = storage + slot * slotCapacity
            chunks.append(Chunk(samples: Array(UnsafeBufferPointer(start: base, count: slotFrames[slot])),
                                sampleRate: slotRate[slot], hostTime: slotHost[slot], frameOffset: slotOffset[slot],
                                gapFrames: slotGap[slot], gapRate: slotGapRate[slot]))
        }
        let capacity = slotCount
        state.withLockUnchecked { s in
            s.head = (snapshot.head + snapshot.count) % capacity
            s.count -= snapshot.count
        }
        return Drained(chunks: chunks, trailingDropFrames: snapshot.pendingDropFrames,
                       trailingDropRate: snapshot.pendingDropRate, invalidBuffers: snapshot.invalidBuffers)
    }
}

/// Down-mixing helpers used on audio threads (no allocation).
public enum MonoMix {
    /// Interleaved float32 (`channels` per frame) → mono average.
    public static func interleaved(_ src: UnsafePointer<Float>, channels: Int, frameOffset: Int, frames: Int,
                                   into dst: UnsafeMutablePointer<Float>)
    {
        if channels == 1 {
            dst.update(from: src + frameOffset, count: frames)
            return
        }
        let scale = 1 / Float(channels)
        for i in 0..<frames {
            let base = src + (frameOffset + i) * channels
            var sum: Float = 0
            for c in 0..<channels { sum += base[c] }
            dst[i] = sum * scale
        }
    }

    /// Planar float32 (one pointer per channel) → mono. `firstChannelOnly` = take channel 0 (voice processing
    /// puts the processed signal there), otherwise average all channels.
    public static func planar(_ channelData: UnsafePointer<UnsafeMutablePointer<Float>>, channels: Int,
                              firstChannelOnly: Bool, frameOffset: Int, frames: Int,
                              into dst: UnsafeMutablePointer<Float>)
    {
        if channels == 1 || firstChannelOnly {
            dst.update(from: channelData[0] + frameOffset, count: frames)
            return
        }
        let scale = 1 / Float(channels)
        for i in 0..<frames {
            var sum: Float = 0
            for c in 0..<channels { sum += channelData[c][frameOffset + i] }
            dst[i] = sum * scale
        }
    }
}

/// Which buffer of the aggregate device's input `AudioBufferList` is the process tap.
///
/// The aggregate's input side lists the sub-device's input streams first (one buffer per stream — e.g. a USB
/// headset's mic) followed by our single tap stream, so the list must have exactly `subDeviceInputStreams + 1`
/// buffers and the tap is the last one. Any other layout (missing or extra buffers, channel count not matching the
/// tap format) is rejected rather than guessed — reading the wrong buffer would put the user's own mic into "them".
public enum TapBufferSelection {
    public static func index(numberBuffers: Int, subDeviceInputStreams: Int, expectedChannels: UInt32,
                             channelsOf: (Int) -> UInt32) -> Int?
    {
        guard subDeviceInputStreams >= 0, numberBuffers == subDeviceInputStreams + 1 else { return nil }
        let idx = subDeviceInputStreams
        guard channelsOf(idx) == expectedChannels else { return nil }
        return idx
    }
}

/// The input-side format a source is currently configured for.
public struct StreamLayout: Equatable, Sendable {
    public var sampleRate: Double
    public var channels: UInt32
    /// Index of the buffer to read (system tap: number of sub-device input streams; mic: 0).
    public var bufferIndex: Int

    public init(sampleRate: Double, channels: UInt32, bufferIndex: Int = 0) {
        self.sampleRate = sampleRate
        self.channels = channels
        self.bufferIndex = bufferIndex
    }
}

/// Decides whether a format/rate notification requires reconfiguring the capture path (pure; tested).
///
/// Core Audio fires rate / format / stream notifications in bursts and sometimes with transient values (rate 0
/// while a Bluetooth device renegotiates). Only a readable, different layout triggers a reconfigure; the caller
/// then stops IO, drains the old-rate audio and converter, applies the new layout, restarts and emits
/// `format_changed`.
public enum FormatChange: Equatable, Sendable {
    case none
    case changed(from: StreamLayout, to: StreamLayout)

    public static func evaluate(current: StreamLayout?, observed: StreamLayout?) -> FormatChange {
        guard let current else { return .none } // not running / not configured: start-up path handles it
        guard let observed, observed.sampleRate.isFinite, observed.sampleRate > 0, observed.channels > 0 else {
            return .none // unreadable or transient; wait for the next notification
        }
        let sameRate = abs(observed.sampleRate - current.sampleRate) < 0.5
        if sameRate && observed.channels == current.channels && observed.bufferIndex == current.bufferIndex {
            return .none
        }
        return .changed(from: current, to: observed)
    }
}
