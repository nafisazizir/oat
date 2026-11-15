# Granola desktop — Electron bundle map (task 0.2)

Question: how is Granola's Electron app structured? (process layout, windows, IPC surface, renderer framework,
editor, state management, build tooling)

Target: `/Applications/Granola.app`, `@granola/desktop` 7.786.3, inspected 2026-11-14. Static analysis only, no
execution, no network, no user data. Everything below is written in our own words. Raw extracts (asar contents
without `node_modules`, a preload channel inventory, the REA evidence bundle) are in `research/granola/raw/`
(git-ignored). Implementers should rely on this note, not on `raw/`.

Confidence tags: **confirmed** = seen directly in shipped code or metadata · **inferred** = strong structural
signal, behaviour not observed · **unknown** = not established.

## Evidence index

| ID | What | Where |
|---|---|---|
| E1 | REA `inspect_electron_fuses` | `ev_2445700a8b1a281d1f8dcd0fbea0241b8eb3768ba3ccf2af4e083caad51da165` |
| E2 | REA `inspect_desktop_application` (Electron candidate, 840 files) | `ev_c0186ac2c0bb1f611bc6e1d41ff78da1c66b37d1cc34df46a45fd88e671f0850` (parent `ev_a7bcbe05…`) |
| E3 | REA `analyze_javascript_application` on app.asar (preload + main + ipc chunk; integrity policy record-and-continue) | `ev_2d6ab39e…` (parent `ev_260dd3ae440de3d9a688c0b8bbff3bc287a0d311b2a2ba6ac557e092e2c84ea1`) |
| E4 | asar file inventory (1177 entries) | `raw/asar/_listing.tsv` |
| E5 | Preload bridge | `raw/asar/dist-electron/preload/preload.js` |
| E6 | Preload IPC channel inventory (385 channel uses, grouped) | `raw/preload-channels.txt` |
| E7 | Main bundle (≈2.6 MB) | `raw/asar/dist-electron/main/index.js` |
| E8 | Renderer entry + chunks | `raw/asar/dist-app/index.html`, `raw/asar/dist-app/assets/index-BLoGte7Z.js` |
| E9 | Utility-process entrypoints | `raw/asar/dist-electron/*_process/index.js` |
| E10 | Bundle metadata | `Contents/Info.plist`, Electron Framework `Info.plist`, `Resources/app-update.yml` |

REA exported bundle: `raw/rea-evidence-0.2-bundle-map.json` (7 records). Note: REA's Electron summary (E3)
counted 0 windows / 0 IPC channels because the bundler hides `BrowserWindow` and `ipcMain` behind local
wrappers. So the window and IPC findings below come from structural reading of the extracted files (E5–E9),
with file/symbol references. Minified symbol names (e.g. `Y`, `X`, `AE`) are build-specific and will change
between versions.

## 1. Shell and build tooling

- **Electron 45.x** (framework bundle version 45.2.3), macOS 13+ minimum, universal (x64 + arm64). **confirmed** (E10)
- Fuses: run-as-node off, `--inspect` CLI args off, embedded asar integrity validation **on**, load-only-from-asar
  **on**, cookie encryption off. **confirmed** (E1). Info.plist carries the asar SHA-256. **confirmed** (E10)
- **Build: Vite with the Rolldown bundler.** Both main and renderer output include a `rolldown-runtime-*.js`
  chunk; the renderer has a Vite-style `index.html` with `type="module"` entry + `modulepreload` links and
  hashed `assets/`. Two output roots: `dist-electron/` (main, preload, utility processes) and `dist-app/`
  (renderer). **confirmed** (E4, E8)
- Packaging/updates: electron-builder conventions (`app-update.yml`, GitHub provider, electron-updater
  present in main, Squirrel.Mac framework). **confirmed** (E7, E10). There is also a `managed-update/`
  resource dir (enterprise/MDM updates, **inferred**).
- Sentry everywhere (main, preload, renderer; release-injection chunk), Amplitude analytics, rrweb session
  recording chunks in renderer. **confirmed** (E5, E8)
- `package.json` keeps only native/unbundleable deps; everything else is bundled. **confirmed** (FINDINGS.md, E4)

## 2. Process layout

