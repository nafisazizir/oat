# Granola architecture: synthesis (task 0.7)

How Granola desktop (`@granola/desktop` 7.786.3, macOS, inspected 2026-11-14) works end to end, condensed from
the five detailed notes. This file only summarises. It adds no new evidence. For details, read the linked
note and its evidence IDs. Everything here is in our own words. Clean-room rules apply (`.agent/FACTORY.md` §8).

**Confidence** (carried over from the source notes): **[C]** confirmed in shipped code or metadata ·
**[I]** inferred from structure · **[U]** unknown. Bundle defaults of feature flags are known. Server-side
overrides are not, so production behaviour may differ wherever a flag is involved.

**Evidence references** take the form `note:ID`, for example `audio:E8` = `audio-path.md` evidence E8.
Notes: [`bundle`](bundle-map.md) (E1–E10) · [`audio`](audio-path.md) (E1–E21) ·
[`detect`](detection.md) (D1–D21) · [`sync`](storage-sync.md) (S1–S15) · [`ai`](enhance-chat.md) (C1–C21) ·
[`FINDINGS`](FINDINGS.md) (initial recon).

## 1. Overview

```
 ┌─────────────────────────── Electron main process ────────────────────────────┐
 │ windows · tray · deep links · updates · TCC · ~290 origin-checked IPC handlers│
 │ main-owned app-state "cache" (encrypted JSON): transcripts, entity op log     │
 │ TranscriptionSession: per-source ring buffer 120 s ─▶ 2× WSS ─▶ Deepgram (def)│
 │ detection fan-out: mic-apps ▶ allowlist ▶ debounce ▶ prompt / calendar store  │
 └──┬──────────────────────┬────────────────────────────────────────────────┬──┘
    │ IPC (invoke/send/sub) │ utilityProcess × ~14, one native addon each   │ execFile
    ▼                       ▼                                                ▼
 ┌─────────── renderer (one bundle, many windows) ──────┐  storage (SQLCipher SQLite,    granola-diarizer
 │ primary · nub · quick-chat · toasts · overlays        │  1 writer + 4 readers)        (PoC only)
 │ React + TipTap/ProseMirror (+ Yjs) · Zustand · query  │  eventkit · mic_apps (1 s poll) meet-consent-host
 │ capture: getUserMedia + getDisplayMedia loopback      │  accessibility · local_asr     (Chrome native msg)
 │   → 16 kHz, 100 ms Int16 frames tagged mic|system ────┼─▶ main (IPC)
 │ sync engines (5) · enhancement/chat clients           │◀─ MessagePort ── storage
 └──────────────┬───────────────────────────────────────┘
                │ HTTPS RPC (POST /<endpoint>) · per-user WebSocket (hints) · PartyKit Yjs rooms · SSE
                ▼
          Granola backend: docs/entities/collections, transcript store (PII redaction), short-lived STT
          tokens, prompts by slug + durable generation jobs, chat with server-side tools, calendars
```

Big-picture takeaways:
- An ordinary Electron + Vite (Rolldown) shell. The hard parts are small single-purpose native modules,
  each isolated in its own utility process. [C] `bundle:E7,E9`
- On macOS the audio is captured **in the renderer through Chromium web APIs**, not by a native addon. [C] `audio:E1,E2,E6`
- The server owns prompts, generation jobs, chat tools and STT credentials. The client sends named variables
  and renders streams. [C] `ai:C3,C7,C9`, `audio:E8`
- Sync is five separate mechanisms layered by data type, the result of history rather than design. [C] `sync:§1`

## 2. Shell and process layout ([bundle-map.md](bundle-map.md))

- Electron 45, macOS 13+, universal. Hardened fuses: no run-as-node, no inspect, asar integrity and asar-only. [C] `bundle:E1,E10`
- **One renderer bundle for every window.** The window kind comes from a URL hash, and each kind's chunk is
  lazy-loaded. The main window can reshape into a small always-on-top "mini/side" mode during a meeting. The
  "nub" is a non-focusable floating panel. [C] `bundle:E7,E8`
- **One preload bridge** with three primitives (invoke, send, subscribe returning an unsubscribe). Every main
  handler checks that the sender is a main frame on the app origin. An `isWebShell` flag suggests the same
  renderer also ships as the web app. [C] bridge, [I] web reuse. `bundle:E5,E6,E7`
