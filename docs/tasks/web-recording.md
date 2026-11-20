# Web recording (D-32)

Status: complete · step A review fixes + step B · human-approved.
Branch: `devin/1795160469-web-recording` (fresh origin/main).

## Step A acceptance

- Browser-safe STT entry; fresh token per connect, bearer subprotocol, shared parser/query parameters, reconnect/backoff with in-memory PCM replay. Fake-WebSocket unit coverage.
- Mic plus optional shared tab audio; AudioWorklet downmix/resample to 16kHz Int16 mono on the meeting clock. Pause/resume, tab-ended notice, beforeunload warning and complete resource cleanup.
- Cookie-authenticated same-origin sync pushes: meeting start/end, batched final segments and retractions; failed pushes retained/retried with visible state. Device name Browser.
- Editable web meeting notes offer a small Record/source popover, recording elapsed/pause/stop/live state, optimistic transcript and inline retryable errors. Hide unsupported/unauthorized/already-ended-transcript recording.
- Unit coverage for conversion, reconnect buffer and push queue. Compose-backed Chromium fake-mic E2E proves live text → stop → reload persistence.
- Run `pnpm run ci --fast`, `pnpm --filter @oat/web build`, new E2E; inspect `/home/ubuntu/web-rec-light.png`. Commit/push, no PR.

## Design

Record controls sit in the document action row, left of Enhance; use ziiz Button/Popover/Alert and existing TranscriptList.
Capture → per-source PCM worklet → browser STT → optimistic segments + final-only sync queue.
PCM replay and pending sync buffer in memory. Step B archives per-source Opus/WebM to OPFS, with clock-aligned parts and a neutral shared PlaybackBar. No audio goes to application storage servers; only live STT receives PCM for transcription.

## Step B and review acceptance

- [x] Record/live icon controls appear left of Enhance in the document action row, never beneath the title; healthy sync remains quiet, failures/backlogs over 5s warn with retry.
- [x] Interim updates reuse one bubble; compare the browser reducer to desktop TranscriptBuffer and inspect mock final chunking without stitching genuine final utterances together.
- [x] Per-source MediaRecorder Opus/WebM writes to `oat-audio/<meetingId>/<part>-<source>.webm` in OPFS, with meeting-clock metadata and a new part per resume. Unavailable/full storage warns without stopping STT.
- [x] Shared neutral PlaybackBar/controller, unchanged desktop IPC adapter; web blob-URL adapter supports part/source playback, seeking, transcript highlighting, cleanup and local-only deletion behind confirmation.
- [x] OPFS fake-store unit tests, shared player/desktop regression tests and extended fake-mic E2E prove playback time, segment seek, reload and deletion.
- [x] Fast CI, web/desktop builds and recording E2E pass; inspect recording light + playback light/dark screenshots; commit and push this branch.

## Step A evidence (historical)

- Browser entry `@oat/stt/browser` uses the browser WebSocket and pure shared URL/parser/timeline/emitter modules, not the Node adapter or `ws`. Unacknowledged frames survive reconnects; replay is paced under socket backpressure. Finalization waits for final results and retries interruptions.
- Capture and retrying sync are owned by a browser singleton. Client-side navigation keeps recording and exposes a shell banner with controls/link back; full unload warns while recording or writes remain queued. Meeting metadata reads include calendar linkage on demand, preserving it on upsert. Stop timestamps capture end rather than STT reconnect completion.
- `pnpm run ci --fast`: **ci: ok** (31.1s): format, actionlint, typecheck, lint and tests passed. Includes **11 new unit tests**: browser STT 4, conversion/queue 4, capture failures/cleanup 3.
- `pnpm --filter @oat/web build`: **Compiled successfully in 1031ms**, **Finished TypeScript in 3.8s**.
- `E2E_PORT=3137 E2E_RECORDING_SCREENSHOT=/home/ubuntu/web-rec-light.png pnpm --filter @oat/web exec playwright test e2e/recording.spec.ts`: **2 passed (45.0s)**, including auth setup. Uses compose mock STT and Chromium fake-file mic capture. Proves live transcript, pause/resume, navigation continuity, cookie/Origin-authenticated pushes without bearer headers, stop, reload persistence and hiding Record on the finished transcript.
- Existing changed meeting-header E2E also passed: focused meeting-header + recording run **3 passed (52.4s)** (including setup).
- Inspected `/home/ubuntu/web-rec-light.png`: right-aligned header controls, live indicator/elapsed, visible sync state and optimistic transcript align with ziiz light surfaces.
- Logs: `/home/ubuntu/oat-web-recording-{ci,build,e2e}.log`. Initial E2E assertion used Playwright's abbreviated request headers; fixed to `allHeaders()` before asserting Origin/cookies. A formatting-only CI failure was corrected; final gates above are green.