```
                         ┌──────────────────── main process (dist-electron/main/index.js) ───────────────────┐
                         │ app lifecycle, windows, tray, global shortcuts, deep links (granola://),           │
                         │ auto-update, permissions (TCC), authoritative "cache" store (JSON on disk),        │
                         │ ~290 IPC registrations behind a sender-origin check                                │
                         └──┬─────────────┬───────────────────────────┬────────────────────────────────────┘
          ipcMain (invoke/send)│             │ utilityProcess.fork (×14, one per native capability)
                               │             ▼
   ┌───────────────────────────┴──┐   audio · screen_capture · local_asr · speaker_embedding · storage(sqlite)
   │ renderer windows (one bundle) │   accessibility · dictation_utils · eventkit · tcc · mission_control
   │  preload → window.electron    │   mic_monitor_v2 · macos_mic_apps_with_devices · network_doctor
   │  primary / nub / quick-chat / │   third_party_meeting_automation
   │  notifications / overlays …   │◄── MessagePort (direct) ── storage, dictation_utils, accessibility-tree,
   └───────────────────────────────┘                             mission_control
   + standalone binaries: granola-diarizer, meet-consent-host (Chrome native messaging), pause-media helper
```

- **Main** is one large bundle plus small shared chunks (`ipc-*.js`, `utils-*.js`, AWS SDK pieces, VAD,
  local-ASR / speaker-embedding protocol chunks). **confirmed** (E4, E7)
- **Utility processes:** main forks Electron `utilityProcess` children through one helper; each has a
  `serviceName` and its own entry under `dist-electron/<name>_process/index.js`. Each wraps **one native
  addon** (path passed as argv) and talks to main with `parentPort` messages. Observed services: audio,
  screen_capture, local_asr, speaker_embedding, storage, accessibility, dictation_utils, eventkit, tcc,
  mission_control, mic_monitor_v2, macos_mic_apps_with_devices, network_doctor,
  third_party_meeting_automation. **confirmed** (E7 `serviceName` literals, E9). Effect: a crash in a native
  addon kills only that child, not the app (**inferred** as the motivation; the TCC helper, for example,
  has explicit exit/timeout handling).
- **Storage process:** the `storage` utility process runs a `worker_threads` worker that opens an
  **SQLCipher-encrypted SQLite** database via `better-sqlite3-multiple-ciphers` (WAL mode, normal sync, key
  supplied as raw hex; a read-only mode exists). Its protocol is small: open / close / request-response /
  change notifications. **confirmed** (`sqlite_process/index.js`, `sqlite_process/worker.js`). Where the key
  comes from was not investigated (out of scope; keychain addon exists).
- **Direct renderer ↔ utility channels:** main creates a `MessageChannelMain` and hands one port to the
  renderer (`sqlite:port`, `dictation-utils:port`, `accessibility-tree:port`, `mission-control:port`); preload
  relays it into the page with `window.postMessage`. So DB queries skip main. **confirmed** (E5, E7)
- **Local ML:** `local_asr_process` (with a VAD chunk) and `speaker_embedding_process` exist alongside cloud
  STT, so on-device transcription / speaker fingerprinting is at least an option (**inferred**; the cloud-vs-
  local split is task 0.3/0.4 territory). Renderer chunks mention several STT vendors (**unknown** which are
  live).
- Main also starts plain `worker_threads` workers (e.g. a hang watchdog, `main/hang_watchdog_worker.js`).
  **confirmed** (E4, E7)

## 3. Windows

All windows load **the same renderer bundle** from a privileged custom scheme (`app://ui/`, or the Vite dev
server in development). Main picks which UI a window shows through a **URL hash key** (helper `AE` in E7); the
renderer entry reads the hash, maps it to a window kind, and lazy-imports that window's chunk (default
`primary`). **confirmed** (E7, E8 `index-*.js`)

Window kinds found (all `contextIsolation: true`, `nodeIntegration: false`, same `preload.js`):

| Kind | Role (our description) | Native traits | Confidence |
|---|---|---|---|
| primary | the main app: notes, meetings, chat, settings | normal resizable window, hidden title bar with inset traffic lights; close = hide | confirmed |
| primary in "mini" / "side" mode | the *same* window reshaped during a meeting: small, always-on-top, visible on all spaces incl. fullscreen, not maximizable; restored afterwards | set via IPC (`mini-window`, `side-window`, `wide-window`, …) on the primary window | confirmed (handlers in E7) |
| nub | the small floating in-meeting widget (transcript bubbles, meeting controls, notifications, screen-share context review) | macOS `panel`, frameless, transparent, always-on-top, non-focusable, hidden from Mission Control/taskbar; draggable via CSS app-region on `body.nub` | confirmed |
| quick-chat | a global-shortcut summoned chat input that forwards into the primary window's chat | focusable panel | confirmed |
| notification | custom toast/notification panels (meeting starting, etc.), parameterised in the hash | panel, ~400×100 | confirmed |
| active-listening-notification, reminder-agent-notification | specialised notification panels | non-focusable panels | confirmed |
| companion-presence | a thin strip whose height depends on meeting participant count (presence of the AI companion) | non-focusable panel | inferred role |
| hot-corner | screen-corner trigger target | panel | confirmed |
| mini-window-preview, accessibility-overlay, screen-recording-guide (+ backdrop) | onboarding/permission guidance overlays | panels | confirmed |
| webcam-helper-config | config UI for the virtual-camera feature | normal hidden-titlebar window | confirmed |
| demo meeting, setup-in-browser, sandboxed data-URL window | onboarding demo and an isolated helper window | misc | confirmed (existence) |

