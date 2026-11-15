# Granola: meeting detection and calendar use

Question (task 0.4): how does Granola detect meetings and use the calendar? What do `ax_meeting_detector.node`,
`macos_mic_apps_with_devices.node`, `eventkit.node` and `meet-consent-host` do? Which signals does it use, does it
poll or listen for events, what thresholds and debounces apply, and how do the signals become a "start notes?"
prompt and an auto-stop?

Target: `/Applications/Granola.app` (`@granola/desktop` 7.786.3). Static analysis only, 2026-11-14. Nothing was
executed, nothing went over the network, no user data was read. The wording below is ours. Identifiers (Apple API
names, bundle IDs, feature-flag IDs, minified symbols) are given only as references.

Confidence: **confirmed** = read directly in shipped code or binary metadata. **inferred** = a strong reading of the
structure, not proven end to end (server-side flag overrides are unknown). **unknown** = not determined.

## Evidence index

REA evidence (exported bundle: `raw/rea-evidence-0.4-detection.json`, git-ignored). REA's Hopper provider got stuck
on its first open (see Limitations), so the native facts come from REA's objdump provider plus `nm`, `otool -L`,
`strings` and `swift-demangle` (Xcode CLI, read-only). JS offsets are character offsets in the extracted bundles under
`research/granola/raw/asar/`.

| ID | Location | What it shows |
|---|---|---|
| D1 | REA objdump symbols `ev_95c908f2…db0f5b` (parent `ev_067371b72b407b7391984a38767071724660de04abe25e0b9bffb6ebaf4029d1`) on `native/ax_meeting_detector.node` | Swift addon. Exports a detector with `read(bundleId:pids:isBrowser:)` and `pids(bundleId:)`. Internal helpers read windows, browser tabs, URLs and titles; parse meeting IDs from URL or tab/window title; Zoom/Teams/Meet patterns. Links ApplicationServices (`AXUIElementCreateApplication`, `AXUIElementCopyAttributeValue(s)`, `AXUIElementSetMessagingTimeout`, `AXIsProcessTrusted`) |
| D2 | REA objdump symbols `ev_1adfdc59735aaa3354a21a98136ab866c529ee74d8b15bc7a8ca4a94b4634fc3` (parent `ev_a7727540…`) on `native/macos_mic_apps_with_devices.node` | Objective-C++ addon with three functions: active input processes, default input device UID, all input device UIDs. Imports only `AudioObjectGetPropertyData(Size)`, `NSRunningApplication`, `dlsym` |
| D3 | `strings` on D2's binary | Core Audio property selectors for the process-object list, "is running input", PID, bundle ID, process devices, device UID, default input device, device list. A private "responsible PID" symbol name is resolved through `dlsym` |
| D4 | REA objdump symbols `ev_fcc81afa1c84341554eb307a4c132d02559d58e9589e8bff51e385b4c47b8131` (parent `ev_4820a3bc…`) on `native/eventkit.node` | EventKit addon: authorization status, request access (uses the macOS 14 full-access call when it exists), list calendars, `getEvents(start,end)`, start/stop watching `EKEventStoreChangedNotification` on its own thread |
| D5 | REA objdump file headers `ev_2bb982cff2b173c50173f109d1b392bc58f63dd41a32e2f989c3f26d63d5c52f` + `strings` on `native-host/meet-consent-host` | Go 1.23 executable, a Chrome native-messaging host. Functions read from Chrome and send to Chrome, dial Electron and read from it over a per-user Unix socket |
| D6 | `dist-electron/macos_mic_apps_with_devices_process/index.js` | utility process **polls every 1 s**, diffs (bundleId, pid, device) tuples, posts only on change |
| D7 | `dist-electron/main/index.js` @~1134000–1137000 (`XRe`, `KRe`, `GO`, `JO`, `WRe`) | main: maps helper bundle IDs to parent apps, drops non-meeting apps, **2 s debounce before publishing "no meeting apps"**, restarts the child 5 s after a crash |
| D8 | `index.js` @~1137897 (`nze`, `aze`) and @1152946 (`yBe`) | source selector: macOS ≥ 14.2 uses D6. Older macOS streams the system log for Control Center's mic-in-use attribution. Windows uses `mic_monitor_v2` |
| D9 | `index.js` @~203000–206800 (`Ea`, `Na`, `Ma`) | built-in allowlist of about 35 meeting-capable apps (native clients, browsers, the Meet PWA) plus a browser subset |
| D10 | `index.js` @2563565 (`vvt`) | one fan-out handler for every mic-apps change: shared state, notification, AX detector, speaker-attribution monitors, mute sync, device follow |
| D11 | `index.js` @2383433 (`ilt`), @2372249 (`w8`, `Bct`), @~2375349 (`Zct`) | the "meeting detected" prompt: gating, calendar lookup, delay, rate limit, per-app silencing |
| D12 | `index.js` @1739158 (`p1`), @1738996 (`f1`) | the calendar-overlap rule and the main-process copy of merged calendar events (pushed from the renderer) |
| D13 | `index.js` @2473087 (`T7`), @2478963 (scheduler loop), @2455779 (`Cpt`) | calendar-driven "meeting starting" notifications: eligibility, 10-minute rescan, about 1 minute lead |
| D14 | `index.js` @~2014983–2017605 + `dist-electron/eventkit_process/index.js` | EventKit lifecycle: IPC handlers, change watcher in main, child process fetching a window from yesterday to 14 days ahead, normalised to a Google-Calendar-like shape |
| D15 | `index.js` @1301755 (`TKe`, `OKe`, `kKe`, `DKe`) | AX detector driver: per app, read every 2 s up to 30 times until stable; result is only logged in this build |
| D16 | `index.js` @1335199 (`uz`, `dz`, `fz`, `mz`) and @1419372 (`kXe` …) | meet-consent host install (manifests in 8 Chromium-family browsers, 3 extension IDs), socket path, extension event schema |
| D17 | `dist-app/assets/primary-CvQXJiuH.js` @~6297850–6300562 (`Kmr`, `Wmr`, `Umr`, `Hmr`, `Gmr`, `Vmr`) | renderer auto-stop: mic app gone, calendar end ±5 min, LLM check, browser-extension "meeting ended" |
| D18 | `primary-*.js` @~6288339 (`_8`, `lmr`, `S8`, `gmr`) | inactivity auto-stop and warning timers, reset on each transcript update |
| D19 | `primary-*.js` @6809139 (`zkr`) | auto-start transcription about 0.7 s before a calendar event when its note is already open |
| D20 | `dist-app/assets/notification-BF-RkxvQ.js` (`Oe`) | notification countdown bar: 20 s, pauses on hover, then auto-starts (if enabled) or dismisses |
| D21 | `index.js` flag table @~567400–578000; renderer flags in `cache-kv2l_fkS.js` | bundled defaults of the detection flags (table below) |

