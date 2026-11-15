@preconcurrency import AVFoundation
import CoreAudio
import Foundation
import os

/// System audio ("them") via a Core Audio process tap (macOS 14.2+, supported floor 14.4).
///
/// Setup (see task 2.3 design notes):
/// 1. `CATapDescription(monoGlobalTapButExcludeProcesses:)` — a mono mixdown of every process's output except
///    ours (and any `--exclude-pid`), private to this process, `.unmuted` so the user still hears the call.
/// 2. `AudioHardwareCreateProcessTap` → tap object; its UUID is the tap UID.
/// 3. A private aggregate device whose main sub-device is the current default output device (clock source)
///    and whose tap list contains the tap (drift compensation on, tap auto-start).
/// 4. Before every `AudioDeviceStart` the tap format and the aggregate's rate are (re-)read and the position of
///    the tap's buffer in the aggregate's input list is computed (after the sub-device's own input streams).
/// 5. The IO block only selects that buffer, down-mixes to mono into a preallocated handoff and returns;
///    conversion / framing happen on `SourcePipeline`'s queue.
/// 6. Default output device changes rebuild the aggregate (the tap itself is device-independent) and emit
///    `device_changed`.
/// 7. Rate / format changes on the *same* device (Bluetooth headset switching 48 → 16/24 kHz when its mic opens)
///    are caught by listeners on the aggregate's nominal rate + stream configuration and the tap's format; the
///    IO is stopped, old-rate audio drained, the layout re-read and IO restarted; `format_changed` is emitted.
/// Permission ("System Audio Recording Only") is requested by the OS when IO starts — real capture is a
/// human checkpoint, never run by agents.
public final class SystemAudioSource: CaptureSource, @unchecked Sendable {
    public let id: SourceID = .system
    private let clock: CaptureClock
    private let excludePIDs: [pid_t]
    private let pipeline: SourcePipeline
    private let control = DispatchQueue(label: "oat-audio.system.control")
    private let ioQueue = DispatchQueue(label: "oat-audio.system.io", qos: .userInteractive)

    /// What the IO block needs to interpret the aggregate's input buffers. Written on `control` while IO is
    /// stopped, read on the IO queue.
    struct Layout {
        var stream = StreamLayout(sampleRate: 48_000, channels: 1, bufferIndex: 0)
        var valid = false
    }
    private let layout = OSAllocatedUnfairLock(initialState: Layout())

    // control-queue state
    private weak var delegate: CaptureSourceDelegate?
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var tapUID = ""
    private var outputID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private var removeListener: (@Sendable () -> Void)?
    private var removeFormatListeners: [@Sendable () -> Void] = []
    private var formatCheckPending = false
    private var running = false

    public init(sampleRate: Int, clock: CaptureClock, excludePIDs: [pid_t] = []) {
        self.clock = clock
        self.excludePIDs = excludePIDs
        pipeline = SourcePipeline(id: .system, targetRate: sampleRate, clock: clock,
                                  invalidBufferCode: "tap_buffer_invalid",
                                  invalidBufferMessage: "system IO buffer(s) without exactly one usable tap stream were skipped")
    }

    public func start(delegate: CaptureSourceDelegate) throws {
        pipeline.setDelegate(delegate)
        try control.sync {
            self.delegate = delegate
            try createTap()
            do {
                try startAggregate()
            } catch {
                destroyTap()
                throw error
            }
            running = true
            removeListener = CA.listen(kAudioHardwarePropertyDefaultOutputDevice, queue: control) { [weak self] in
                self?.defaultOutputChanged()
            }
        }
    }

    public func stop() {
        control.sync {
            removeListener?()
            removeListener = nil
            guard running else { return }
            running = false
            stopAggregate()
            destroyTap()
        }
        pipeline.cancel()
    }

    // MARK: tap