## Remaining / deliberate boundaries

- PCM replay and unsynced writes remain volatile memory; forced unload loses them despite the warning. Finalized audio is persistent OPFS data, local to this browser, and never uploaded/synced. Browsers without Opus MediaRecorder/OPFS retain transcription with a notice.
- No existing web STT availability flag was found; API capability/edit/ended-transcript checks gate Record. Existing server token configuration selects mock/real provider.
- Native shared-tab permission UI/audio and tab-track-ended behavior are implemented but not exercised against a real tab. Fake-mic Chromium/mocks are the browser integration evidence; real Deepgram and other browsers were not contacted/tested.

## Review fixes and step B evidence

- Controls are in `DocumentEditor`'s action row before Enhance. Healthy sync is hidden; failed pushes or backlogs over five seconds get a small retryable warning in the transcript panel. Storage/capture/STT notices reopen the panel if necessary.
- Captured mock WebSocket Results (`/home/ubuntu/web-rec-stt-results.json`) prove separate true finals: `Let us start with a quick update on` (start 0, duration 3.74), `the` (3.74, duration 1), then `project.` (4.74, duration .62). Corpus mode finalizes on endpointing and stream finalization; pause/resume creates fresh streams. Both Node and browser use 300ms endpointing, the same parser and BaseSttStream stable interim IDs. Browser/desktop-buffer parity tests preserve these genuine final chunks rather than silently joining them; one utterance's interims and final share an ID/bubble, empty finals retract and late interims cannot replace an extant final.
- `AudioStore` fake-directory tests cover incremental append/read/metadata/delete, missing archives, invalid paths, unavailable/full storage and asynchronous MediaRecorder final chunks across resumed parts. Archive failures do not stop capture/STT. Web playback creates/revokes per-source blob URLs, handles part/source selection, gaps, speed, seeking and optimistic confirmed deletion. Desktop keeps its IPC adapter; no native/main-process behavior changed.
- Fast CI **ci: ok**; includes **397 desktop tests**, **27 meeting-ui tests**, **66 STT tests**. Web production build compiled successfully with TypeScript complete; desktop production build **built in 810ms** (existing chunk-size warning).
- Extended recording E2E **2 passed (43.9s)**: fake mic/mock STT + cookie sync, pause/resume, two finalized OPFS parts, player survives reload, `currentTime` advances, transcript click seeks, multipart end/restart plays, confirmed local deletion removes player across reload while preserving transcript. A test race was fixed by awaiting the native play event before waiting for end. Dev server printed `write EPIPE` during this run; test exit was 0 and the browser console guard passed.
- Inspected `/home/ubuntu/web-rec-light.png`, `/home/ubuntu/web-play-light.png`, `/home/ubuntu/web-play-dark.png`. Dark capture uses the app's persisted `oat-theme` preference and reload, not a manual CSS-class toggle; text/player contrast is correct. Mock post-meeting enhancement output may appear in the note body.
- Check logs: `/home/ubuntu/oat-web-recording-b-{ci,web-build,desktop-build,e2e}.log`. Real dual-source/tab playback, OS permission UI, quota exhaustion in a real browser and real Deepgram remain unverified; fake-store and capture-unit coverage exercise degradation.