- **Native capabilities run in utility processes** (about 14, one addon each, `parentPort` messages). Storage,
  dictation, AX and mission-control hand the renderer a direct MessagePort so traffic skips main. [C] `bundle:E7,E9`
- **Cross-window live state** lives in a main-owned reducer store. Renderers send actions tagged with a client
  id and a sequence number. Main commits each one and broadcasts the transaction with a global sequence
  number. Volatile fields are cleared on boot. [C] `bundle:§6`

## 3. Capture ([audio-path.md](audio-path.md) §1)

- **macOS:** main tells the primary renderer to start. The **mic** is captured with `getUserMedia`, using
  Chromium echo cancellation with all system output as the reference. **System audio** is captured with
  audio-only `getDisplayMedia`, which main answers with loopback. Chromium features are switched so that
  loopback uses a **Core Audio process tap** on macOS 14+ and ScreenCaptureKit on older versions. [C] `audio:E1,E2,E6`
- One AudioContext runs at **16 kHz**. Each source has its own AudioWorklet that emits **100 ms mono** blocks
  stamped with wall-clock time. These are converted to **Int16 LE** and sent to main tagged mic or system. [C] `audio:E3,E4,E5`
- **Windows:** a native utility process delivers paired mic and system buffers in the same downstream format. [C] `audio:E20`
- The sources are **never mixed**: two buffers, two STT sockets, and transcript chunks carry their source. [C] `audio:E4,E12`
- `screen_capture.node` takes **window screenshots** for screen-share context. It is not audio (this corrects
  our first guess). `granola-diarizer` (Swift, built on FluidAudio) is used only by an off-by-default
  voice-fingerprint experiment, after the meeting. [C] `audio:E17,E18,E19`
- **No audio is kept by default.** It lives only in RAM (ring buffers and queues). Debug WAV saving exists
  behind a flag, is off, and has a 7-day cleanup. [C] `audio:E12,E16`

## 4. Transcription ([audio-path.md](audio-path.md) §2–3)

- **Default provider: Deepgram live (nova-3)** over a direct WSS, one socket per source, linear16 at 16 kHz,
  with interim results, smart formatting, keyterms, a 3 s KeepAlive and a 30 s stall check. The
  model-improvement opt-out is on. [C] `audio:E8,E15`
- Alternatives behind flags: AssemblyAI streaming, a Granola-hosted relay (frames carry an 8-byte capture
  timestamp prefix, and the session can resume), and on-device Parakeet or whisper.cpp. Opus streaming via
  `opusscript` is available but off. [C] `audio:E7,E9,E10,E14`
- **Credentials:** the backend mints a short-lived provider token from the user session. The client caches it
  until just before it expires. [C] `audio:E8`
- **Timestamps** are anchored to the capture wall-clock plus provider offsets, so reconnects don't shift them. [C] `audio:E8`
- **Resilience layers:** (1) a reconnecting socket with an unbounded send queue and jittered backoff
  (1–5 s, ×1.3, capped at 10 s); (2) a per-source **120 s ring buffer** replayed into a new connection, with
  provider failover (budget 4); (3) optional batch catch-up for backlogs of 10 s or more; (4) optional local
  ASR bridge. With the defaults, outages up to about 2 minutes lose nothing. Longer outages lose audio. [C] `audio:E11–E14`

## 5. Local storage and sync ([storage-sync.md](storage-sync.md))

- **On disk:** `granola.db` (SQLCipher SQLite, WAL) holds documents, AI panels, calendar cache, Yjs update log,
  FTS5 trigram indexes, dictation and sync bookkeeping. An encrypted JSON "cache" in main holds preferences,
  **transcripts**, the entity op log and websocket sequence numbers, rewritten whole and throttled to every 10 s. [C] `sync:S2,S3,S7`
- **Local state is disposable.** A corrupt store, a DB written by a newer app version or a failed migration
  means wipe and resync. The schema version lives in the DB (54 migrations). [C] `sync:S2,S3,S7`
- **Storage process:** 1 writer and 4 read-only workers. An update hook coalesces changed table names and
  pushes them to every renderer port, where live queries re-run. No polling. [C] `sync:S1,S2`
