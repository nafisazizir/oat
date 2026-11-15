# oat-audio wire protocol — `protocol: 1`

`oat-audio capture` writes a stream of binary frames to **stdout** and reads control commands from **stdin**.
Logs go to **stderr** only (free-form text, not part of the protocol). `oat-audio version` reports the protocol
number; any incompatible change to anything below bumps it (D-16).

## Frames (stdout)

Every frame is a 14-byte header followed by the payload. All integers are little-endian.

| offset | size          | field         | meaning                                                                     |
| ------ | ------------- | ------------- | --------------------------------------------------------------------------- |
| 0      | 1             | `kind`        | `1` = audio, `2` = event                                                    |
| 1      | 1             | `source`      | `0` = mic ("me"), `1` = system ("them"), `255` = none (session-level event) |
| 2      | 8             | `t_us`        | u64 microseconds since capture start (see _Clock_)                          |
| 10     | 4             | `payload_len` | u32 byte length of the payload                                              |
| 14     | `payload_len` | payload       | see below                                                                   |

Readers must handle frames split across arbitrary read boundaries. Unknown `kind`/`source` values are a
protocol error. Payloads are never larger than 16 MiB (real frames are a few KiB).

### Audio frames (`kind = 1`)

- Payload: PCM **signed 16-bit little-endian, mono**, at the `sample_rate` announced in `started`
  (default 16000 Hz, `--sample-rate`). Length is always even.
- `source` is `0` or `1`, never `255`.
- Frame size is `frame_ms` (default 50 ms → 800 samples / 1600 bytes at 16 kHz; `--frame-ms` 20–100).
  The last frame of a source before `paused`/`stopped` or before a timeline gap may be **shorter**; never longer.
- `t_us` is the capture-clock time of the frame's **first sample**. Per source it is **strictly increasing**.
  Within a continuous segment consecutive frames are exactly `frame duration` apart (sample-count based, no
  jitter). It jumps forward after pause/resume, a device switch or dropped buffers.

### Event frames (`kind = 2`)

Payload is one UTF-8 JSON object with a string `type`. Consumers must ignore unknown fields and unknown types.
`source` is `255` for session-level events and `0`/`1` for per-source events (also repeated as a `"source"`
string field).

| type                 | source              | fields                                                                                                                           | when                                                                                                                                                                                                                                                                      |
| -------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `started`            | none                | `protocol`, `version`, `sample_rate`, `frame_ms`, `sources` (`["mic","system"]`), `synthetic`, `aec`                             | always the **first** frame                                                                                                                                                                                                                                                |
| `stopped`            | none                | `reason` (`duration`·`command`·`stdin_eof`·`signal`·`error`·`output_closed`), `samples` (`{"mic":n,"system":n}` samples emitted) | always the **last** frame; nothing follows                                                                                                                                                                                                                                |
| `paused` / `resumed` | none                | —                                                                                                                                | after a `pause` / `resume` command; no audio is emitted while paused                                                                                                                                                                                                      |
| `error`              | none / mic / system | `code`, `message`, `fatal`                                                                                                       | `fatal: true` = that source has stopped; other sources keep running. If no source is left, `stopped` (`reason: "error"`) follows                                                                                                                                          |
| `device_changed`     | mic / system        | `device` (name)                                                                                                                  | default input/output device switched; capture continued on the new device                                                                                                                                                                                                 |
| `format_changed`     | mic / system        | `device_sample_rate`, `previous_device_sample_rate`, `channels`                                                                  | the _same_ device changed its own format (e.g. a Bluetooth headset dropping 48 → 16 kHz when its mic opens); capture was reconfigured and continues. Informational — audio frames stay at `sample_rate`                                                                   |
| `level`              | mic / system        | `rms_db`, `peak_db` (dBFS, −100 = silence)                                                                                       | every 250 ms of audio per source, for meters                                                                                                                                                                                                                              |
| `overrun`            | mic / system        | `stage` (`capture`·`output`), `dropped_samples` (at `sample_rate`), `dropped_ms`                                                 | audio was dropped because a consumer fell behind — see _Backpressure_. `dropped_samples` is exact. `t_us` = time of the first dropped audio (`output`) or emission time (`capture`; it sits in stream order between the last audio before the gap and the first after it) |