Plus a **Tray** icon and **global shortcuts** registered in main. **confirmed** (E7)

Committed state and assistant/dictation events are pushed from main to two well-known windows: the primary
window and the nub. **confirmed** (E7 broadcast helpers)

## 4. IPC surface (structural)

- **One bridge object.** Preload exposes a single `window.electron` object via `contextBridge`, built from
  three tiny helpers: request/response (`invoke`), fire-and-forget (`send`) and subscribe (returns an
  unsubscribe function). It also carries a bridge version, shell version/commit, platform and arch, and an
  `isWebShell` flag (false in desktop), which strongly suggests **the same renderer code also runs as a web
  app** against a different bridge. **confirmed** (E5); web-app reuse **inferred**.
- Sentry gets its own small bridge namespace. **confirmed** (E5)
- **Size:** 385 channel uses in preload, about 138 invoke, 152 send, 95 subscribe. **confirmed** (E6). Main
  registers about 135 `handle` and 157 `on` channels through two wrapper functions. **confirmed** (E7)
- **Security pattern:** every main-side handler is wrapped. The wrapper rejects messages unless they come
  from a window's main frame and that frame's URL is the app scheme/host (or the dev-server origin), and
  logs the reason. **confirmed** (E7, sender check next to the `AE` helper; REA counted 2 sender-validation
  observations in E3)
- **Naming:** mostly `namespace:verb` (kebab-case), with older flat names for core items. Main namespace
  groups (from E6): window/nub control (largest), webcam/virtual camera, voice fingerprint (speaker enrolment),
  assistant / assistant-voice / assistant-dictation / attachments, screen-share context, meeting consent,
  encrypted-file storage, cache, preferences, eventkit (calendar), local-asr, transcription
  input/policy/dev, per-app speaker detection (Zoom/Teams/Meet), network doctor, managed preferences, MCP
  install. Flat channels cover session/auth hand-off, account switching, updates, permissions (mic, camera,
  system audio, accessibility, screen recording), audio device + capture state, power-save blocking, system
  sleep/wake/lock events, deep links, and window shape (`mini`/`side`/`wide`). **confirmed** (E6)
- **Audio path:** preload has an explicit relay pair (to/from the audio process) plus subscriptions for
  device changes, volume, active speaker and system-audio state, and a "desired transcription state"
  setter, i.e. the **renderer drives capture intent, main/utility processes own the devices**. **confirmed**
  channel shapes (E6); exact data flow **inferred**.
- **Shared-state channels** (see §6): get snapshot, dispatch action, receive committed transactions.
  **confirmed** (E5, E7)

## 5. Renderer stack

- **React** (react-dom, `createRoot`, React compiler runtime chunk) with lazy chunk per window kind. **confirmed** (E8)
- **Editor: TipTap on ProseMirror**, with a Markdown extension (tiptap-markdown + markdown-it, task lists,
  linkify) and an editor wrapper that takes an optional **Yjs document + provider** to turn on collaboration.
  **confirmed** (chunks `link-*.js`, `gatherPromptInputsForDocument-*.js`, `tiptap-markdown.es-*.js`). Which
  sync provider feeds the Yjs doc is **unknown** (not y-websocket/Hocuspocus by name; check in task 0.5).
- **Yjs** is also used for streaming AI-generated summaries: generation seeds and updates a Y.Doc so the
  summary can stream into the editor durably. **inferred** from structure in `primary-*.js` / `cache-*.js`.
- **ElectricSQL client** (HTTP shape streaming) is bundled in the API chunk. **confirmed** presence
  (`api-*.js`); that it's the main sync path is **inferred**, verify in task 0.5.
- **Server state:** a TanStack-Query-style query client (`useQuery`, query keys, stale time, invalidation).
  **confirmed** API shape; package identity **inferred**.
- **Local UI state:** Zustand-style vanilla stores (`vanilla-*`, `store-*`, `shallow-*`, a preferences
  store), with **Immer** for immutable updates/patches. **confirmed** (E8 chunk names + markers)