- **Five sync mechanisms** [C] `sync:§5`:
  | Data | Mechanism | Conflicts |
  |---|---|---|
  | documents + AI panels | full/partial diff by `updated_at`, whole-row upsert, implicit outbox (newer local row) | whole-row LWW; Yjs merge for bodies |
  | entities (chat, MCP, automations) | op log in main cache, batched push, per-op status + rollback | LWW per entity; pending local ops protected |
  | collections (dictation) | **trigger-driven SQLite outbox**, version-acked push, cursor pull in one txn, applying-remote flag, 409 → full resync | LWW; local pending beats remote insert |
  | transcripts | append-only chunks marked unsynced, timer upload, cleared only if unchanged since upload, server PII redaction | none by design |
  | note bodies | Yjs over PartyKit rooms + local append-only Yjs log compacted at 500 updates | CRDT |
- **Realtime** is one per-user WebSocket carrying **invalidation hints** with sequence numbers and
  replay-from-seq. Data always comes over HTTP pulls, with a periodic poll as backstop. [C] `sync:S11`
- The API is RPC-style POST with named serial write queues and a backoff ladder. **No "conflicted copy"
  concept exists.** LWW losers are overwritten silently. [C] `sync:S6,§7`

## 6. Enhancement ([enhance-chat.md](enhance-chat.md) §1–7)

- **Inputs are built on the client** as one flat variable bag per document: notes Markdown plus the user's own
  headings, a speaker-labelled transcript text with flags for short or attributed, people (colleagues vs
  externals split by email domain, bios), viewer profile, meeting metadata, locale and dictionary, template
  sections. Attachments are sent as extra user messages. [C] `ai:C1,C9`
- **The server owns the prompt.** Requests send a slug plus variables. One server prompt serves every user
  template. Built-ins are slugs. [C] `ai:C3,C7`
- **Transport:** POST a trigger with an **idempotency key**, which returns a **durable stream URL**. The
  client reads SSE events (completion deltas, generated_lines, final Y.Doc, completed with a character count,
  failed) and resumes after a drop, skipping events it already has. A pending attempt in localStorage lets it
  re-attach after a crash. [C] `ai:C4,C8`
- **The output is a separate "panel"** (its own row and Y.Doc, template slug, `original_content`). The user's
  notes are never rewritten. While streaming it shows a read-only Markdown preview. On completion it swaps to
  an editable TipTap view. [C] `ai:C8,C9,C16`
- **"Mine vs AI" is matched by line text.** The server returns the lines the model wrote. A ProseMirror
  plugin marks blocks whose text matches, and CSS mutes them. Editing a line drops the mark. [C] mechanism, [I] edit effect. `ai:C16,C17`
- **Triggers:** auto when the meeting ends (no panel yet, transcript at least about 2,500 characters), auto on
  stop (at least 3 min recorded, then near the calendar end or a small LLM "did it end?" check, then a grace
  delay of about 10 s), manual, and an offer after transcript edits. The server can block an auto run. [C] `ai:C10,C11,C21`
- **Regenerate** creates a new panel. With the same template, it warns first if `content` differs from
  `original_content`. **No undo** was found. [C] / [I] `ai:C15`

## 7. Chat ([enhance-chat.md](enhance-chat.md) §8–10)

- Each message carries a **typed view-context union** (meeting, live meeting, global, folder, shared, search,
  saved view), plus document ids. Transcripts are dropped for selections over 25 documents. Single-note chat
  reuses the enhancement variable bag. [C] `ai:C13,C19`
- **Stream:** boundary-delimited JSON events (text deltas, context sources, structured output parts,
  completion with changed blocks, error). Output parts include reasoning, cited text, tool calls with
  approval state, and draft previews. [C] `ai:C5,C19`
- **Citations** are per answer line, pointing to a meeting with a source type. The quote is fetched lazily
  on hover. They carry **no segment id or timestamp**, so there is no jump to a transcript time. [C] `ai:C6,C14`
- **Tools** mostly run on the server and have a large registry. Two act client-side on notes: *edit*, a
  Markdown find/replace applied as a minimal block diff into the Y.Doc with animation, and *rewrite*, which
  creates a new panel. Threads and messages sync as entities. [C] / [I] `ai:C12,C13`

## 8. Meeting detection ([detection.md](detection.md) §1–2, §4–7)

