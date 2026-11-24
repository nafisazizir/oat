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

When the first `started` frame includes `await_capture_ready: true`, it describes the requested streams
while device setup is still in progress. A session-level `capture_ready` event follows once at least one
source is open, before any audio frames. Errors may arrive before readiness. If every source fails to open,
the helper emits their errors followed by `stopped` with reason `error`, without announcing readiness.
Older helpers omit the field and clients treat their `started` frame as immediately ready.

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

## Calendar (`oat-audio calendar …`)

Separate subcommands of the same binary (task 7.1). They do **not** use the binary frames above: stdout is
**JSON lines** (one object per line, UTF-8), logs go to stderr. Adding them did not change `protocol`
(capture is untouched); consumers must ignore unknown fields and unknown `type`s. Parsed on the Node side by
`SidecarCalendarSource` (`@oat/calendar/node`) with `CalendarEventSchema` (`@oat/core`).

| command                                             | prompts? | stdout                                                                                              |
| --------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `calendar status [--fixture f]`                     | never    | `{"status","canRead","source":"eventkit"\|"fixture","prompted":false}`                              |
| `calendar request-access`                           | **yes**  | same shape as `status`, after the user answered. **Human use only** — agents and tests never run it |
| `calendar events [--from x] [--to y] [--fixture f]` | never    | one normalised event per line (below), sorted by start, end, id                                     |
| `calendar watch [--debounce-ms n] [--fixture f]`    | never    | `{"type":"ready","source":…}` once, then `{"type":"changed"}` per debounced burst of changes        |

- `status` values: `full_access` · `write_only` · `denied` · `restricted` · `not_determined` · `unknown`
  (`EKEventStore.authorizationStatus(for: .event)`, a read-only query). Only `full_access` can read.
- `events` / `watch` without full access exit **77** (message on stderr) instead of prompting.
- `--from` / `--to`: ISO 8601 with zone (`2026-11-16T09:00:00Z`, `…-08:00`) or a day `YYYY-MM-DD` in the
  store's zone (the Mac's; the fixture's `timeZone` in fixture mode). A day is that midnight for `--from` and
  **includes the whole day** for `--to`. Defaults: 24 h ago … 14 days after `--from`. Span ≤ 4 years. Events
  overlapping `[from, to)` are returned (`start < to && end > from`; a zero-length event at `from` counts).
- `watch` subscribes to `EKEventStoreChanged` (fixture mode: the fixture file, including atomic replaces) and
  coalesces bursts: a `changed` line comes `--debounce-ms` (default 500, 0…60000) after the last change, and
  at most 4× that after the first. The consumer then re-runs `events`. It stops on stdin EOF (pipe/TTY),
  `{"cmd":"stop"}`, SIGINT or SIGTERM, exit 0.
- Exit codes: `0` ok · `1` failure (unreadable/invalid fixture, EventKit error) · `64` usage · `77` no access.

### Event line

Pretty-printed here; on the wire each event is a single line.

```json
{
  "id": "eventkit:standup/2026-11-16T17:30:00.000Z",
  "source": "eventkit",
  "calendar": { "id": "cal-work", "title": "Work", "color": "#3B82F6" },
  "title": "Daily standup",
  "start": "2026-11-16T17:30:00.000Z",
  "end": "2026-11-16T17:45:00.000Z",
  "allDay": false,
  "allDayStart": null,
  "allDayEnd": null,
  "timeZone": "America/Los_Angeles",
  "location": null,
  "url": "https://meet.google.com/abc-defg-hij",
  "conferenceUrl": "https://meet.google.com/abc-defg-hij",
  "conferenceProvider": "google_meet",
  "status": "confirmed",
  "attendees": [
    {
      "name": "Alex Rivera",
      "email": "alex@oat.test",
      "status": "accepted",
      "isSelf": true,
      "isOrganizer": false
    }
  ],
  "recurrenceId": "eventkit:standup",
  "icalUid": "standup-series@oat.test"
}
```

- `id`: `eventkit:<eventIdentifier>`. Occurrences of a recurring event share an `eventIdentifier`, so they get
  `/<original occurrence start>` appended (a moved occurrence keeps its original time in the id).
  `recurrenceId` = `eventkit:<eventIdentifier>` for recurring events, else null. `icalUid` =
  `calendarItemExternalIdentifier`.
- Times are UTC ISO strings with milliseconds (as `Date.prototype.toISOString`). `timeZone` is the event's
  IANA zone (null for floating/all-day).
- All-day: `start`/`end` are midnights in the store's zone, `allDayStart`/`allDayEnd` the days (end
  exclusive). EventKit's last-day-23:59:59 end becomes the next midnight.
- `title`, `location`, `url` are trimmed; blank → `""` (title) or null.
- `conferenceUrl` / `conferenceProvider` (`zoom` · `google_meet` · `teams`): first join link in url →
  location → notes (earliest in a field). Same rules as `detectConferenceLink` in `@oat/core`; both are tested
  against `fixtures/calendar/conference-links.json`. Notes themselves are not emitted.
- `status`: `confirmed` · `tentative` · `cancelled`.
- `attendees`: people only (rooms/resources dropped), email from the `mailto:` URL lower-cased, de-duplicated
  by email; `status` `accepted` · `declined` (incl. delegated) · `tentative` · `needs_action` · `unknown`;
  `isSelf` = EventKit's `isCurrentUser`; the organizer is flagged, or prepended (unknown response → accepted)
  if EventKit did not list them. Solo events have `[]`.