## 1. The big picture

```
 ┌──────────── signals ────────────┐            ┌──────── main process ─────────┐        ┌─── UI ───┐
 mic-in-use per app (Core Audio,    ──1 s poll──▶ normalise → allowlist → debounce│──────▶ toast panel
  macos_mic_apps_with_devices)                  │  "micApps" (shared state)     │        (20 s bar)
 calendar events (Google/MS via     ──push─────▶ calendar store (f1)            │──────▶ "meeting soon"
  server, Apple via eventkit.node)              │  overlap rule p1 / scheduler T7│        toast (−1 min)
 AX tree of meeting app / browser   ──2 s × ≤30─▶ meeting id + title (logged)   │
 Chrome extension via meet-consent  ──socket───▶ presence / participants / ended│──────▶ auto-stop,
  -host (Meet only)                             └───────────────────────────────┘        consent notice
                                                         │ renderer: start / auto-stop transcription
```

The **primary trigger is "a known meeting app is using the microphone"**. The calendar never starts detection by
itself, except for the scheduled "meeting starting" toast and auto-start when a note is already open. It is used to
**name** the detected meeting, to **attach** the note to an event, and to **decide on auto-stop**. Accessibility
reading and the browser extension add meeting identity (meeting code, title, participants) and an exact "meeting
ended" signal. **confirmed** (D10, D11, D17)

## 2. Signal 1: which apps are using the mic (`macos_mic_apps_with_devices.node`)

- **Native side** (D2, D3, **confirmed**): one call asks Core Audio for the list of *audio process objects*. This is
  the process-object API added in macOS 14.2. For each process it reads whether it is *running input*, plus its PID,
  bundle ID and the input devices it uses (as device UIDs). Separate calls return the default input device UID and
  all input device UIDs. `NSRunningApplication` resolves PID → bundle ID. A private "responsible process" lookup is
  loaded dynamically, most likely so a helper process (browser renderer, WebKit GPU process) counts as its parent
  app (**inferred**). No Accessibility or Screen Recording permission is needed for this signal. The mic TCC prompt
  is not triggered either, because it reads metadata only (**inferred**).
