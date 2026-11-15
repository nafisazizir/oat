# Oat — Plan & Task Board

Rules: tasks are picked top-down when deps are done (see `FACTORY.md` §2). Each task gets a file in
`docs/tasks/` when started. Tick `[x]` only after verification evidence is recorded. 🧑 = needs a human
checkpoint at some point in the task. Dev is containerised and offline (D-11): a 🧑 on a task now means only
the *real-device / real-credential* step is human; the agent builds and verifies everything else against
mocks and marks the task `[x] (🧑 pending: …)`, logging the remaining human step in `LOG.md`.

**Autonomous-run target:** every task without an unavoidable human step is `[x]`, and 9.4 (E2E acceptance
script) passes against the compose stack. 9.1, 9.5, 9.6 and the real-device parts of 2.3/7.1 stay with the human.

## M0 — Research (Granola architecture)
Exit: `research/granola/ARCHITECTURE.md` explains capture, transcription, storage/sync, enhancement,
detection and calendar, each with evidence.
- [x] 0.1 Health-check REA MCP (already connected to Claude Code) · deps: —
- [x] 0.2 Electron bundle map: process layout, IPC surface, renderer framework, editor library · deps: 0.1
- [x] 0.3 Audio path: `screen_capture.node`, `opusscript`, `granola-diarizer` — what captures, encodes, diarizes; which STT provider/protocol · deps: 0.1
- [x] 0.4 Detection: `ax_meeting_detector`, `macos_mic_apps_with_devices`, `eventkit`, `meet-consent-host` · deps: 0.1
- [x] 0.5 Local storage + sync: SQLite schema (structure only), cache, sync model · deps: 0.1
- [x] 0.6 Enhancement & chat flow (client side: what is sent, when, streaming shape — not their prompts) · deps: 0.2
- [x] 0.7 Write `ARCHITECTURE.md` synthesis + "what we do differently" section · deps: 0.2–0.6

## M1 — Foundations
Exit: monorepo builds, `pnpm run ci` green, `pnpm dev:up && pnpm dev` runs the web app against the compose stack
with sign-in working (magic link via Mailpit, Google via mock OAuth).
- [x] 1.1 `git init`, pnpm + Turborepo skeleton matching SPEC §5 layout, TS/ESLint/Prettier/Vitest config · deps: —
- [x] 1.2 CI: `pnpm run ci` (typecheck, lint, test, test:int with compose) + equivalent GitHub Actions workflow file (no remote yet, D-12) · deps: 1.1, 1.10
- [x] 1.3 `packages/ui`: shadcn init, token file (colour, type, radius, spacing, motion), light/dark, base components · deps: 1.1
- [x] 1.4 `apps/web`: Next.js App Router shell, app layout (sidebar, workspace switcher, content) · deps: 1.3
- [x] 1.10 Dev environment (D-11): `docker-compose.yml` (postgres+pgvector, redis, mailpit, mock-oauth2, mocks), `tools/mocks` skeleton with health route, `pnpm dev:up/down/reset/logs`, `.env.example` defaults, `docs/DEV.md` (new machine in 3 commands), per-run test DB helper · deps: 1.1
- [x] 1.5 `packages/db` Drizzle schema (SPEC §6) + migrations + seed, against compose Postgres (Neon is prod-only, 9.6) · deps: 1.1, 1.10
- [x] 1.6 Better Auth: magic link (SMTP → Mailpit in dev) + Google (mock OAuth in dev), organization plugin → workspaces; personal workspace on sign-up · deps: 1.5, 1.4
- [x] 1.7 `packages/core/permissions.ts` + tests (owner/workspace/link/deny cases) · deps: 1.5
- [x] 1.8 `apps/desktop`: electron-vite shell, one renderer bundle with route-per-window, typed preload bridge (invoke/send/subscribe) from a contract in `packages/core`, sender-origin check on every handler, hardened fuses, small main-owned sequenced store for cross-window live state; renderer uses `packages/ui`; deep-link auth (`oat://`), token in Keychain (safeStorage) · deps: 1.4, 1.6
- [x] 1.9 `apps/web` Dockerfile + compose profile `app` (web runs fully in containers); Vercel link moved to 9.6 · deps: 1.4, 1.10