## Header/player polish

PR 11 round 2: stale meeting restart restores account-scoped archive metadata, appends after the highest part number and resumes its logical clock after the greater of archive duration/part ends and the server's maximum segment end. The recording metadata read includes the latter without truncating at the reader's 5000-line limit. Covered by archive preservation, stale capture offset and meeting API integration assertions.

Round 2 pending-sync recovery: end-session retains failed writes plus the ended marker in a user-keyed localStorage outbox before clearing memory, including identity-change teardown without sending under the new account. Shell session initialization retries only its account's outbox; partial/failed acknowledgements remain durable. Unique batch keys avoid overwriting another tab's pending data. Storage failure leaves the in-memory queue intact instead of silently clearing it. Covered by sign-out failure/reload recovery, cross-account isolation and partial/offline/corrupt outbox tests.

Round 2 final utterance: session teardown stops capture immediately, finalizes the archive, awaits bounded STT finish, then flushes/persists the late finals and end marker before explicitly closing streams. The session regression emits a final utterance only during finish and verifies it reaches sync (or the offline outbox) before closure.

Round 2 STT drain: a finishing socket can close successfully only after all queued audio and CloseStream were sent with no remaining socket backpressure. A premature close reconnects with a fresh grant and replays the uncommitted frames under the original 15-second finish deadline. Regression verifies a backpressured close, reconnection, final transcript and completion; offline/backpressure deadline cases assert the explicit timeout error.

Round 2 verification: confirmed HEAD descended from `6d92525` before edits. Final fast CI **ci: ok** (26.4s), recording E2E **2 passed (42.1s)** and meeting API integration **6 passed** (2.47s). Logs: `/home/ubuntu/oat-pr11-round2-{ci,e2e,meeting-int}.log`. Verification completed the Storage test fake's missing clear method and checks finish → push → close ordering. Diff review also guarded archive finalization when a restart is cancelled before any new recorder exists, so restored part ends cannot shrink. No screenshot requested; behavior-only changes remain visually unverified.

Recovery review at `7e529ac`: confirmed HEAD exactly matched. Outbox retries now reject if any persisted batch remains pending after its flush, while still trying other batches and retaining their unacknowledged entries. Session recovery surfaces a separate account-scoped error through the existing amber sync-warning style at shell level, including when no recording document is selected. Retry resends the current user's saved batches and clears the warning on success. Normal live-queue updates cannot erase recovery failures. Automatic attempts are deduplicated per identity initialization; a browser regression caught and removed auth-refresh retries racing manual Retry. Unit tests cover partial acknowledgements, transport failure, persistence and warning/retry state; the new recovery E2E verifies a rejected push, a visible warning, preserved storage and successful UI Retry. Fast CI **ci: ok** (27.8s); recording + recovery E2Es **3 passed (42.1s)**. Logs: `/home/ubuntu/oat-pr11-recovery-{ci,e2e}.log`. Visually unverified; no screenshot requested.

PR 11 CI loop: Linux job 136177335741 failed in pipeline.spec.ts at `getByTestId('notion-link')` with `Error: element(s) not found`; the test did not open the new overflow. Updated its selector sequence. The same run passed History and assistant on retry. History also had a reachable loading race: switching the secondary-actions tree from a NotionExportButton-rooted popover to a MoreActions-rooted popover unmounted an already-open menu when versions arrived. Keep a single NotionExportButton-rooted tree, with a fallback for non-Notion actions, and force the delayed-versions case in the existing E2E.

Final local gates: `pnpm run ci --fast` **ci: ok** (30.4s); recording + enhancement history + pipeline + Notion E2Es **5 passed (1.2m)**, including the delayed-History regression. Evidence logs: `/home/ubuntu/oat-pr11-final-{ci,e2e}.log`. No visual capture requested for these behavior/security fixes; UI remains visually unverified in this review pass. Remote check evidence is saved separately at `/home/ubuntu/oat-pr11-ci-status.md` after the combined push.

