# Granola — audio capture, encoding and transcription path

Question (task 0.3): how does Granola capture, encode and transcribe audio? What do `screen_capture.node`,
`opusscript` and `granola-diarizer` do; how are mic and system audio kept apart; what is the frame format;
which STT providers/transport; what happens when the network drops; is audio stored locally?

Target: `/Applications/Granola.app` (package `@granola/desktop` 7.786.3), static analysis only, 2026-11-14.
Nothing was executed, no network calls, no user data read. All wording below is ours.

Confidence: **confirmed** = read directly in shipped code/binary metadata; **inferred** = strong reading of
code but not end-to-end proven (e.g. server-side flag overrides unknown); **unknown** = not determined.

## Evidence index

REA: `analyze_javascript_application` on `app.asar` (integrity_policy record-and-continue; 6 unpacked
native files differ from ASAR integrity metadata, normal for signed apps). Parent evidence
`ev_bc8f805b7b779ab969ca2008993bcbfcab7adcb678d8f067094a8763863ac03c`, summary view
`ev_27748151481c4b8f3a7d13074fd4d70fde3d356c3094fca16567422a5eb8f6ca`. REA's Hopper provider timed out on
the native addon (see "Limitations"), so native facts come from `otool -L`, `nm -gU`, `strings` (Xcode CLI,
read-only). Bundles were extracted from the ASAR into `research/granola/raw/asar/` (git-ignored); offsets
below are character offsets in those files.

| ID | Location | What it shows |
|---|---|---|
| E1 | `dist-electron/main/index.js` @~1299271 | capture-mode selector: non-Windows always uses the renderer ("browser") capture path; Windows uses a native utility process unless a flag forces browser |
| E2 | `dist-app/assets/primary-*.js` @~7592055 (`gqr`/`hqr`/`fqr`) | renderer capture: `getUserMedia` for mic, `getDisplayMedia` audio-only for system; one AudioContext at the requested rate; AudioWorklet per stream |
| E3 | `dist-app/assets/audioWorkletProcessor-CDVBpRB4.js` | worklet batches 100 ms of mono float32 and stamps wall-clock start time |
| E4 | `primary-*.js` @~7605729 (`yqr`, `uqr`) | float32 → clamped Int16 PCM; each batch sent to main tagged mic *or* system with its capture timestamp |
| E5 | `index.js` @~713388 | capture sample rate constant = 16 kHz |
| E6 | `index.js` @~2535021, @~2574174 | Chromium feature switches for macOS loopback (Core Audio tap on macOS ≥ 14, ScreenCaptureKit override below); display-media handler answers with loopback audio |
| E7 | `index.js` @~1516972 (`R1e`, `I1e`) | opusscript encoder: mono, "audio" application, 24 kbps, 20 ms frames, only at 8/12/16/24/48 kHz; a length-prefixed packet container |
| E8 | `index.js` @~1522170–1530000 (`xY`) | Deepgram live transcriber: WebSocket, nova-3, interim results, smart formatting, encoding linear16 or opus, keyterms, 3 s KeepAlive, liveness/stall check |
| E9 | `index.js` @~1570734 (`Q0e`) | AssemblyAI Universal-Streaming transcriber (v3-style turns, keyterms, optional speaker labels / language detection / opus) |
| E10 | `index.js` @~1592787 (`z2e`), `lX`, `B2e` | Granola's own relay ("cloudflare" provider): one WebSocket per source to a Granola-hosted endpoint that fronts Deepgram / AssemblyAI / ElevenLabs Scribe / Grok; session resume |
| E11 | `index.js` @~1508546–1516000 (`N1e`, `cY`, `fY`) | reconnecting WebSocket: unbounded send queue while disconnected, flush on reopen, exponential backoff, transport switch (Node `ws` ↔ Electron `net`) |
| E12 | `index.js` @~1655553 and preceding `X4e` | per-meeting session: opens mic and system connections in parallel; keeps a 120 s per-source PCM ring buffer, replays it on reconnect; provider failover with a budget |
| E13 | `index.js` @~1584466 (`o2e`,`u2e`,`f2e`) | "catch-up" batch path: backlog ≥10 s after a fresh reconnect is gap-filled, optionally Opus-packed, base64-uploaded to a Granola batch endpoint |
| E14 | `index.js` @~1643537 (`Y4e`), `dist-electron/local_asr_process/index.js` | on-device ASR provider ("local bridge"): Parakeet (sherpa-onnx transducer) or whisper.cpp server, VAD-segmented |
| E15 | `index.js` flag table @~573000–578000 | bundle defaults of transcription feature flags (see table below) |
| E16 | `index.js` @~1193441 (`NHe`/`FHe`/`IHe`) | optional debug recording of raw mic/system WAV, flag off by default, 7-day cleanup |
| E17 | `index.js` @~2481321, @~2494132, @~2508269; `dist-electron/speaker_embedding_process/index.js` | voice-fingerprint proof-of-concept: temporary 16 kHz mic WAV → `granola-diarizer` + ONNX speaker embedding → match against the user's voice profile; WAV deleted |
| E18 | `Resources/native/screen_capture.node` (`nm`, `otool -L`, `strings`); `dist-electron/screen_capture_process/index.js` | single exported function that takes a per-window PNG screenshot via ScreenCaptureKit |
| E19 | `Resources/granola-diarizer` (`otool -L`, `strings`) | arm64 Swift CLI built on the open-source FluidAudio library (CoreML); subcommands diarize / embed; JSON output |
| E20 | `dist-electron/audio_process/index.js` | Windows native capture utility process: native module callback delivers paired mic/system Int16 buffers + timestamps |
| E21 | `index.js` @~1590000 | outbound network allowlist includes Deepgram and AssemblyAI hosts plus Granola's own domains |