- **Styling/UI:** Tailwind CSS (utility vars in the CSS bundles), **Base UI** headless components plus
  some Radix pieces, an internal icon set, Motion for animation. **confirmed** presence
- Chat/AI UI: Markdown renderer with code highlighting, KaTeX and Mermaid; MCP tool views and an MCP
  connector registry (Granola acts as / connects to MCP). **confirmed** presence
- In-browser SQLite (wa-sqlite / sqlite3 over OPFS) is bundled in the renderer, likely for the web build where
  there's no native storage process. **inferred**
- Audio in the renderer: an AudioWorklet processor chunk and `getUserMedia`/`getDisplayMedia` use. **confirmed**
  presence; how it splits with native capture is for task 0.3.

## 6. State management across processes (key design)

Granola keeps one **authoritative app-state object ("cache") in the main process**, persisted as a versioned
JSON file in userData with throttled writes and a cooldown. **confirmed** (E7, around the `cache:` handlers)

- Renderers fetch the whole snapshot on boot (sent as a buffer plus the next sequence number).
- Renderers send **actions** tagged with a client id and client sequence number; main runs them through a
  shared reducer, saves the new state, and broadcasts the **committed transaction with a global sequence
  number** to the primary window and the nub.
- Main can dispatch its own actions the same way (its own client id).
- On load, transient device/meeting fields are cleared (camera routing, generating panels, modals) so a
  crash never restores stale live state.
- Redux DevTools hooks exist in dev builds. **confirmed**

Read with the encrypted SQLite store (§2), the split is: **small, hot, cross-window UI/app state → main-owned
reducer store; bulk documents/transcripts → encrypted SQLite reached via a MessagePort; server data →
query client + sync layer.** (split **inferred** from structure)

## 7. Unknowns / follow-ups

- Which sync mechanism feeds documents (Electric shapes vs. Yjs provider vs. REST polling): **unknown**, task 0.5.
- Cloud vs. local STT routing and the audio transport: **unknown**, tasks 0.3/0.4.
- Exact meeting lifecycle that switches the primary window into mini/side mode and shows the nub: **inferred** only.
- REA's semantic analysis stopped at its default budgets (E3 partial coverage); deeper REA passes could
  resolve wrapper-hidden IPC pairs if ever needed.

## Implications for Oat

What we'd do the same:
1. **One renderer bundle, many windows chosen by route.** Our Electron + Vite setup should build a single
   renderer and open each window (main, floating in-meeting widget, quick capture, notifications) at a
   different route, lazy-loading that window's code. Cheap to add windows, one design system.
2. **Native work in isolated child processes.** Our Swift audio sidecar fits this: run each native
   capability (audio capture, later meeting detection, calendar) as its own child process with a typed
   message protocol, so a native crash can't take down the UI.
3. **A single typed preload bridge** with three primitives (invoke / send / subscribe-returns-unsubscribe),
   context isolation on, node integration off, and **every main handler checking the sender frame and
   origin**. We'll generate the bridge types from a shared contract in a `packages/` module, not hand-list
   channels.
4. **Hardened fuses** (no run-as-node, no inspect args, asar integrity, asar-only) from day one, via the
   electron-builder/forge fuse config.
5. **Main-owned shared state with sequenced actions** for the small amount of cross-window live state
   (recording status, active meeting, mic levels). It cleanly keeps the main window and the floating widget
   in sync. Keep it small and clear volatile fields on boot.
6. **TipTap + ProseMirror + Markdown** matches our SPEC (TipTap JSON canonical, Markdown derived).
   Granola's optional Yjs-backed collaboration wiring suggests we should keep the Yjs/collab door open in
   our editor wrapper from the start, even if M-early is single-user.
7. **Same renderer for desktop and web** behind a bridge abstraction with an "is desktop" flag. This supports
   our Next.js web app sharing workspace UI, but we'd put shared UI in a package rather than shipping the
   Electron renderer as the web app.

What we'd do differently / simpler:
- **Fewer windows at first:** main window + one floating meeting widget. Skip the many onboarding/notification
  panels; use native notifications until there's a reason not to.
- **Storage:** SQLite on desktop (per SPEC) behind its own process/port is a good pattern, but encryption
  (SQLCipher) is a later decision. Log it in DECISIONS.md if we adopt it; don't do it in M1.
- **Main-window reshaping into a mini mode** is a nice touch but optional; a separate floating widget is
  enough for the MVP.
- **Sync:** don't pick Electric vs. Yjs vs. REST from this note. Wait for task 0.5.
- **Telemetry:** we don't need Sentry, Amplitude and rrweb across all processes for a personal app. Start
  with error reporting only.