- **Polling, not events** (D6, **confirmed**): a dedicated utility process calls the addon **every 1 s**. It keys
  each entry by (bundle ID, PID, device UID) and posts an update to main only when the set, the default device or
  the device list changes (always once at start), with `added`/`removed` diffs.
- **Normalisation in main** (D7, D9, **confirmed**):
  1. Helper bundle IDs map to the user-facing app (Chrome/Edge/Brave/Arc/Dia helpers → browser; Zoom's sub-processes
     → Zoom; the WebKit GPU process → Safari; the FaceTime daemon → FaceTime; Teams module host → Teams; and so on).
  2. Anything not in the built-in **meeting-app allowlist** (about 35 entries: Zoom, Teams, Webex, Slack (huddles),
     FaceTime, WhatsApp, Discord, Tuple, virtual-office apps, softphone dialers, plus every major browser and the Google Meet
     PWA) is ignored. Ignored bundle IDs are still logged.
  3. Duplicate processes of one app are folded. The preferred device UID is the one equal to the default input
     device, and loopback/virtual devices on a configurable deny-list are skipped.
  4. **Debounce:** a change to "no meeting apps" waits **2 s** before it is published, which absorbs brief mic
     releases. A change to "some app" is published at once. Duplicate snapshots are dropped.
  5. If the child crashes it is restarted after **5 s**.
- **Fallbacks** (D8, **confirmed**): on macOS before 14.2 main runs the system `log stream` filtered to Control
  Center's sensor-indicator messages (the source of the orange mic dot) and parses the `mic:<bundle-id>` attributions
  from it. On Windows a different addon (`mic_monitor_v2`) delivers audio-session start/stop events.
- The resulting `micApps` list (bundle ID + optional device UID) goes into the main-owned shared state (bundle-map
  §6), so every window sees it. It also feeds "follow the meeting app's mic device", a flag that switches Granola's
  capture input to the device the meeting app uses. **confirmed** (D10, D7 `MKe`)

Note: browsers count as meeting apps. Chrome using the mic for any reason triggers the same path, and only the AX
reader or the extension (below) can tell a Meet call from, say, a voice memo site. **inferred**

## 3. Signal 2: the calendar (`eventkit.node` + server calendars)

- **Sources.** Google/Microsoft calendars come from Granola's backend (not studied here). Apple Calendar comes from
  **EventKit** on device, behind a flag (`apple_calendar_enabled`, bundle default off) and a user toggle.
  **confirmed** (D14, D21)
- **EventKit addon** (D4, **confirmed**): authorization status, request access (it prefers the macOS 14 *full access
  to events* call), list calendars (id, title, colour converted to sRGB, account name), `getEvents(start,end)`
  through a date-range predicate, and a watcher that subscribes to `EKEventStoreChangedNotification` on a background
  thread and calls back into JS.
- **Process split** (D14, **confirmed**): permission and calendar-list IPC (`eventkit:get-authorization-status`,
  `eventkit:request-access`, `eventkit:get-calendars`, `eventkit:set-enabled`) and the **change watcher run in main**.
  Event fetching runs in an `eventkit` utility process. The child fetches **from 24 h ago to 14 days ahead** at
  start (if authorised) and whenever main sends a refresh. Main sends a refresh on every store-changed notification
  and when the user's selected-calendar set changes. So EventKit is **event-driven with no polling**.
- **Normalisation** (D14, **confirmed**): each EKEvent becomes a Google-Calendar-shaped object (id prefixed
  `eventkit:`, iCal UID, title, notes, location, URL, all-day dates vs. date-times, attendees with response status,
  organizer, status mapped to confirmed/tentative/cancelled). An attendee is marked "self" when their email matches
  the signed-in user. Events from deselected calendars are filtered out. So downstream code treats every calendar
  source the same.
- **Merged store in main.** The renderer merges all calendar sources and pushes the list to main (`set-calendar-events`),
  where it backs the tray title, notification scheduling and the overlap rule. **confirmed** (D12, D13)