## 1. Capture

### macOS uses Chromium, not a native addon (confirmed: E1, E2, E6)
On macOS the main process does **not** load any audio addon. A "capture manager" in main posts
start/stop commands to the **primary renderer window**, which captures with web APIs:

- **Mic**: `getUserMedia` with the selected device, the target sample rate, and voice processing that is
  configurable (default: Chromium echo cancellation in the mode that uses *all system output* as the echo
  reference; flags/settings can turn off AEC, noise suppression and/or AGC, e.g. on headphones).
- **System audio**: audio-only `getDisplayMedia`. Main's display-media handler answers with loopback audio,
  and at startup main enables Chromium features so that loopback on macOS 14+ uses a **Core Audio process
  tap**, falling back to **ScreenCaptureKit** loopback on older macOS (E6). So the app inherits whatever
  Chromium's loopback implementation does (whole-system output, no per-app filtering seen).
- Both streams feed **one AudioContext created at 16 kHz** (E5), so Chromium does the resampling. Each
  stream goes through its own AudioWorklet that accumulates **100 ms** of mono float32 and stamps the
  wall-clock time of the first sample (E3).
- The renderer converts each 100 ms block to **signed 16-bit little-endian PCM** and sends it to main over
  IPC as a message that carries *either* a mic buffer *or* a system buffer plus its capture timestamp (E4).
- Track loss / device changes are handled in the renderer: up to 3 acquisition attempts, then background
  re-acquire with doubling backoff (cap 30 s); devicechange events re-pick the mic (inferred detail of the
  retry constants; mechanism confirmed, E2).
- The renderer also computes RMS levels for the meter UI.

### Windows uses a native utility process (confirmed: E1, E20)
On Windows an Electron `utilityProcess` loads a Windows-only native module that delivers paired mic +
system Int16 buffers (with optional per-source timestamps) through a callback; same downstream format.
Options passed include Core Audio vs alternatives, echo cancellation on headphones, AGC, sample rate.

### Mic vs system separation (confirmed)
Mic and system are **never mixed**. They are separate streams from capture onwards, carried as separate
buffers tagged by source, buffered per source, and transcribed over **two independent STT connections**
(one per source, each mono 16 kHz) (E4, E12). The transcript chunks carry the source, which is how the UI
knows "me" (mic) vs "them" (system). Echo of remote speakers in the mic is suppressed by Chromium AEC
using system output as reference (E2).

### What the native pieces are
- **`screen_capture.node` is not audio** (confirmed, E18). It exports one N-API function that takes a PNG
  screenshot of a given window via ScreenCaptureKit's screenshot API; it runs in its own utility process
  and serves the "screen-share context" feature. Our recon's guess that it captured system audio was wrong.
