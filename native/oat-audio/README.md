# oat-audio

Swift sidecar that captures **mic** ("me", AVAudioEngine) and **system audio** ("them", Core Audio process
tap) as two separate streams and writes framed 16 kHz mono s16le PCM to stdout. The Electron main process
spawns it (SPEC §5, D-8); the wire format is in [`PROTOCOL.md`](PROTOCOL.md) (D-16).

Requires macOS 14.4+ (process taps), Xcode / Swift 6.2. No third-party dependencies.

## Build & test

```sh
cd native/oat-audio
swift build -c release          # → .build/release/oat-audio
swift test                      # Swift Testing suite, no permissions needed
```

## Run

```sh
oat-audio version                # {"version":"0.1.0","protocol":1}
oat-audio permissions            # mic / system-audio status as JSON — never prompts
oat-audio capture --synthetic --duration 2 | node scripts/check-frames.mjs --expect-seconds 2
( sleep 1; echo '{"cmd":"stop"}' ) | oat-audio capture --synthetic --duration 10 | node scripts/check-frames.mjs --max-seconds 2
```

`capture` options: `--mic` / `--system` (default both), `--sample-rate <hz>` (16000), `--frame-ms <ms>` (50),
`--duration <s>`, `--synthetic`, `--exclude-pid <pid>` (repeatable; keep e.g. the app's own playback out of
the system stream), `--no-aec`.

- **`--synthetic`** generates deterministic tones (mic 220 Hz bursts, system 330+495 Hz bursts) through the same
  session / framing / stdout path as real capture. Use it in every automated test — it touches no audio
  hardware and triggers no permission prompt.
- **Real capture** (no `--synthetic`) triggers macOS permission prompts on first use. It is a **human
  checkpoint**: agents never run it.
  `oat-audio capture --duration 10 | node scripts/check-frames.mjs` with a call playing, after granting access.

A slow reader never stalls capture: old queued audio is dropped and reported with `overrun` events
(PROTOCOL.md → _Backpressure_). `scripts/check-frames.mjs` (Node, no deps) is the protocol contract test; it also exports `FrameParser` and
`validateFrames` for the TypeScript `SidecarSource` (task 2.4).

## Echo cancellation

On speakers the mic hears the far side, which would put "them" into the "me" transcript. The mic path
therefore enables **Apple voice processing** (VPIO, `AVAudioInputNode.setVoiceProcessingEnabled(true)`) by
default; on macOS it uses the output device's playback as the echo reference. Voice processing normally ducks
other audio, so we set `voiceProcessingOtherAudioDuckingConfiguration` to advanced ducking **off** and level
**min** (the API cannot turn ducking off completely). If VPIO cannot be enabled, capture continues without it
and an `aec_unavailable` error event (non-fatal) is emitted. Use **`--no-aec` on headphones** — there is no echo
and VPIO only costs fidelity. The `started` event reports `"aec": true|false`.

Things the human checkpoint should confirm: echo of a call on speakers is removed from the mic stream;
call volume (heard and in the system stream) is not noticeably reduced while capturing; no repeated "mic
restarting" lines on stderr with AEC on (VPIO restart loop).

**Bluetooth headset (AirPods) checkpoint:** start capture with AirPods as output, play a call, then let the
mic open (or start capture with AirPods as input too). The headset drops from 48 kHz to its call profile
(16/24 kHz) on the _same_ device: expect one `format_changed` event per affected source, no `error`, and
"them" keeping correct pitch and duration (compare `samples` in `stopped` with wall-clock duration) and staying
in sync with "me". Also switch outputs at different rates (speakers ↔ AirPods) mid-capture: `device_changed`,
same checks.

## Permissions & bundling (note for task 9.1)

- `oat-audio permissions` reads the mic status via `AVCaptureDevice.authorizationStatus` and the system-audio
  status via TCC preflight (`kTCCServiceAudioCapture`, looked up with `dlsym`; reports `unknown` if missing).
  Neither prompts. For an unbundled binary TCC attributes access to the _responsible_ process (Terminal while
  developing, the Oat app once spawned by Electron).
- When bundled inside the Electron app, the **app's** `Info.plist` needs:
  - `NSMicrophoneUsageDescription` — mic capture.
  - `NSAudioCaptureUsageDescription` — system audio via process taps ("System Audio Recording Only").
  - Hardened runtime entitlement `com.apple.security.device.audio-input` for the mic.
    Sign the sidecar with the app's team ID so it inherits the app's TCC grants.
- A denied system-audio permission does not fail tap creation — the tap delivers silence. The app should
  check `permissions` before starting and treat a silent "them" stream as a probable permission issue.

## Layout

```
Sources/OatAudioCore/          testable logic
  Protocol.swift               frame encode/decode (FrameDecoder)
  Events.swift                 event JSON
  CaptureClock.swift           shared monotonic clock (host time)
  FrameAssembler.swift         samples → fixed frames + timestamps, level meter
  PCMConverter.swift           AVAudioConverter → target-rate mono s16
  SyntheticGenerator.swift     deterministic test audio
  ControlCommand.swift         stdin JSON commands, line splitting
  CaptureSession.swift         sources → frames → sink; pause/resume/stop; errors
  Backpressure.swift           bounded output queue + writer thread (drop-oldest, overrun events)
  StdinControl.swift, FrameWriter.swift, Permissions.swift, CLI.swift
  Capture/                     SampleHandoff (audio-thread ring, mono mix, tap buffer selection),
                               SourcePipeline (convert off the audio thread), SyntheticSource,
                               MicSource (AVAudioEngine + VPIO), SystemAudioSource (process tap)
Sources/oat-audio/main.swift   CLI entry point
Tests/OatAudioCoreTests/       Swift Testing
scripts/check-frames.mjs       protocol contract test
```