### Calendar overlap rule (used by the mic prompt) (D12, **confirmed**)
"The current event" is the **last** event in the list that has start and end times and that is either *in progress
now* or *starts within the next 90 s*, and whose start is **no more than 15 min ago**. So a meeting that began
20 minutes ago no longer matches (a late join gets a generic prompt), and joining a minute early still matches.

### Calendar-driven notifications (D13, **confirmed**)
- A scheduler re-scans events **every 10 min**, whenever the event list changes and on system resume.
- Eligible events: have an id, start/end date-times, a title and **at least one attendee**, and the user has not
  declined. Solo blocks don't qualify.
- For events starting within the scheduling window (flag, 10 min default) the toast is timed to appear **about
  58 s before start** and hide **about 4 min after start**. Rescheduled or deleted events cancel their pending toast.
- Just before showing, it re-checks that the event still exists at the same time, that Granola isn't already
  transcribing that event, and that the user isn't already viewing it.
- The tray/menu-bar title shows the current or next event with a countdown (separate from detection).

### Auto-start from an open note (D19, **confirmed**)
If the user owns a note attached to a calendar event that hasn't started, the note has no transcript and nothing
else is transcribing, the renderer arms a timer to **start transcription about 0.7 s before the event start**. It
re-arms after system resume.

## 4. Signal 3: accessibility reading of meeting windows (`ax_meeting_detector.node`)

- **What it reads** (D1, **confirmed** from symbols/imports): for one bundle ID it finds the PIDs, creates an AX
  application element, sets a messaging timeout, and walks **standard windows**. For **browsers** it walks tabs and
  reads each tab's URL and title. For native apps it reads window titles. Parsers pull a meeting identifier out of a
  URL (Meet code, Zoom web, Teams hosts including the `cloud.microsoft` and `.us` domains) or out of a tab/window
  title (Meet's title format, Zoom's meeting window titles, with a list of generic Zoom web titles to ignore).
- **Result shape** (D1, D15, **confirmed**): `outcome` ∈ {meeting, no_meeting, unknown}. A meeting result carries
  platform (google_meet / zoom / msteams), meeting ID, title and source (window vs. tab). A no-meeting result carries
  the hosts seen and the tab count. An unknown result carries a reason (e.g. not trusted = no Accessibility
  permission, no windows, timeout, truncated).
- **Driver** (D15, **confirmed**): on every mic-apps change, each new app gets a reader loop, gated by the
  `ax_meeting_detector` flag (bundle default off). It reads **every 2 s, up to 30 times (about 1 min)** and stops
  early when two consecutive readings agree. A browser reading must also contain a meeting ID and a title before it
  counts as settled. A lost Accessibility permission ends the loop at once. Loops are cancelled when the app leaves
  the mic list.
- **Use**: in this build the only subscriber **logs** the outcome as telemetry. It doesn't change the prompt.
  **confirmed** (D10: one subscriber, `DKe` called once). So it is an experiment that measures how well AX can
  identify meetings, probably a precursor to smarter prompts (**inferred**).
- Related but separate: `third_party_meeting_automation` (Zoom/Teams/Meet-in-Chrome **speaker attribution**,
  participant counts, meeting IDs, camera selection, chat paste) also uses AX. It is started per meeting app from
  the same mic-apps fan-out. That is post-detection enrichment, not detection. **confirmed** (process entry point,
  D10)

## 5. Signal 4: Google Meet browser extension (`meet-consent-host`)

- **What it is** (D5, D16, **confirmed**): a small **Go** binary registered as a **Chrome native-messaging host**
  (`com.granola.app`). Granola writes the host manifest into the NativeMessagingHosts folder of each installed
  Chromium-family browser (Chrome, Brave, Edge, Arc, Chromium, Dia, Vivaldi, Opera) and allows 3 extension IDs
  (dev/alpha/prod). Chrome launches the host. The host relays length-prefixed JSON between the extension
  (stdin/stdout) and the Electron main process over a **per-user Unix socket** in `/tmp`, named with a hash of the
  home directory, with a legacy unhashed fallback (named pipes on Windows).
- **Events from the extension** (D16, **confirmed** schema): meeting presence (Meet code, session id, participant
  count), participants changed, participant count changed, active speaker changed, mute state changed, meeting ended,
  plus log/analytics envelopes.