## M2 — Capture & live transcript (biggest risk — de-risk early)
Exit: start recording in the desktop app → live two-source transcript appears → segments persisted.
- [x] 2.1 `AudioSource` interface + `FileSource` + two-channel WAV fixtures · deps: 1.1
- [x] 2.2 `packages/stt`: `SttProvider` interface, `FakeSttProvider`, Deepgram streaming adapter (reconnect, buffering) + Deepgram-compatible mock WS in `tools/mocks` · deps: 2.1, 1.10
- [x] 2.3 🧑 (pending: real-device capture test) `native/oat-audio` Swift sidecar: mic (AVAudioEngine) + system audio (Core Audio process tap), framed PCM over stdout, permission handling; agent verifies `swift build` + `swift test` + a `--synthetic` mode (tone generator, no permissions); real capture is the human step · deps: —
- [x] 2.4 `SidecarSource` in desktop main; recording state machine (idle/recording/paused/error) · deps: 2.1, 2.3
- [x] 2.5 Transcript panel UI (live interim + final segments, me/them labels, autoscroll) · deps: 1.8, 2.2
- [ ] 2.6 Persist segments: desktop SQLite (disposable cache, D-19) + trigger-driven outbox → API → Postgres; stable client segment ids, finals only · deps: 1.5, 2.4
- [ ] 2.7 Resilience: STT down → buffer + replay; sleep/wake; app quit mid-recording · deps: 2.6
- [ ] 2.9 Archive backfill: after an STT outage longer than the replay buffer, re-transcribe the gap from the local Opus archive and merge as finals (D-17) · deps: 2.7, 2.8
- [x] 2.8 Local audio archive: incremental Ogg Opus writer per source, `audio_recording` table, partial-file recovery on crash, tests with `FileSource` fixtures · deps: 2.4

## M3 — Notes & editor
Exit: create/edit pages and meeting notes on desktop and web; content syncs; Markdown export works.
- [x] 3.1 `packages/editor`: TipTap setup, block set from SPEC §4, slash menu, Markdown shortcuts · deps: 1.3
- [x] 3.2 JSON ↔ Markdown conversion with round-trip tests · deps: 3.1
- [x] 3.3 Documents CRUD API + folders + sidebar tree · deps: 1.7, 3.1
- [ ] 3.4 Meeting note view: editor + collapsible transcript panel + meeting header (time, attendees) · deps: 2.5, 3.3
- [ ] 3.5 Desktop sync per D-19: outbox push w/ version acks, cursor pull, 409 → conflicted copy / full resync, SSE invalidation channel + poll backstop, offline property tests · deps: 2.6, 3.3
- [x] 3.6 Full-text search: Postgres FTS (web/API) + desktop-local SQLite FTS5 (trigram) over notes and segments · deps: 3.3
- [ ] 3.7 Audio playback in meeting view: player (mic/system/mixed), click segment → seek, highlight segment while playing; "audio on another device" state · deps: 2.8, 3.4
- [ ] 3.8 Storage settings: retention policy (forever / N days / max GB), per-meeting delete, disk usage, show in Finder · deps: 2.8

## M4 — Enhance
Exit: after a meeting, one click (or auto) produces structured notes from notes + transcript + template; evals pass.
- [x] 4.1 `packages/ai` foundation: AI SDK provider factory (AI Gateway when key set, else OpenAI-compatible `tools/mocks` LLM + embeddings), model registry, in-process mock model for unit tests · deps: 1.1, 1.10
- [x] 4.2 Eval harness + 5 fixture meetings (synthetic, written by us); structural tier always, quality tier only with a real key (D-13) · deps: 4.1
- [x] 4.3 Templates (D-20): title/description/ordered sections {heading, instructions}, 5 built-ins, custom template editor, `buildMeetingContext()` · deps: 3.3, 4.1
- [x] 4.4 Enhance pipeline (D-20): server job w/ status + idempotency key + resumable stream, structured output → TipTap JSON with `origin` attrs, raw notes kept, streaming into the editor, client re-attach after crash · deps: 3.2, 4.3
- [ ] 4.5 Regenerate / switch template / undo + restore earlier versions / show original notes; warn when body differs from last output · deps: 4.4
- [ ] 4.6 "About me" profile used as context · deps: 4.4