Error codes currently emitted (start failures carry the specific code; `start_failed` is only the fallback):
`tap_create_failed`, `tap_format`, `aggregate_failed`, `ioproc_failed`, `device_start_failed`, `no_device`,
`mic_start_failed`, `device_lost`, `start_failed`, `convert_failed` (non-fatal), `tap_buffer_invalid` (non-fatal,
reported once: system IO buffers without exactly one usable tap stream were skipped), `mic_buffer_invalid`
(non-fatal, reported once: mic buffers in an unusable format were skipped), `aec_unavailable` (non-fatal: mic continues
without echo cancellation), `invalid_command` (source none, bad stdin line). Treat unknown codes as generic errors.

### Clock

One monotonic clock (`mach_absolute_time`, the Core Audio host-time base) shared by both sources, origin =
capture start. Mic and system buffers are stamped from their own host timestamps (`AVAudioTime.hostTime`,
`AudioTimeStamp.mHostTime`), so `t_us` values of the two sources are directly comparable — the audio archive
(SPEC §6) and transcript segments use this timeline. Event `t_us` is the clock time when the event was
emitted. Frames of different sources are interleaved in arrival order, so `t_us` is **not** globally sorted
across sources.

## Backpressure

Capture never waits for the reader. Three stages, each bounded:

1. **Audio callback** (HAL IO block / AVAudioEngine tap) only down-mixes into a preallocated per-source ring
   (64 slots); no allocation, conversion or I/O. If processing is behind and the ring is full, the new audio is
   dropped → `overrun` with `stage: "capture"`, emitted in stream order (after the audio before the gap). The
   source's current frame is closed at the gap, so the next audio frame's `t_us` is its real capture time.
2. **Processing queue** (per source) converts to the target format, assembles frames and enqueues them.
3. **Writer thread** writes frames to stdout from a bounded queue (≈ 5 s of audio for all sources, min 64 KiB).
   When a slow reader lets it fill, the **oldest queued audio frames are dropped** (events never are) and an
   `overrun` event with `stage: "output"` is inserted where they were (adjacent drops per source are merged).

So a stalled reader loses old audio rather than freezing capture, and every missing sample is reported:
for each source, delivered samples + `dropped_samples` of its `overrun` events = samples captured. The `t_us` of
the next audio frame shows the gap. On stop, the writer gets `stopped` out before exit (waits ≤ 3 s for a stalled
reader, then exits anyway). Readers should consume stdout continuously and treat `overrun` as a visible gap.

## Control (stdin)

Newline-delimited JSON, one command per line: `{"cmd":"pause"}`, `{"cmd":"resume"}`, `{"cmd":"stop"}`.
Extra fields are ignored; blank lines are ignored; an unparseable line produces an `error` event
(`invalid_command`) and capture continues.

- `stop` → graceful stop: sources flush, partial frames are written, `stopped` is written, exit.
- **EOF on stdin = stop** when stdin is a pipe/socket (how Electron spawns us) or a TTY. If stdin is
  `/dev/null` (or another non-TTY character device) it is ignored, and a regular-file stdin is read for
  commands but its EOF does not stop capture — so `oat-audio capture --duration 2 < /dev/null` runs 2 s.
- SIGINT / SIGTERM → graceful stop with `reason: "signal"`.

## Exit codes

`0` normal stop (duration, command, EOF, signal, output closed) · `1` stopped because every source failed
· `64` usage error (bad arguments; message on stderr).

## Example (hex, illustrative lengths)

```
02 ff 00 00 00 00 00 00 00 00  5a 00 00 00  {"type":"started",...}     event, source none, t=0
01 00 b0 03 00 00 00 00 00 00  40 06 00 00  <1600 bytes s16le>          audio, mic, t=944 µs
```

The contract test `scripts/check-frames.mjs` implements a reference parser (`FrameParser`) and validator
(`validateFrames`) for this document.