### Calendar fixtures (`--fixture <file.json>`)

EventKit-shaped input, normalised by the same code as real events, so fixture mode exercises the whole path
without EventKit or a permission prompt. Re-read on every `events`, watched by `watch`. Example:
`fixtures/calendar/week.json`.

```json
{
  "timeZone": "America/Los_Angeles",
  "authorization": "full_access",
  "calendars": [{ "id": "cal-work", "title": "Work", "color": "#3B82F6" }],
  "events": [
    {
      "id": "standup",
      "externalId": "standup@oat.test",
      "calendarId": "cal-work",
      "title": "Daily standup",
      "start": "2026-11-16T09:30:00-08:00",
      "end": "2026-11-16T09:45:00-08:00",
      "allDay": false,
      "timeZone": "America/Los_Angeles",
      "location": null,
      "url": null,
      "notes": null,
      "status": "confirmed",
      "recurring": true,
      "detached": false,
      "occurrenceDate": "2026-11-16T09:30:00-08:00",
      "organizer": { "name": "Jordan", "email": "jordan@oat.test", "status": "accepted" },
      "attendees": [
        { "name": "Alex", "email": "alex@oat.test", "status": "accepted", "self": true }
      ]
    }
  ]
}
```

All event fields but `calendarId`, `start` and `end` are optional. Dates: ISO with zone, or `YYYY-MM-DD`
(midnight in `timeZone`; default the Mac's). `authorization` (default `full_access`) is what `status`
reports. Participant `status` uses EKParticipantStatus names (`unknown` · `pending` · `accepted` · `declined`
· `tentative` · `delegated` · `completed` · `in_process`), `type` EKParticipantType names (`person` · `room` ·
`resource` · `group` · `unknown`); `url` (`mailto:…`) may replace `email`. Event `status`: `none` ·
`confirmed` · `tentative` · `cancelled`.

## Mic apps (`oat-audio mic-apps …`)

Task 7.2 (D-21). Which processes are **running audio input** right now, from Core Audio process objects
(`kAudioHardwarePropertyProcessObjectList` → per process `kAudioProcessPropertyIsRunningInput`,
`kAudioProcessPropertyPID`, `kAudioProcessPropertyBundleID`; macOS 14.2+). Metadata reads only: no capture,
no tap, no IO. Like `calendar`, stdout is **JSON lines**, logs go to stderr, `protocol` is unchanged and
consumers ignore unknown fields and `type`s. The sidecar reports processes **unfiltered**; the allowlist,
helper → app mapping and every prompt rule live in `@oat/detection` (`SidecarMicAppsSource` in
`@oat/detection/node`).

| command                                          | stdout                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `mic-apps list [--fixture f]`                    | one `{"type":"apps","apps":[…]}` line                                                |
| `mic-apps watch [--interval-ms n] [--fixture f]` | `{"type":"ready","source":"coreaudio"\|"fixture","intervalMs":n}`, then `apps` lines |

- `watch` polls every `--interval-ms` (default 1000, 10…60000) and prints an `apps` line on the first poll and
  whenever the list changes (full list each time, never a diff). A failing poll prints
  `{"type":"error","code":"poll_failed","message":…}` once (until a poll succeeds again) and keeps polling.
  It stops on stdin EOF (pipe/TTY), `{"cmd":"stop"}`, SIGINT or SIGTERM, exit 0.
- Exit codes: `0` ok · `1` failure (unreadable/invalid fixture, Core Audio error in `list`) · `64` usage.
- Process entries are sorted by `pid`, duplicates removed:

```json
{ "pid": 700, "bundleId": "com.google.Chrome.helper", "appBundleId": "com.google.Chrome" }
```

- `bundleId`: the process's own bundle id (Core Audio), null if unknown (e.g. a bare CLI).
- `appBundleId`: bundle id of the **outermost** `.app` around the executable (`proc_pidpath` → path → that
  bundle's Info.plist), so a helper `.app` nested inside `Google Chrome.app` names Chrome. Null when there is
  no enclosing `.app` (XPC services, daemons) or it equals `bundleId`.
- **Prompts:** Apple does not document whether these reads can trigger a TCC prompt (none is expected — no
  audio is read). Until the human checkpoint confirms it, agents and tests run `mic-apps` **only with
  `--fixture`**.

### Mic-apps fixtures (`--fixture <file.json>`)

A detection timeline (`fixtures/detection/*.json`, schema `DetectionTimelineSchema` in `@oat/detection`).
The sidecar reads only `steps[].at` (ms since the replay started, non-decreasing) and `steps[].micApps`; other
step keys (`events`, `recording`, `silenced`, `promptClosed`) and `expect` are for the Node reducer tests.
The replay clock starts when the command starts; each poll reports the `micApps` of the last step whose `at`
has passed (empty before the first one), so a step shorter than the poll interval can be missed — as with
real polling. Example: `fixtures/detection/sidecar-replay.json`.

```json
{
  "steps": [
    { "at": 0, "micApps": [] },
    { "at": 200, "micApps": [{ "pid": 501, "bundleId": "us.zoom.xos" }] },
    { "at": 3400, "micApps": [] }
  ]
}
```