- **Primary trigger: a known meeting app is using the mic.** A utility process polls the Core Audio
  process-object API (macOS 14.2+) **every 1 s** for input-running processes with bundle ID and devices, and
  posts diffs only. It needs no extra permission. [C] `detect:D2,D3,D6`
- **Main normalises the list:** helper processes are mapped to their parent app, an allowlist of about 35
  apps (native clients, all major browsers, the Meet PWA) is applied, duplicates are folded, and the debounce
  is **asymmetric** ("app appeared" publishes at once, "no apps" waits 2 s). A crashed child restarts after
  5 s. Older macOS falls back to parsing the system log. [C] `detect:D7,D8,D9`
- **Prompt rules:** the prompt fires when the number of apps changes. It is skipped when signed out, during
  onboarding, or for a silenced app. The calendar overlap names the meeting. Rate limit: one generic prompt
  per 2 min, and none while already transcribing. It appears after a 2 s delay as a non-focus-stealing panel
  with a 20 s bar (optionally an auto-start countdown). [C] `detect:D10,D11,D20`
- **AX reader** (meeting id and title from windows and tabs): flag off, and its result is **only logged**.
  The **Meet extension** with a Go native-messaging host supplies presence, participants and "ended", and
  drives consent notices. [C] `detect:D1,D5,D15,D16`
- **Auto-stop** runs in the renderer: never in the first 3 min. When the mic app leaves, stop if the calendar
  end is within ±5 min, otherwise ask an LLM. Other triggers are the extension's "ended" signal and an
  optional inactivity timer. Each stop records its reason. [C] `detect:D17,D18`

## 9. Calendar ([detection.md](detection.md) §3)

- Google and Microsoft calendars come **through Granola's backend** (not studied). Apple Calendar comes via
  `eventkit.node`, behind a flag that is off by default. [C] `detect:D14,D21`
- **EventKit is event-driven:** it watches for store-changed notifications and fetches a window from
  **24 h ago to 14 days ahead** in a utility process. Events are normalised to a Google-like shape, with an
  attendee marked "self" by email. [C] `detect:D4,D14`
- The renderer merges all sources and pushes them to main. The **overlap rule** picks the last event that is
  in progress or starts within 90 s and began no more than 15 min ago. [C] `detect:D12`
- A **"meeting starting" toast** appears about 1 min before events that have attendees and were not declined.
  The schedule is rescanned every 10 min and on change or resume, and each toast is re-validated before
  showing. **Auto-start** happens about 0.7 s before the event if its note is already open. [C] `detect:D13,D19`

## 10. What Oat does the same / differently / later