## M5 — Workspaces & sharing
Exit: invite a teammate, share a note to the workspace or via link, permissions enforced everywhere.
- [x] 5.1 Team workspace creation, switcher, settings · deps: 1.6
- [x] 5.2 Invites (email via SMTP → Mailpit in dev) + roles + member management · deps: 5.1
- [x] 5.3 Document visibility (private/workspace/link) + share dialog · deps: 1.7, 3.3
- [x] 5.4 Public read-only web viewer for link shares · deps: 5.3
- [x] 5.5 Authz audit: every API route covered by permission tests · deps: 5.3

## M6 — Assistant
Exit: chat with one note and across the workspace, answers cite segments/blocks, tools work.
- [x] 6.1 Chunking + embeddings (pgvector), backfill + incremental indexing (Redis-backed job queue) · deps: 3.3, 4.1
- [x] 6.2 Tools: `searchMeetings`, `getDocument`, `getTranscript`, `listMeetings(filter)` returning segment ids + `start_ms` + block ids; `updateDocument` as find/replace → minimal block diff with pending/approved/denied state · deps: 6.1
- [ ] 6.3 Chat API (AI SDK tool loop, streaming) + threads persistence with typed `context_json` per message · deps: 6.2
- [ ] 6.4 Chat UI: note-scoped side panel + global assistant view, citations jump to transcript time · deps: 6.3
- [ ] 6.5 Assistant evals (grounding/citation accuracy) · deps: 4.2, 6.3

## M7 — Calendar & detection
Exit: upcoming meetings visible; joining a call prompts to start notes; attendees auto-attached.
- [x] 7.1 🧑 (pending: real Calendars permission test) EventKit calendar access (sidecar `calendar status/request-access/events/watch`, store-changed driven, −24 h…+14 d) behind a `CalendarSource` interface + normalised `CalendarEvent` shared with Google (7.4), fixture source; upcoming list; real EventKit permission is the human step · deps: 2.3
- [x] 7.2 🧑 (pending: real mic-apps run) Meeting detection per D-21: sidecar `mic-apps watch`, pure rule functions w/ fixture tests, notification · deps: 7.1
- [ ] 7.3 Auto-create meeting note from event, attendees as participants · deps: 3.4, 7.1
- [ ] 7.5 Auto-stop (3-min floor; mic app gone + event end ±5 min, else ask) and auto-enhance (no output yet + min transcript length, grace delay cancelled by resume) · deps: 4.4, 7.2
- [x] 7.4 Google Calendar OAuth + events API (mock OAuth + Google Calendar subset in `tools/mocks` for dev) · deps: 1.6

## M8 — Integrations & background agents
Exit: Notion sync works; a post-meeting pipeline runs durably after each meeting.
- [x] 8.1 Notion integration: connect, choose target database, push/update note (Notion API subset in `tools/mocks` for dev) · deps: 3.2
- [ ] 8.2 eve evaluation: read bundled docs, spike a post-meeting agent, decide in `DECISIONS.md` · deps: 6.2
- [ ] 8.3 Post-meeting pipeline: enhance → action items → push to integrations (eve or AI SDK + Workflow) · deps: 8.1, 8.2
- [ ] 8.4 Action items extraction + checklist block + "my tasks" view · deps: 4.4

## M9 — Ship v1
Exit: SPEC §9 met.
- [ ] 9.1 🧑 Code signing, notarization, auto-update (electron-updater) · deps: M2
- [ ] 9.2 Onboarding: permissions walkthrough, first meeting guide · deps: M7
- [ ] 9.3 Design pass: tokens tuned, empty/loading/error states everywhere · deps: M6
- [ ] 9.4 End-to-end acceptance script against the compose stack: sign up → record fixture meeting (FileSource) → enhance → share → chat → Notion (mock) · deps: M8
- [ ] 9.6 🧑 Production infra: Neon, Vercel link + preview/prod deploys, real keys (Deepgram, AI Gateway, Google OAuth, Notion, email provider) · deps: 9.4
- [ ] 9.5 🧑 Production deploy + one week of real use + human sign-off · deps: 9.6