- **Uses**: (a) the **consent notice** feature (posting a "this meeting is being transcribed" notice in Meet chat),
  which needs the meeting to be "Meet-eligible": the calendar's conference name says Google Meet, or a mic app is a
  Chrome-family browser or the Meet PWA (renderer `meetingStore` chunk). (b) **Auto-stop on "meeting ended"** (§6).
  (c) Speaker and mute sync.
  **confirmed** (D17, `meetingStore-*.js`)

## 6. Combining signals into the "start notes?" prompt (D10, D11, D20)

Every published mic-apps change runs one handler in main (`vvt`). The prompt part (`ilt`) works like this
(**confirmed**):

1. It fires only when the **number** of meeting apps changes. With **zero** apps it clears the in-meeting "impromptu"
   state and stops.
2. Skip if signed out, in onboarding, or the user has **silenced this app** (a per-app "don't notify for X" list).
3. Take the **first** app in the list. It must be in the allowlist (D9). The toast heading varies by kind (call /
   huddle / meeting) and names the app.
4. Look up the **current calendar event** with the overlap rule (§3). If there is one, the toast shows the event
   title and time instead of the app name.
5. Rate limit and suppression (`w8`): no prompt if prompts are globally blocked, if an impromptu prompt was shown in
   the **last 2 min**, or if Granola is already transcribing (or starting to) the same event or any meeting.
   If there is no event, the prompt is also skipped when another generic toast is already on screen.
6. **Delay:** the toast appears after `mic_apps_notification_delay_seconds` (**2 s** default). That is on top of the
   1 s poll and the 2 s "gone" debounce, so a mic grab shorter than about 3 s never prompts. It hides after 2 min.
7. The toast is a top-right always-on-top panel, visible on all Spaces, that doesn't steal focus. It has a **20 s
   progress bar** that pauses while hovered (D20). Clicking it or choosing "start" creates a new note (linked to the
   event if there is one), opens the window in side/mini mode and starts transcription. With the `autostart_micapps`
   flag (default off, shown in Labs) the bar becomes an **auto-start countdown**: when it completes, notes start
   unless the user cancels. A newer path (`nub_v3` flag) shows the prompt inside the floating "nub" widget instead,
   with the same gates.

The calendar-scheduled toast (§3) and the mic toast are deduplicated per event: a mic prompt for an event whose
calendar toast is already visible is suppressed. **confirmed** (`Bct`, `Zct`)

## 7. Auto-stop (D17, D18)

All auto-stop logic lives in the **renderer**, which watches `micApps` from shared state (**confirmed**):

- **Meeting app left the mic** (`Kmr` → `Wmr` → `Umr`): on a change from non-empty to empty `micApps` (already 2 s
  debounced in main):
  1. Bail if nothing is transcribing, or if the **system-audio** transcript started **less than 3 min** ago (short
     sessions are never auto-stopped).
  2. If the note's calendar event **ends within ±5 min of now**, stop at once.
  3. Otherwise ask an **LLM** whether the transcript so far looks like the meeting ended, and stop only on yes (and
     only if the same note is still transcribing). The `llm_auto_stop` flag exists, default off; how it gates this
     step was not traced (**inferred**).
- **Extension says the Meet call ended** (`Gmr`, flag `meet_consent_extension_auto_stop`, default off): apply the
  same 3-min floor, then stop only if the ended meeting code equals the note's Meet code. If the note has no code,
  stop only when no other Meet call is active.
- **Inactivity** (`inactivity_auto_stop` / `inactivity_warning`, default off, timeouts come from the server): a
  timer is **reset every time the note's transcript changes**. An optional earlier warning (banner/nub) offers "keep"
  (which can also restart the transcription provider and audio capture) or "stop". On timeout transcription stops,
  with a toast offering resume.
- Every automatic stop records its reason (inactivity / mic app + LLM / mic app + near event end / extension
  ended), may bring the main window forward, then follows the normal end-of-meeting path (summary generation unless
  the transcript is too short).
- The in-meeting nub also handles "Granola virtual camera unused while the meeting app is gone" countdowns, a
  separate feature.

## 8. Bundled flag defaults relevant to detection (D21, confirmed; server can override)