| Area | Granola | Oat | Verdict | Refs |
|---|---|---|---|---|
| Shell | Electron + Vite, one renderer / many windows, hardened fuses | same | **same** | D-5, PLAN 1.8 |
| IPC | single bridge, origin-checked handlers | same, typed from a shared contract | **same** | PLAN 1.8 |
| Native isolation | utility process per addon | Swift sidecar process (one binary, many commands) | **same idea, different form** | D-8, PLAN 2.3, 7.1 |
| Capture | Chromium web APIs (AEC + Core Audio tap) | Swift sidecar: AVAudioEngine + voice processing (AEC) + process tap | **different** | D-8, D-17, PLAN 2.3 |
| Frame format | 16 kHz mono Int16, 100 ms, capture timestamp, tagged source | same | **same** | PLAN 2.1, 2.4 |
| STT | Deepgram nova-3, 2 sockets, short-lived token, keyterms | same, behind `SttProvider` | **same** | D-9, D-17, PLAN 2.2 |
| Outage | 120 s RAM ring + queue; batch/local optional | ≥120 s ring **plus backfill from the local Opus archive** | **different (better)** | D-10, D-17, PLAN 2.7, 2.8 |
| Audio kept | none by default | local per-source Ogg Opus archive with playback | **different** | D-10, PLAN 2.8, 3.7, 3.8 |
| Relay / multi-provider failover / local ASR | present behind flags | not in v1 | **later** | IDEAS (Capture) |
| Diarization / voice profile | PoC only | not in v1 | **later** | IDEAS (Capture) |
| Local store | SQLCipher SQLite + encrypted JSON cache, disposable | SQLite cache + outbox, disposable; FileVault | **same model, no app-level encryption** | SPEC §5–6, PLAN 2.6 |
| Sync | five mechanisms, silent LWW | one trigger-driven outbox + cursor pull; LWW + version + **conflicted copy** | **different** | SPEC §5, PLAN 2.6, 3.5 |
| Realtime | WebSocket hints with seq/replay, HTTP pull | same pattern (SSE or hosted WS) | **same** | PLAN 3.5 |
| Co-editing | Yjs over PartyKit | none in v1, editor wrapper Yjs-ready | **later** | SPEC §4 non-goals, IDEAS (Workspace) |
| Editor | TipTap/ProseMirror + Markdown | TipTap JSON canonical, Markdown derived | **same** | D-4, PLAN 3.1, 3.2 |
| Enhance transport | server job, idempotency key, resumable stream | same shape (AI SDK + resumable stream) | **same** | D-3, PLAN 4.4 |
| Enhance output | Markdown stream + server Y.Doc, separate panel | schema-validated JSON → TipTap, separate output | **different** | SPEC §7, PLAN 4.4 |
| Mine vs AI | line-text match | block attribute set during conversion | **different (sturdier)** | SPEC §7, PLAN 4.4 |
| Templates | sections {heading, instructions}, one prompt for all | same | **same** | PLAN 4.3 |
| Regenerate | new panel, warn on edits, no undo | new version, warn on edits, **undo** | **different** | PLAN 4.5 |
| Chat scope | typed context union + doc ids | same | **same** | PLAN 6.3 |
| Citations | per line, lazy quote, no timestamp | segment/block ids with timestamps, jump to audio | **different (better)** | SPEC §7, PLAN 6.4, 3.7 |
| Tools | large server registry, approval states | small set (PLAN 6.2), same approval shape | **subset** | D-7, PLAN 6.2 |
| Detection | mic-apps poll, allowlist, asymmetric debounce, rate limit | same; browsers prompt only with calendar overlap | **same, one deliberate difference** | PLAN 7.2 |
| AX reader / Meet extension / log fallback | experimental / Meet-only / old macOS | skip | **later or never** | IDEAS (Capture: consent helper) |
| Calendar | server Google/MS + EventKit, normalised shape | EventKit via sidecar + Google OAuth, one `CalendarEvent` | **same** | PLAN 7.1, 7.4 |
| Auto-stop | 3 min floor, ±5 min event end, else LLM | same floor and rule, else ask the user | **different** | PLAN 7.2 (see below) |
| Prompt UI | custom panels and countdowns | native notifications first | **simpler** | PLAN 7.2, 9.2 |
| Telemetry | Sentry + Amplitude + rrweb everywhere | error reporting only | **simpler** | — |

## 11. Suggested spec/plan changes (for the orchestrator to decide; nothing edited)

1. **SPEC §5 / PLAN 2.6, 3.5:** name the sync design explicitly: triggers on synced tables enqueue
   (table, id, deleted) with a monotonically increasing outbox version; push acks **by version**; an
   "applying remote" flag suppresses echo; pull uses an opaque cursor, pages until done and applies in one
   transaction that also clears matching outbox rows; a stale cursor → 409 → full resync. Use it for every
   synced table. Propose a DECISIONS entry.
2. **SPEC §5 (conflicts):** specify the conflicted-copy path: push carries the base `version`, the server
   rejects a stale base with 409, and the client keeps the server copy and saves its own as a new
   "conflicted copy" document. Add a test case to PLAN 3.5.
3. **SPEC §6 (desktop):** state that desktop SQLite is a disposable cache: schema version in the DB, and
   wipe + resync on corruption, too-new schema or failed migration. Use a single writer with WAL and an
   update hook that drives live queries. Anything that grows (segments, outbox) lives in SQLite, never in
   JSON files.
4. **SPEC §6 (`transcript_segment`):** client-generated stable id. A final replaces the interim with the same
   id, and only finals enter the outbox. Times use the recording clock (shared with the audio archive).
5. **PLAN 2.7 → split out 2.9 "Archive backfill":** after an outage longer than the ring buffer,
   re-transcribe the gap from the local Opus files (batch STT) and merge the results as finals. D-17 already
   commits to this, but no task owns it.
