# Web recording (D-32)

Status: step A complete · step B pending · human-approved.
Branch: `devin/1795160469-web-recording` (fresh origin/main).

## Step A acceptance

- Browser-safe STT entry; fresh token per connect, bearer subprotocol, shared parser/query parameters, reconnect/backoff with in-memory PCM replay. Fake-WebSocket unit coverage.
- Mic plus optional shared tab audio; AudioWorklet downmix/resample to 16kHz Int16 mono on the meeting clock. Pause/resume, tab-ended notice, beforeunload warning and complete resource cleanup.
- Cookie-authenticated same-origin sync pushes: meeting start/end, batched final segments and retractions; failed pushes retained/retried with visible state. Device name Browser.
- Editable web meeting notes offer a small Record/source popover, recording elapsed/pause/stop/live state, optimistic transcript and inline retryable errors. Hide unsupported/unauthorized/already-ended-transcript recording.
- Unit coverage for conversion, reconnect buffer and push queue. Compose-backed Chromium fake-mic E2E proves live text → stop → reload persistence.
- Run `pnpm run ci --fast`, `pnpm --filter @oat/web build`, new E2E; inspect `/home/ubuntu/web-rec-light.png`. Commit/push, no PR.

## Design

Record controls sit at the note header's right edge; use ziiz Button/Popover/Alert and existing TranscriptList.
Capture → per-source PCM worklet → browser STT → optimistic segments + final-only sync queue.
Step A buffers in memory only; local OPFS archive/playback is explicitly step B. No audio goes to application storage servers; only live STT receives PCM for transcription.

## Evidence

- Browser entry `@oat/stt/browser` uses the browser WebSocket and pure shared URL/parser/timeline/emitter modules, not the Node adapter or `ws`. Unacknowledged frames survive reconnects; replay is paced under socket backpressure. Finalization waits for final results and retries interruptions.
- Capture and retrying sync are owned by a browser singleton. Client-side navigation keeps recording and exposes a shell banner with controls/link back; full unload warns while recording or writes remain queued. Meeting metadata reads include calendar linkage on demand, preserving it on upsert. Stop timestamps capture end rather than STT reconnect completion.
- `pnpm run ci --fast`: **ci: ok** (31.1s): format, actionlint, typecheck, lint and tests passed. Includes **11 new unit tests**: browser STT 4, conversion/queue 4, capture failures/cleanup 3.
- `pnpm --filter @oat/web build`: **Compiled successfully in 1031ms**, **Finished TypeScript in 3.8s**.
- `E2E_PORT=3137 E2E_RECORDING_SCREENSHOT=/home/ubuntu/web-rec-light.png pnpm --filter @oat/web exec playwright test e2e/recording.spec.ts`: **2 passed (45.0s)**, including auth setup. Uses compose mock STT and Chromium fake-file mic capture. Proves live transcript, pause/resume, navigation continuity, cookie/Origin-authenticated pushes without bearer headers, stop, reload persistence and hiding Record on the finished transcript.
- Existing changed meeting-header E2E also passed: focused meeting-header + recording run **3 passed (52.4s)** (including setup).
- Inspected `/home/ubuntu/web-rec-light.png`: right-aligned header controls, live indicator/elapsed, visible sync state and optimistic transcript align with ziiz light surfaces.
- Logs: `/home/ubuntu/oat-web-recording-{ci,build,e2e}.log`. Initial E2E assertion used Playwright's abbreviated request headers; fixed to `allHeaders()` before asserting Origin/cookies. A formatting-only CI failure was corrected; final gates above are green.

## Remaining / deliberate boundaries

- Step B is not implemented: no OPFS archive, media playback or audio storage/upload endpoint. Step A PCM and unsynced writes remain volatile memory; forced unload loses them despite the warning.
- No existing web STT availability flag was found; API capability/edit/ended-transcript checks gate Record. Existing server token configuration selects mock/real provider.
- Native shared-tab permission UI/audio and tab-track-ended behavior are implemented but not exercised against a real tab. Fake-mic Chromium/mocks are the browser integration evidence; real Deepgram and other browsers were not contacted/tested.