| Flag | Default | Effect |
|---|---|---|
| `mic_apps_notification_delay_seconds` | 2 | delay before the mic prompt |
| `autostart_micapps` | off | prompt countdown auto-starts notes |
| `ax_meeting_detector` | off | run the AX reader on mic apps |
| `apple_calendar_enabled` | off | EventKit integration |
| `meeting_notification_scheduling_window_ms` | 600000 | look-ahead for calendar toasts |
| `meeting_notification_skip_rescheduled_meetings` | on | drop toasts for moved/deleted events |
| `follow_meeting_app_mic_device` / `prefer_default_mic_app_device` | off | capture from the meeting app's mic |
| `never_follow_mic_app_device_uids` | [] | deny-list of (loopback) devices |
| `llm_auto_stop`, `notify_auto_stop`, `inactivity_auto_stop`, `inactivity_warning`, `meet_consent_extension_auto_stop` | off | auto-stop variants (renderer flags) |
| `nub_v3` | off | prompt inside the nub instead of a toast panel |
| `active_listening`, `active_listening_calendar` | off | (not traced; likely an always-listening mode) **unknown** |

The defaults are conservative. In production most of these are probably turned on server-side for some cohorts
(**unknown**).

## 9. Limitations

- REA's **Hopper provider hung on the first open** (`macos_mic_apps_with_devices.node`, a universal binary; probably
  an architecture-choice dialog in Hopper), and `close_binary` keeps reporting `cleanup_incomplete` for the
  retained document `/private/tmp/rea-sYluu6`. **A human needs to close that Hopper document (or quit Hopper) and
  restart the REA MCP connection.** So no pseudocode was produced. The native descriptions rest on exports,
  imports, demangled Swift symbols and selector constants, which is enough for *what* each addon reads but not for
  its internal heuristics (e.g. exact AX attribute walk, title regexes).
- The renderer-side merge of Google/Microsoft/Apple calendars and the backend calendar sync were not traced.
- The LLM "has the meeting ended?" prompt was deliberately not read (clean room).

## Implications for Oat (PLAN 7.1 / 7.2)

What we'd do the same:

1. **Mic-in-use by app as the primary trigger.** Add a Swift sidecar command (e.g. `mic-apps watch`) that uses the
   Core Audio process-object API (macOS 14.2+: process list → is-running-input, PID, bundle ID, devices) and maps
   helper processes to their parent app. It needs no extra permission. Poll at about 1 Hz inside the sidecar and emit
   diffs only. Below 14.2 we simply don't support detection (our min OS can be 14.2; log a DECISIONS entry).
2. **An allowlist of meeting apps** plus a helper-to-parent map, kept as data in a shared package, with a per-app
   "don't prompt for this app" user setting.
3. **Asymmetric debounce:** publish "app started using the mic" at once, "no app" after about 2 s, and show the
   prompt after a further about 2 s. Rate-limit prompts (about 2 min) and suppress them while already recording.
4. **The calendar names the meeting but doesn't detect it.** Match the "current event" as in progress or starting
   within about 90 s, and not started more than about 15 min ago. Put this in a pure function with fixture tests
   (fits 7.2's verifiability).
5. **EventKit in the sidecar, event-driven:** commands `calendar status`, `calendar request-access` (use the
   macOS 14 full-access API), `calendar list`, `calendar events --from --to`, and a `calendar watch` stream backed
   by `EKEventStoreChangedNotification`. Fetch a window from yesterday to 14 days ahead. Normalise to our own
   `CalendarEvent` type behind the `CalendarSource` interface, with a fixture source for tests (exactly 7.1).
6. **Calendar "meeting starting" toast** about 1 min before events that have attendees and aren't declined,
   re-validated just before showing.
7. **Auto-stop guard rails:** never auto-stop in the first about 3 min; stop when the meeting app leaves the mic
   *and* the event end is within ±5 min. Otherwise ask the user ("Meeting over? Stop / Keep") instead of calling an
   LLM, at least at first.

What we'd do differently / defer:

- **Skip the AX reader for now.** Granola itself only logs it. It costs Accessibility permission and fragile
  per-app heuristics. Revisit (IDEAS) only if browsers cause too many false prompts.
- **Skip the browser extension + native-messaging host.** It is mainly for Meet consent notices and exact
  "meeting ended". Our mic-gone + calendar-end rule is enough for M7.
- **No log-stream fallback** for old macOS. Too hacky, and it relies on undocumented log formats.
- **Browsers are noisy triggers.** For browser mic use we should prompt only if a calendar event overlaps, or make
  this a user setting. This is a deliberate difference from Granola, which prompts for any allowlisted app.
- **Use native notifications** (UNUserNotificationCenter via the sidecar, or Electron's) instead of a custom panel
  at first. A countdown auto-start can come later behind a setting.
