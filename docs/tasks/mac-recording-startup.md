# macOS recording startup

status: verify
milestone: M2 · deps: 2.3, 2.4, 2.5

## Goal

Make the desktop recording state reflect whether the native helper has opened an audio source.
Exercise capture, live transcription, stop and playback on a real Mac.

## Context

The helper previously sent `started` before opening either device, which could report a successful
start even if both devices failed. The microphone fallback from #39 is already present in the audio
helper on the test Mac. The baseline microphone test reproduced AVAudioEngine error −10875 with voice
processing enabled and confirmed that the fallback still recorded audio.

## Scope

Swift capture readiness, the desktop sidecar client, and cancellation while waiting for native capture.
The Mac tests also exposed a transcript panel that grew beyond the viewport and a playback state that
could stay set to Playing after leaving a note. This change fixes both in the desktop meeting view.

## Acceptance criteria

- [x] Oat stays in Starting until a device opens. A complete failure rejects the start with diagnostics.
- [x] One working source is enough to record. Startup warnings remain visible.
- [x] Stopping or quitting cancels a pending capture startup.
- [x] A failed first recording leaves the same note eligible for retry.
- [x] On macOS, start from Home, capture the real microphone, read a live transcript, pause and resume,
  stop, play the local archive, then repeat in the same app session.
- [x] Repeat with both the real microphone and system audio.

## Verification

- `pnpm run ci`
- On macOS, `node scripts/ci.mjs --only swift`
- On macOS with the dev stack, `pnpm --filter @oat/desktop e2e recording.spec.ts playback.spec.ts`
- Start from Home in a separate Oat profile on the Mac. Check both capture sources with permission
  granted, the transcript and final archive, and a second recording after stopping.

## Evidence

- macOS 26.6.2 on Apple Silicon. All Swift CI steps passed, including 101 Swift tests and two-channel
  synthetic frame validation. All 7 Node-to-Swift integration tests passed with the rebuilt helper.
- An isolated Electron profile in a separate worktree recorded two real microphone sessions.
  Both produced live and final transcripts via the dev mock STT service and complete, playable
  archives (3.2 s and 2.8 s). The test forced microphone-only capture to use the permission
  already granted on this Mac. A second run also passed with a Playwright trace retained in the
  isolated test worktree.
- The hardware run with both sources enabled passed twice in the same Electron app session. Both
  sources produced live and final transcript segments via the dev mock STT service and complete
  archives. Mic/system durations were 3.343 s/3.372 s and 2.844 s/2.838 s. Pause, resume, stop,
  playback and a second start passed. Playwright retained a trace in the isolated test worktree.
- All 4 checked-in recording and playback Electron tests passed on the Mac, including transcript
  scrolling, two-source fixture recording, playback, and recovery from transcription and sync outages.
- A separate Mac Electron smoke test simulated device-open failure. The UI showed the startup error,
  never entered Recording on that attempt, and recorded successfully when retried.
- Full Linux CI passed format, actionlint, typecheck, lint, unit tests, database migration and
  integration tests. The web E2E step failed two sign-in tests and both themes of the calm-shell
  command-palette test. The same four assertions failed in a clean worktree at the base revision.
- The live transcript overflow probe showed its scroller expanding to 912 px inside a 480 px window.
  The meeting section now has a zero minimum height so the transcript can scroll inside the viewport.
- The playback failure reproduced when leaving the first note during playback and stopping the next
  recording. The player now clears its state when it unloads an audio source even if the media element
  drops the pending pause event.
- PR review follow-up: meeting persistence now stamps the start and changes the end grace state
  when capture starts. The note's Stop button sends a cancellation while Start is still pending.
  Desktop unit tests cover same-note failure and retry, cancellation without a device error, and the
  enabled Stop button. Desktop typecheck, lint, and all four checked-in Mac recording and playback
  E2E tests passed after these changes.
- The updated Electron build passed a simulated startup failure, a canceled start, and a successful
  recording on the same note on the Mac. A separate hardware run on that build recorded two more
  sessions with both real sources and verified mock transcription, pause, resume, stop and playback.