PR 11 concurrency review: each recording holds an ifAvailable Web Lock keyed by its meeting id through stop/finalization, failure and session cleanup. A brand-new meeting also holds a document-id alias until stop, covering the race before its generated meeting id reaches other tabs. Refetched recent live metadata uses the shared six-hour meeting heuristic to reject another-device capture. Added occupied-lock and recent-device rejection, stale-meeting acceptance, new-meeting dual-lock coverage and held-until-teardown checks. Recording E2E verifies two held keys for a new note and a real second-tab rejection while the first continues.

PR 11 local review gates: `pnpm run ci --fast` **ci: ok** (26.6s); browser recording E2E **2 passed** after correcting the warning selector to account for its nested Retry button and the Next route announcer's separate alert role. Logs: `/home/ubuntu/oat-pr11-review-{ci,e2e}.log`. Initial validation also corrected the session Atom subscription and the Web Locks generic. No new screenshot/visual review was requested. CI loop continues separately; its initial Linux failure is the pipeline E2E's Notion selector, now hidden in overflow.

PR 11 playback review: shared availability resolution is used by desktop and browser adapters before selecting URLs. A missing preferred source falls back to an existing source without calling the preference setter. Desktop hook regressions cover both single-source directions and restoring the original preference on a dual-source recording.

PR 11 STT review: replay filtering and timeline frame ends share integer-microsecond rounding. Finish has a single 15-second deadline across reconnects/backpressure and resolves on server close even with unacknowledged frames. Added fractional-ms trim/reconnect, residual-frame close, offline and backpressure deadline regressions.

PR 11 session review: sign-out awaits capture teardown and a bounded best-effort flush before removing cookies. Shell disposal also flushes; session identity changes discard pending account-owned writes instead of retrying under a different account. All three stop tracks/sockets immediately, finalize local audio and clear timers. Pending permission grants are cancelled logically and released when they arrive. Added teardown and late-permission tests. The shell subscribes to the existing vanilla auth-client session Atom, not a React auth hook.

PR 11 security review: audio stores now use an immutable signed-in account id and `oat-audio/<userId>/<meetingId>` paths. Playback hides prior-account state immediately, revokes old URLs on account changes, and ignores legacy unscoped data. Added same-meeting-id cross-account load/read/delete isolation coverage. Final review validation is recorded below after all five fixes.

- Fetched and compared `origin/main`: its document action container also uses `flex-wrap`, and its History button stays inline even in compact mode. This is a source comparison, not a separately rendered baseline.
- Primary actions no longer wrap within their row. History and Notion are always in the existing More actions popover, alongside local audio deletion; Enhance/Regenerate and Share stay visible. Pipeline status stays mounted with the header metadata, outside the primary action row. History dialogs remain mounted outside the popover. History/Notion E2E selectors now open the overflow before using those controls.
- Shared PlaybackBar shows Me/Them/Both only if the recording's parts contain both sources, including when sources occur in different parts. Empty, mic-only and system-only recordings have no toggle. Regression coverage also checks source/speed callbacks; desktop gets the same shared behavior without adapter changes.
- `pnpm run ci --fast`: **ci: ok**. Recording + meeting + affected History/Notion E2Es: **7 passed (1.2m)**. A focused recording rerun exercises the explicit Regenerate state, checks overflow discoverability and one-row geometry, and regenerates `/home/ubuntu/web-play-light.png`. Screenshot inspected for row alignment and absent mic-only toggle. Logs: `/home/ubuntu/oat-recording-polish-{ci,e2e,recording-e2e}.log`.
- Initial typecheck caught an unsupported Testing Library `exact` option in the new unit test; removed it. Screenshot verification waits for popover dismissal to avoid capturing its exit transition. The dev-server stream/EPIPE messages also seen before this polish still appear, with E2E exit 0 and clean browser console guards.