- **`opusscript`** (confirmed, E7, E13) is the WASM/JS Opus encoder used in the main process for two
  optional, flag-gated things: (a) Opus-encoding the live stream before sending to Deepgram/AssemblyAI
  (`transcription_opus_streaming`, default off → live audio is raw linear16 by default), and (b) compressing
  catch-up batch uploads (`transcription_catchup_batch_opus`, default off). Settings: mono, 24 kbps, 20 ms
  frames (320 samples at 16 kHz), "audio" application mode. Live packets are sent one per WebSocket
  message (no Ogg container). For batch uploads the packets are packed into a simple custom container:
  a little-endian uint32 sample count followed by uint16-length-prefixed Opus packets.
- **`granola-diarizer`** (confirmed shape, E17, E19) is an arm64-only Swift command-line tool built on the
  open-source FluidAudio SDK (CoreML; contains pyannote-style, Sortformer and LS-EEND diarizer backends,
  models fetched from Hugging Face on first use). Main runs it with `execFile` with two subcommands:
  *diarize* (WAV in → JSON with speaker segments and per-speaker embeddings, optional max-speaker count)
  and *embed* (WAV in → a single voice embedding with speech duration / speaker count / dominant share).
  It is used **only** by the `voice_fingerprint_poc` experiment (default off), post-meeting, on the mic
  recording — not in the live path. Which FluidAudio backend it actually invokes is **unknown**.
- A separate **speaker-embedding utility process** (E17) runs an ONNX speaker-embedding model
  (ReDimNet, 192-dim, downloaded with SHA-256 pinning) over diarized clusters of the same temporary WAV,
  with VAD gating and a slow AGC, to decide which cluster is the user (cosine match to a stored profile).
  Inference: this is aimed at **in-person meetings** where everybody is on the mic channel.

## 2. Transcription providers and transport

### Providers (confirmed: E8–E10, E14, E15)
| Provider id | What | Transport |
|---|---|---|
| `deepgram` (**default**) | Deepgram live, model nova-3 (nova-3 multilingual variant for "multi") | direct WSS to Deepgram `/v1/listen` |
| `assembly-universal` | AssemblyAI Universal-Streaming | direct WSS to AssemblyAI (edge endpoint by default) |
| `cloudflare` (relay) | Granola-hosted relay that itself talks to Deepgram, AssemblyAI, ElevenLabs Scribe or Grok | WSS to a Granola transcription domain |
| `local` | on-device Parakeet (sherpa-onnx, NeMo transducer, beam search, hotwords) or whisper.cpp server | utility process, no network |
| `assembly-batch` | backlog transcription after outages | HTTPS via Granola backend |

**Auth model** (architecture only; no tokens inspected): the desktop never holds a long-lived provider key.
It asks the Granola backend for a **short-lived provider token** using the user's session token, caches it
until shortly before expiry, and supplies it as a header when (re)dialling the provider socket (E8, E9).
App version / connection id / source are sent as custom headers.

### Deepgram stream parameters (confirmed, E8)
One socket per source; query parameters: mono, sample rate = capture rate (16 kHz), encoding linear16
(opus if the flag is on), interim results on, smart formatting on, profanity filter off, model nova-3,
the Deepgram model-improvement opt-out set (flag default on), and up to N **keyterms** (meeting-derived
vocabulary; can be updated mid-session for Assembly, deferred for Deepgram). Multilingual mode sets
language "multi", optional language hints and a short endpointing value. Client sends a JSON KeepAlive
every 3 s; a stall check (default 30 s without any message while audio is flowing) triggers a redial /
transport switch or failover. Results messages are mapped to a common chunk shape: id, source, text,
start/end in **wall-clock ms** (anchored on the capture timestamp of the first buffer sent on that socket +
provider offsets), is-final, word list (word, start, end, confidence, optional speaker/lang).