6. **PLAN 2.2:** acceptance includes KeepAlive, a stall/liveness timer that triggers a redial, keyterms from
   meeting metadata, and the provider's model-improvement opt-out set by default.
7. **PLAN 2.3:** acceptance states that the mic uses the voice-processing I/O unit (AEC), per D-17, and that
   system capture uses a process tap. Add a fixture test for echo bleed, if one is feasible with `FileSource`.
8. **PLAN 1.8 (or new 1.11):** one renderer bundle with route-per-window, a typed preload bridge
   (invoke / send / subscribe) generated from a contract in `packages/core`, a sender-origin check on every
   handler, hardened Electron fuses, and a small main-owned sequenced store for cross-window live state
   (recording status, active meeting, levels).
9. **SPEC §7 / §6:** add an `origin: mine | ai` attribute on TipTap blocks, set during structured output →
   TipTap conversion, which drives the muted style. Enhancement output is a separate object
   (`enhancement.output_json` + `original_json`); the user's own notes are never overwritten. Decide whether
   the meeting view shows the enhancement as a tab next to "my notes" (Granola-style) or as the document body.
   Needs a DECISIONS entry.
10. **SPEC §6 (`enhancement`) / PLAN 4.4:** add run state (`status: generating | completed | failed`,
    `started_at`, `failed_at`, staleness timeout) and an idempotency key. Generation is a server job with a
    resumable stream, and the desktop persists a pending attempt so it re-attaches after a crash or reload.
11. **PLAN 4.5:** keep earlier enhancement outputs as versions (undo / restore). Warn before regenerating
    with the same template when current ≠ original.
12. **PLAN 4.3:** template = title, description and ordered sections {heading, instructions}. One prompt
    serves all templates (built-ins included), and the section budget scales with transcript length.
13. **PLAN 4.4 / 4.6 / 6.3:** one shared `buildMeetingContext()` in `packages/ai` (notes Markdown + own
    headings, speaker-labelled transcript, colleagues vs externals by email domain, about-me, locale, custom
    vocabulary) used by both enhance and note-scoped chat.
14. **New PLAN 7.5 "Auto-enhance and auto-stop":** 3-min floor, stop when the mic app is gone and the event
    end is within ±5 min, otherwise ask the user. Auto-enhance when no output exists and the transcript
    passes a minimum length, after a grace delay that resuming cancels.
15. **PLAN 7.2:** make the rules pure functions with fixture tests: allowlist + helper→parent map as data;
    asymmetric debounce (appear now, gone after about 2 s); prompt delay about 2 s; 2-min rate limit; no
    prompt while recording; per-app silence setting; **browsers prompt only with calendar overlap**
    (deliberate difference). Add a sidecar `mic-apps watch` command (Core Audio process objects, 1 Hz, diffs).
16. **PLAN 7.1 / 7.3:** EventKit is event-driven (store-changed watch) with a fetch window of −24 h to +14 d.
    Define one normalised `CalendarEvent` shared with Google (7.4). Overlap rule: in progress or starting
    within 90 s, and started ≤ 15 min ago. Add a "meeting starting" notification about 1 min before events
    with attendees.
17. **SPEC §4 / DECISIONS:** record that detection requires macOS 14.2+ (our 14.4 minimum covers it) and
    that there is no log-stream fallback. Also record that the AX reader, the Meet extension and app-level
    encryption at rest (SQLCipher) are deferred to IDEAS.
18. **PLAN 3.6:** add desktop-local FTS5 (trigram) over notes and segments for offline, instant search,
    alongside Postgres FTS.
19. **SPEC §6 (`chat_message`) / PLAN 6.3:** store a typed `context_json` (note, live note, folder, search,
    workspace) plus document ids on each message. Drop full transcripts above about 25 documents and rely on
    retrieval.
20. **PLAN 6.2 / 6.4:** retrieval tools return segment ids with `start_ms` and block ids, so citations are
    exact and can seek audio. `updateDocument` works as a find/replace applied as a minimal block diff,
    with a pending / approved / denied state on the tool part. The message-parts schema leaves room for
    reasoning and draft previews.
21. **SPEC §5 (realtime):** a per-user invalidation channel (SSE) carrying "pull X / ids Y" with sequence
    numbers and replay-from-seq, plus a periodic poll backstop. No row streaming. This belongs in PLAN 3.5.