    private func createTap() throws {
        var excluded: [AudioObjectID] = []
        for pid in [getpid()] + excludePIDs {
            let obj = CA.processObject(pid: pid)
            if obj != kAudioObjectUnknown { excluded.append(obj) }
        }
        let desc = CATapDescription(monoGlobalTapButExcludeProcesses: excluded)
        desc.uuid = UUID()
        desc.name = "Oat system audio"
        desc.isPrivate = true
        desc.muteBehavior = .unmuted
        var tap = AudioObjectID(kAudioObjectUnknown)
        try check(AudioHardwareCreateProcessTap(desc, &tap), "tap_create_failed", "AudioHardwareCreateProcessTap")
        tapID = tap
        tapUID = desc.uuid.uuidString
        Log.info("system tap created (excluded \(excluded.count) procs)")
    }

    private func destroyTap() {
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
    }

    // MARK: aggregate device + IO

    private func startAggregate() throws {
        let output = try CA.defaultDevice(input: false)
        let outputUID = try CA.deviceUID(output)
        let description: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Oat system tap",
            kAudioAggregateDeviceUIDKey: "oat-audio-tap-" + UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapDriftCompensationKey: true,
                kAudioSubTapUIDKey: tapUID,
            ]],
        ]
        var agg = AudioObjectID(kAudioObjectUnknown)
        try check(AudioHardwareCreateAggregateDevice(description as CFDictionary, &agg),
                  "aggregate_failed", "AudioHardwareCreateAggregateDevice")
        aggregateID = agg
        outputID = output

        // (Re-)read formats now — the new output device may run at a different rate than the previous one.
        do {
            let stream = try readStreamLayout()
            layout.withLockUnchecked { $0 = Layout(stream: stream, valid: true) }
            Log.info("system layout: \(stream.sampleRate) Hz × \(stream.channels) ch, tap buffer index \(stream.bufferIndex)")
        } catch {
            stopAggregate()
            throw error
        }

        var procID: AudioDeviceIOProcID?
        let status = AudioDeviceCreateIOProcIDWithBlock(&procID, agg, ioQueue) { [weak self] _, inInputData, inInputTime, _, _ in
            self?.ioBlock(inInputData, hostTime: inInputTime.pointee.mHostTime)
        }
        guard status == noErr, let procID else {
            stopAggregate()
            throw CoreAudioError("ioproc_failed", status, "AudioDeviceCreateIOProcIDWithBlock")
        }
        ioProcID = procID
        let startStatus = AudioDeviceStart(agg, procID)
        guard startStatus == noErr else {
            stopAggregate()
            throw CoreAudioError("device_start_failed", startStatus, "AudioDeviceStart")
        }
        // Same-device rate/format changes (Bluetooth renegotiation). Unsupported listeners are skipped.
        let onFormat: @Sendable () -> Void = { [weak self] in self?.scheduleFormatCheck() }
        removeFormatListeners = [
            CA.listen(kAudioDevicePropertyNominalSampleRate, object: agg, queue: control, onFormat),
            CA.listen(kAudioDevicePropertyStreamConfiguration, object: agg, queue: control, onFormat),
            CA.listen(kAudioDevicePropertyNominalSampleRate, object: output, queue: control, onFormat),
            CA.listen(kAudioTapPropertyFormat, object: tapID, queue: control, onFormat),
        ].compactMap { $0 }
        Log.info("system capture started via output \(CA.deviceName(output)) (\(removeFormatListeners.count) format listeners)")
    }

    /// Current device-side layout: tap format (float32, mono or interleaved), the aggregate's nominal rate (rate
    /// of the drift-compensated tap stream; falls back to the tap format rate) and the tap's buffer index (= the
    /// output device's input-scope stream count).
    private func readStreamLayout() throws -> StreamLayout {
        let asbd = try CA.tapFormat(tapID)
        let isFloat32 = asbd.mFormatID == kAudioFormatLinearPCM
            && asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0 && asbd.mBitsPerChannel == 32
        let nonInterleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        guard isFloat32, asbd.mChannelsPerFrame >= 1, !(nonInterleaved && asbd.mChannelsPerFrame > 1) else {
            throw CoreAudioError("tap_format", 0, "unsupported tap format (flags \(asbd.mFormatFlags), \(asbd.mBitsPerChannel) bit, \(asbd.mChannelsPerFrame) ch)")
        }
        let aggRate = CA.nominalSampleRate(aggregateID) ?? 0
        let rate = aggRate > 0 ? aggRate : asbd.mSampleRate
        return StreamLayout(sampleRate: rate, channels: asbd.mChannelsPerFrame,
                            bufferIndex: CA.streamCount(outputID, input: true))
    }

    private func stopAggregate() {
        removeFormatListeners.forEach { $0() }
        removeFormatListeners = []
        if aggregateID != kAudioObjectUnknown, let procID = ioProcID {
            AudioDeviceStop(aggregateID, procID)
            AudioDeviceDestroyIOProcID(aggregateID, procID)
        }
        ioProcID = nil
        if aggregateID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        layout.withLockUnchecked { $0.valid = false }
        // IO has stopped: process what is queued and drain converter latency (tail stamped as continuation).
        pipeline.flush()
    }

    /// HAL IO queue. Copy only: no allocation, no conversion, no locks held beyond the handoff's slot bookkeeping.
    private func ioBlock(_ inputData: UnsafePointer<AudioBufferList>, hostTime: UInt64) {
        let l = layout.withLockUnchecked { $0 }
        guard l.valid else { return }
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
        guard let index = TapBufferSelection.index(
            numberBuffers: buffers.count, subDeviceInputStreams: l.stream.bufferIndex,
            expectedChannels: l.stream.channels, channelsOf: { buffers[$0].mNumberChannels })
        else {
            pipeline.markInvalidBuffer()
            return
        }
        let buffer = buffers[index]
        let channels = Int(l.stream.channels)
        guard let data = buffer.mData else { return }
        let frames = Int(buffer.mDataByteSize) / (MemoryLayout<Float>.size * channels)
        let src = UnsafePointer(data.assumingMemoryBound(to: Float.self))
        pipeline.push(frames: frames, sampleRate: l.stream.sampleRate,
                      hostTime: hostTime > 0 ? hostTime : mach_absolute_time()) { dst, offset, count in
            MonoMix.interleaved(src, channels: channels, frameOffset: offset, frames: count, into: dst)
        }
    }

    // MARK: change handling (control queue)

    /// Debounced: rate, stream and tap-format notifications arrive in bursts during renegotiation.
    private func scheduleFormatCheck() {
        guard running, !formatCheckPending else { return }
        formatCheckPending = true
        control.asyncAfter(deadline: .now() + .milliseconds(100)) { [weak self] in self?.checkFormat() }
    }

    private func checkFormat() {
        formatCheckPending = false
        guard running, aggregateID != kAudioObjectUnknown, let procID = ioProcID else { return }
        let current = layout.withLockUnchecked { $0.valid ? $0.stream : nil }
        guard case let .changed(from, to) = FormatChange.evaluate(current: current, observed: try? readStreamLayout())
        else { return }
        // Stop IO so no buffer is labelled with the wrong layout, drain old-rate audio + converter, apply, restart.
        AudioDeviceStop(aggregateID, procID)
        layout.withLockUnchecked { $0.valid = false }
        pipeline.flush()
        layout.withLockUnchecked { $0 = Layout(stream: to, valid: true) }
        let status = AudioDeviceStart(aggregateID, procID)
        if status != noErr {
            failFatally(CoreAudioError("device_start_failed", status, "AudioDeviceStart after format change"))
            return
        }
        delegate?.source(id, formatChangedFrom: from.sampleRate, to: to.sampleRate, channels: to.channels)
    }

    private func defaultOutputChanged() {
        guard running else { return }
        stopAggregate()
        do {
            try startAggregate()
            delegate?.source(id, deviceChanged: CA.deviceName(outputID))
        } catch {
            failFatally(error)
        }
    }

    private func failFatally(_ error: Error) {
        running = false
        removeListener?()
        removeListener = nil
        stopAggregate()
        destroyTap()
        let code = (error as? CodedError)?.code ?? "device_lost"
        delegate?.source(id, didFailWithCode: code, message: "\(error)", fatal: true)
    }
}