### Relay (confirmed, E10)
When `cloudflare_transcription_relay_enabled` is on (default off in the bundle), each source connects to
Granola's relay instead. URL query carries document id, connection id, a relay-object id (for sticky
routing / resume), source, sample rate, language, provider choice and keyword list. Each binary audio
frame is prefixed with an **8-byte little-endian float64 capture timestamp** followed by raw PCM. The relay
replies with JSON messages (ready / transcription / language-detection / heartbeat / stopped / error); a
"ready" can say the session was **resumed** and up to which capture time the relay already received, so
the client only replays newer audio. App-level ping every 10 s.

## 3. Network drops, buffering and reconnect (confirmed: E11–E14)

Three layers:

1. **Socket layer** (reconnecting WebSocket): while not open, outgoing audio messages are queued in memory
   (no size cap by default) and flushed in order on reopen, with flush statistics logged. Backoff starts
   1–5 s (randomised), grows ×1.3 per attempt, caps at 10 s; a connection must stay up 5 s to count as
   stable; 4 s connect timeout. It can alternate between two WebSocket implementations (Node `ws` and
   Chromium's `net` stack) when one stalls.
2. **Session layer**: every PCM buffer is also appended to a **per-source in-memory ring buffer holding the
   last 120 s** (older entries are dropped and counted). When a provider connection is replaced (failover
   or reconnect), the buffer is replayed into the new connection; with the commit-eviction flag, entries are
   evicted only once the provider confirms finals through that audio time. Provider failover order is
   language-aware (e.g. Deepgram ↔ AssemblyAI; relay falls back to the configured direct provider), limited
   by a fallback budget (default 4). Both sources start in parallel; the session survives if only one
   source connects.
3. **Catch-up batch** (`transcription_catchup_batch`, default off): if a fresh connection finds ≥10 s of
   backlog, that backlog is instead sent as a single batch request (gaps > 1 s padded with silence, trimmed
   to the most recent 120 s, optionally Opus-packed), and the batch results are merged as final chunks.
4. **Local bridge** (`transcription_local_bridge`, default off; English, Apple Silicon only): when the
   cloud connection fails and the local model is already on disk, the source is temporarily transcribed
   by the on-device provider, then retried against the cloud after a jittered back-off (default ~60 s).
   The local worker uses a VAD with 512-sample hops at 16 kHz, closes segments after ~0.8 s silence or
   25 s length, and emits partials roughly every second (inferred from constants, E14).

Net effect: with defaults, an outage up to ~2 minutes loses no audio for transcription (ring buffer +
unbounded socket queue); longer outages lose the oldest audio unless batch catch-up is enabled.

## 4. Is audio stored locally? (confirmed: E12, E16, E17)

**Not by default.** Audio lives only in memory (the 120 s ring buffer and socket queues) and is discarded.
Exceptions, all flag-gated and off in the bundle:
- `save_audio`: writes raw 16 kHz mono 16-bit WAV for mic and system separately under the app's user-data
  folder (`audio_files/`), deleted after 7 days. Looks like a debugging/support aid.
- `voice_fingerprint_poc`: writes a temporary 16 kHz mic WAV per meeting (`voice_fingerprint/`), with
  periodic (10 s) wall-clock anchors, processed after stop, then deleted.
- `persist_transcription_details` exists (transcript metadata, not audio — inferred).

There is no user-facing playback of meeting audio in this build (inferred: no code path found that keeps
audio for playback).

## 5. Bundle defaults of relevant flags (E15; server can override — remote values **unknown**)

provider deepgram · relay off · opus streaming off · catch-up batch off (+opus off) · local ASR off · local
bridge off (backoff 60 s, jitter 60 s) · provider fallback budget 4 · liveness timeout 30 s (Deepgram) ·
browser audio capture on Windows off · save_audio off · voice fingerprint off · model-improvement opt-out on ·
mic processing "default".

## Diagram

```
 renderer (primary window, macOS)                     main process                         network
 ┌──────────────────────────────┐   IPC: 100 ms   ┌──────────────────────────────┐
 │ getUserMedia (mic, AEC=all)  │── Int16 + ts ──▶│ TranscriptionSession          │
 │   └ AudioWorklet 100 ms      │   tag=mic       │  ├ ring buffer mic (120 s)    │── WSS (mic) ──▶ Deepgram / Assembly / relay
 │ getDisplayMedia loopback     │── Int16 + ts ──▶│  ├ ring buffer system (120 s) │── WSS (sys) ──▶ "
 │   (Core Audio tap / SCK)     │   tag=system    │  ├ opusscript (optional)      │
 │ AudioContext @16 kHz         │                 │  ├ catch-up batch (optional)  │── HTTPS ──▶ Granola batch
 └──────────────────────────────┘                 │  └ local ASR bridge (opt.)    │
                                                  │ voice-fingerprint PoC (opt.)  │── after stop: granola-diarizer + ONNX embedder
                                                  └──────────────────────────────┘
```

## Limitations / unknowns

- REA Hopper provider timed out opening `screen_capture.node` (Hopper appears to be blocked on a dialog;
  REA reports cleanup incomplete). Native facts are from Xcode CLI tools instead; no disassembly was done.
- Remote feature-flag values are unknown; production behaviour may differ from bundle defaults
  (e.g. relay or Opus streaming may be on for some users).
- Which FluidAudio diarizer backend `granola-diarizer` uses: unknown.
- Relay server behaviour (provider selection, resume window) is only visible from the client side.

## Implications for Oat

Compared against SPEC §5–6 (Swift sidecar, Deepgram streaming, local Ogg Opus archive):

**Do the same**
- Keep **mic and system as two separate mono streams end-to-end**, each with its own STT socket, and label
  transcript segments by source. Granola does exactly this; our `source: mic|system` segment field and
  tagged sidecar frames match.
- **16 kHz mono Int16 PCM in ~100 ms frames, each carrying a capture timestamp** is a good internal frame
  format. Anchor transcript times to capture wall-clock (or our recording clock) rather than to socket time,
  so reconnects and replays don't shift timestamps.
- **Deepgram live with linear16 at 16 kHz, interim results, smart formatting, keyterms, KeepAlive and a
  liveness/stall timer** — a sane baseline for `packages/stt`. Raw PCM by default is fine (~256 kbps per
  source); make Opus-over-WebSocket an option later, not a v1 requirement.
- **Short-lived STT tokens minted by our backend** (`apps/web`) rather than shipping a Deepgram key in the
  desktop app. Deepgram supports temporary keys; add an API route for it.
- **Reconnect design**: in-memory per-source buffer of recent audio (≥2 min) replayed into a new socket,
  plus a send queue while disconnected; exponential backoff with jitter. Build this into `SttProvider`
  consumers and test it with `FileSource` + a fake socket that drops.
- Ask for the provider's **model-improvement opt-out** by default.

**Do differently**
- **Capture in a Swift sidecar** (our plan) rather than Chromium web APIs. Granola leans on Chromium's
  loopback (Core Audio tap on macOS 14+) and AEC. Our sidecar must therefore handle **echo** ourselves:
  either use the Voice Processing I/O unit (Apple AEC) on the mic, or rely on headphones + source labels and
  accept some bleed. Decide this explicitly in the 0.x audio-spike task. Core Audio process taps for system
  audio match what Granola gets via Chromium, so our SPEC choice is validated.
- **Keep a local audio archive** (Ogg Opus, mono, ~24 kbps per source — the same bitrate Granola picked for
  its encoder). Granola keeps no audio by default; our archive is a differentiator *and* our outage
  answer: because the sidecar writes Opus to disk continuously, a long network outage can be recovered by
  re-transcribing the gap from the file (batch Deepgram request) instead of being capped by a RAM buffer.
  Make "gap backfill from archive" a planned task rather than Granola-style 120 s RAM-only catch-up.
- Encoding Opus once in the sidecar for the archive means we could also stream Opus to Deepgram without a
  second encoder; keep PCM streaming for v1 for simplicity and switch only if bandwidth matters.
- Skip the relay, multi-provider failover and local-ASR bridge for v1; the `SttProvider` interface leaves
  room for a local Whisper/Parakeet provider later (Granola's choice of Parakeet via sherpa-onnx and
  whisper.cpp is a useful pointer). Diarization within "them" (and in-person meetings via a mic-only
  diarizer + voice profile) is a later feature; FluidAudio is an open-source Swift option worth evaluating
  for our sidecar (check licence first).
- `screen_capture.node` is a screenshot tool, not audio — nothing to replicate for M1.
