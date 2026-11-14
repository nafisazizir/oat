# Granola — initial findings

Source: local install `/Applications/Granola.app`, inspected 2026-11-14 by listing the bundle and reading
`package.json` from `app.asar`. Reference only — see clean-room rules in `docs/FACTORY.md` §8.

## Confirmed
- **Electron app**, package `@granola/desktop` v7.786.3, main entry `dist-electron/main/index.js`
  (Vite-style build; most dependencies are bundled, so `package.json` lists only native/unbundleable ones).
- Frameworks: Electron Framework, Squirrel (auto-update), Mantle, ReactiveObjC.
- Runtime deps left unbundled:
  - `better-sqlite3-multiple-ciphers` — **encrypted local SQLite** (local cache/store).
  - `opusscript` — Opus audio encoding, likely to compress audio before streaming to cloud STT.
  - `@mixmark-io/domino` — server-side DOM, likely for HTML → Markdown (turndown).
  - `@discoveryjs/json-ext` — streaming JSON parse/stringify (large caches).
  - `@napi-rs/xattr`, `electron-click-drag-plugin`, `registry-js` + `win-ca` (Windows).
- Standalone binaries:
  - `Resources/granola-diarizer` (arm64 Mach-O) — **local speaker diarization**.
  - `Resources/native/pause-currently-playing-media`.
  - `Resources/native-host/meet-consent-host` — Chrome native-messaging host (Google Meet consent flow).
- Native Node addons in `Resources/native/` (universal x86_64 + arm64):
  | Addon | Probable role |
  |---|---|
  | `screen_capture.node` | system audio (and/or screen) capture |
  | `macos_mic_apps_with_devices.node` | which apps are using the mic → meeting detection |
  | `ax_meeting_detector.node`, `accessibility_tree.node` | detect meeting UI via Accessibility API |
  | `third_party_meeting_automation.node`, `libThirdPartyMeetingAutomationBridge.dylib`, `automation_denylist.node` | interacting with meeting apps (e.g. consent/chat messages) |
  | `eventkit.node` | macOS calendar access |
  | `keychain.node`, `authenticate_device_owner.node` | credential storage, Touch ID / device-owner auth |
  | `tcc.node` | permission (TCC) status checks |
  | `microphone_mode.node`, `dictation_utils.node` | mic mode (voice isolation) and dictation |
  | `mac_webcam_sysext.node`, `docktile.node`, `haptics.node`, `mission_control.node`, `nub.node`, `set_prevents_activation.node`, `sleep.node`, `clamshell_state.node`, `procmem.node` | OS integration (dock, floating "nub" window, sleep/lid state, memory) |

## Takeaways for Oat
- The shell is ordinary Electron + web tech; the hard parts are **small single-purpose native modules**.
  We can build these incrementally (start with one Swift sidecar for audio, add detection later).
- Two-stream capture + local diarizer suggests "me vs them" from channels, plus diarization within "them".
- Encrypted local DB → they keep substantial data locally; worth understanding sync model (task 0.5).

## Open questions for M0
Which STT provider/protocol? Is audio sent as Opus over WebSocket? How is sync done (polling, websockets,
CRDT)? What editor library is in the renderer? How is the "nub" floating window used during meetings?
