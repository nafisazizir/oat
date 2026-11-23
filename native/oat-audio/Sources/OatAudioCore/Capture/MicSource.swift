@preconcurrency import AVFoundation
import CoreAudio
import Foundation

/// Microphone ("me") via AVAudioEngine's input node.
///
/// The tap block only down-mixes into a preallocated `SampleHandoff`; conversion to target-rate mono s16 and
/// framing happen on `SourcePipeline`'s queue, so a slow consumer can never stall the audio thread.
///
/// Echo cancellation (default on): Apple voice processing (VPIO) is enabled on the input node so that, when the
/// user is on speakers, the far side played through the output device is removed from the "me" stream. On macOS
/// VPIO uses the output device's playback as the echo reference. Other-audio ducking is set to the minimum with
/// advanced (voice-activity) ducking off, so the call audio the user hears — and the system tap records — is not
/// attenuated more than the OS forces. If voice processing cannot be enabled, capture continues without it and a
/// non-fatal `aec_unavailable` error event is emitted. `--no-aec` (headphones) skips VPIO entirely.
///
/// Default-input changes and engine configuration changes (sample-rate switch, device unplugged) tear the engine
/// down and build a fresh one bound to the current default input (debounced, rate-limited); `device_changed` is
/// emitted only if the input device actually changed.
/// Accessing `inputNode` / starting the engine triggers the microphone permission prompt — real capture is a
/// human checkpoint, never run by agents.
public final class MicSource: CaptureSource, @unchecked Sendable {
    public let id: SourceID = .mic
    private let clock: CaptureClock
    private let pipeline: SourcePipeline
    private let control = DispatchQueue(label: "oat-audio.mic.control")
    private let echoCancellation: Bool

    // control-queue state
    private weak var delegate: CaptureSourceDelegate?
    private var engine: AVAudioEngine?
    private var configObserver: NSObjectProtocol?
    private var removeListener: (@Sendable () -> Void)?
    private var running = false
    private var restartPending = false
    private var lastRestart: DispatchTime = .init(uptimeNanoseconds: 0)
    private var currentDevice = AudioObjectID(kAudioObjectUnknown)
    private var currentLayout: StreamLayout?

    /// Minimum spacing between engine rebuilds; guards against a configuration-change ↔ restart loop.
    static let minRestartInterval: Double = 1.0

    public init(sampleRate: Int, clock: CaptureClock, echoCancellation: Bool = true) {
        self.clock = clock
        self.echoCancellation = echoCancellation
        pipeline = SourcePipeline(id: .mic, targetRate: sampleRate, clock: clock,
                                  invalidBufferCode: "mic_buffer_invalid",
                                  invalidBufferMessage: "mic buffer(s) not in float format were skipped")
    }

    public func start(delegate: CaptureSourceDelegate) throws {
        pipeline.setDelegate(delegate)
        try control.sync {
            self.delegate = delegate
            try startEngine()
            running = true
            removeListener = CA.listen(kAudioHardwarePropertyDefaultInputDevice, queue: control) { [weak self] in
                self?.scheduleRestart(reason: "default input changed")
            }
        }
    }

    public func stop() {
        control.sync {
            removeListener?()
            removeListener = nil
            guard running else { return }
            running = false
            stopEngine()
        }
        pipeline.cancel()
    }

    /// Runs on `control`. An engine that will not start with voice processing (the VPIO unit can fail to
    /// initialise on some devices or while another app holds it) is rebuilt once without it: a recording
    /// without echo cancellation beats one without a microphone.
    private func startEngine() throws {
        guard echoCancellation else { return try startEngine(echoCancellation: false) }
        do {
            try startEngine(echoCancellation: true)
        } catch let error as CodedError where error.code == "mic_start_failed" {
            delegate?.source(id, didFailWithCode: "aec_unavailable",
                             message: "engine did not start with voice processing, capturing without echo cancellation: \(error)",
                             fatal: false)
            try startEngine(echoCancellation: false)
        }
    }

    /// Runs on `control`.
    private func startEngine(echoCancellation: Bool) throws {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        var voiceProcessing = false
        if echoCancellation {
            do {
                // Must happen while the engine is stopped; it switches both IO nodes to the VPIO unit.
                try input.setVoiceProcessingEnabled(true)
                input.voiceProcessingOtherAudioDuckingConfiguration =
                    AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
                input.isVoiceProcessingBypassed = false
                // VPIO needs the output side of the graph configured; we never play anything (volume 0).
                engine.mainMixerNode.outputVolume = 0
                voiceProcessing = true
            } catch {
                delegate?.source(id, didFailWithCode: "aec_unavailable",
                                 message: "voice processing could not be enabled, capturing without echo cancellation: \(error.localizedDescription)",
                                 fatal: false)
            }
        }
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw CoreAudioError("no_device", 0, "microphone input has no channels (no input device?)")
        }
        // ~100 ms of input per callback; AVAudioEngine may deliver a different size.
        let bufferSize = AVAudioFrameCount(max(256, format.sampleRate / 10))
        let pipeline = self.pipeline
        // Captured by value: the tap never reads mutable source state.
        let firstChannelOnly = voiceProcessing
        input.installTap(onBus: 0, bufferSize: bufferSize, format: format) { buffer, when in
            MicSource.tapBlock(pipeline, buffer, when, firstChannelOnly: firstChannelOnly)
        }
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { [weak self] _ in
            self?.scheduleRestart(reason: "engine configuration changed")
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            if let o = configObserver { NotificationCenter.default.removeObserver(o) }
            configObserver = nil
            throw CoreAudioError("mic_start_failed", OSStatus((error as NSError).code),
                                 "AVAudioEngine.start: \(error.localizedDescription)")
        }
        self.engine = engine
        currentDevice = (try? CA.defaultDevice(input: true)) ?? AudioObjectID(kAudioObjectUnknown)
        currentLayout = StreamLayout(sampleRate: format.sampleRate, channels: format.channelCount)
        Log.info("mic capture started (\(format.sampleRate) Hz, \(format.channelCount) ch, aec=\(voiceProcessing))")
    }

    /// AVAudioEngine tap thread: copy (down-mix) only.
    private static func tapBlock(_ pipeline: SourcePipeline, _ buffer: AVAudioPCMBuffer, _ when: AVAudioTime,
                                 firstChannelOnly: Bool)
    {
        guard let channelData = buffer.floatChannelData else {
            pipeline.markInvalidBuffer()
            return
        }
        let channels = Int(buffer.format.channelCount)
        let host = when.isHostTimeValid ? when.hostTime : mach_absolute_time()
        pipeline.push(frames: Int(buffer.frameLength), sampleRate: buffer.format.sampleRate, hostTime: host) {
            dst, offset, count in
            MonoMix.planar(channelData, channels: channels, firstChannelOnly: firstChannelOnly,
                           frameOffset: offset, frames: count, into: dst)
        }
    }

    /// Runs on `control`.
    private func stopEngine() {
        if let o = configObserver { NotificationCenter.default.removeObserver(o) }
        configObserver = nil
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        engine = nil
        // Tap stopped: process what is queued and drain converter latency (tail stamped as continuation).
        pipeline.flush()
    }

    /// Debounced and rate-limited: device switches fire several notifications, and VPIO reconfiguring itself
    /// must not turn into a restart loop.
    private func scheduleRestart(reason: String) {
        control.async { [weak self] in
            guard let self, self.running, !self.restartPending else { return }
            self.restartPending = true
            let sinceLast = Double(DispatchTime.now().uptimeNanoseconds &- self.lastRestart.uptimeNanoseconds) / 1e9
            let delay = max(0.25, MicSource.minRestartInterval - sinceLast)
            self.control.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.restart(reason: reason)
            }
        }
    }

    /// Runs on `control`.
    private func restart(reason: String) {
        restartPending = false
        guard running else { return }
        lastRestart = .now()
        let previous = currentDevice
        let previousLayout = currentLayout
        Log.info("mic restarting: \(reason)")
        stopEngine()
        do {
            try startEngine()
            if currentDevice != previous {
                delegate?.source(id, deviceChanged: CA.deviceName(currentDevice))
            } else if case let .changed(from, to) = FormatChange.evaluate(current: previousLayout, observed: currentLayout) {
                // Same device, new rate (e.g. Bluetooth headset switching to its call profile).
                delegate?.source(id, formatChangedFrom: from.sampleRate, to: to.sampleRate, channels: to.channels)
            }
        } catch {
            running = false
            let code = (error as? CodedError)?.code ?? "device_lost"
            delegate?.source(id, didFailWithCode: code, message: "\(error)", fatal: true)
        }
    }
}
