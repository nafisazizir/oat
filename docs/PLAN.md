# Oat — Plan & Task Board

- [x] Human-requested dev-only sidebar lab · Selected B; now compares B1–B4 chat actions and utility placements, retaining local collapsible groups. Focused typecheck/lint and Chromium interactions pass; inspected 1280×800 b1..b4.png at /home/ubuntu/sidebar-lab-shots/. Dev server port 3000; real navigation untouched. Earlier A/B/C/D evidence retained. [task](tasks/sidebar-lab.md)

- [x] Human-requested PR #31 Graphite visual round 3c · Implemented; 62 AFTER app PNGs/19 comparison sheets reviewed, conflict axe AA and link/greeting checks pass. Full E2E gate passes: web 91 passed/17 skipped, editor 16 passed/2 skipped. Final fast gate passes all five steps without scaling (24 cached test tasks). User accepted/authorized commit/push; publication follows closeout. Baseline/native limits retained. Evidence /home/ubuntu/oat-shots/ · [task](tasks/visual-hillclimb-3c-baseline.md)

- [x] Functional parity closeout: G1–G14/G16–G18 implemented; G15 explicitly deferred optional browser-device aggregate storage. Twelve requested desktop surfaces captured and inspected in light-mode 1440×900 built renderer with stubbed bridge (14 PNGs); fixed full-window recovery layout, fast CI passes. Evidence/tooling at /home/ubuntu/oat-parity-shots/, outside git. P1–P13 retained; real Electron/macOS/recording/provider consent unverified. Final feature-branch push authorized · [task](tasks/functional-parity.md)

- [ ] Human-requested shared feature UI, steps 1–6 search/tasks/assistant · PR #26/C2, URL-tab pagination and native document routing verified/pushed; shared block-link scroll/highlight verified on desktop route and web browser; fast static gates pass, all tests pass with CI timeout budget; PR gate after push; native Electron runtime pending · [task](tasks/desktop-feature-search.md)

- [x] Human-requested UI redesign PR 5: calm auth, setup and dialogs · [task](tasks/ui-calm-auth-dialogs.md)

Rules: tasks are picked top-down when deps are done (see `.agent/FACTORY.md` §2). Each task gets a file in
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
- [x] 2.6 Persist segments: desktop SQLite (disposable cache, D-19) + trigger-driven outbox → API → Postgres; stable client segment ids, finals only · deps: 1.5, 2.4
- [x] 2.7 Resilience: STT down → buffer + replay; sleep/wake; app quit mid-recording · deps: 2.6
- [x] 2.9 (combined with 2.7) Archive backfill: after an STT outage longer than the replay buffer, re-transcribe the gap from the local Opus archive and merge as finals (D-17) · deps: 2.7, 2.8
- [x] 2.8 Local audio archive: incremental Ogg Opus writer per source, `audio_recording` table, partial-file recovery on crash, tests with `FileSource` fixtures · deps: 2.4

## M3 — Notes & editor
Exit: create/edit pages and meeting notes on desktop and web; content syncs; Markdown export works.
- [x] 3.1 `packages/editor`: TipTap setup, block set from SPEC §4, slash menu, Markdown shortcuts · deps: 1.3
- [x] 3.2 JSON ↔ Markdown conversion with round-trip tests · deps: 3.1
- [x] 3.3 Documents CRUD API + folders + sidebar tree · deps: 1.7, 3.1
- [x] 3.4 Meeting note view: editor + collapsible transcript panel + meeting header (time, attendees) · deps: 2.5, 3.3
- [x] 3.5 (incl. from 2.6 review: lost-ack false-conflict fix via sent-content hash; subtree backfill when a client first sees a document it gained access to; from 1.5 re-review: statement/idle timeouts vs xmin stalls, deletes on access loss) Desktop sync per D-19: outbox push w/ version acks, cursor pull, 409 → conflicted copy / full resync, SSE invalidation channel + poll backstop, offline property tests · deps: 2.6, 3.3
- [x] 3.6 Full-text search: Postgres FTS (web/API) + desktop-local SQLite FTS5 (trigram) over notes and segments · deps: 3.3
- [x] 3.7 Audio playback in meeting view: player (mic/system/mixed), click segment → seek, highlight segment while playing; "audio on another device" state · deps: 2.8, 3.4
- [x] 3.8 Storage settings: retention policy (forever / N days / max GB), per-meeting delete, disk usage, show in Finder · deps: 2.8

- [x] 3.9 Desktop workspace switcher — record meetings into team workspaces (found by 9.4) · deps: 9.2, 5.1, 2.6

## M4 — Enhance
Exit: after a meeting, one click (or auto) produces structured notes from notes + transcript + template; evals pass.
- [x] 4.1 `packages/ai` foundation: AI SDK provider factory (AI Gateway when key set, else OpenAI-compatible `tools/mocks` LLM + embeddings), model registry, in-process mock model for unit tests · deps: 1.1, 1.10
- [x] 4.2 Eval harness + 5 fixture meetings (synthetic, written by us); structural tier always, quality tier only with a real key (D-13) · deps: 4.1
- [x] 4.3 Templates (D-20): title/description/ordered sections {heading, instructions}, 5 built-ins, custom template editor, `buildMeetingContext()` · deps: 3.3, 4.1
- [x] 4.4 Enhance pipeline (D-20): server job w/ status + idempotency key + resumable stream, structured output → TipTap JSON with `origin` attrs, raw notes kept, streaming into the editor, client re-attach after crash · deps: 3.2, 4.3
- [x] 4.5 Regenerate / switch template / undo + restore earlier versions / show original notes; warn when body differs from last output · deps: 4.4
- [x] 4.6 "About me" profile used as context · deps: 4.4

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
- [x] 6.3 Chat API (AI SDK tool loop, streaming) + threads persistence with typed `context_json` per message · deps: 6.2
- [x] 6.4 Chat UI: note-scoped side panel + global assistant view, citations jump to transcript time · deps: 6.3
- [x] 6.5 Assistant evals (grounding/citation accuracy) · deps: 4.2, 6.3

## M7 — Calendar & detection
Exit: upcoming meetings visible; joining a call prompts to start notes; attendees auto-attached.
- [x] 7.1 🧑 (pending: real Calendars permission test) EventKit calendar access (sidecar `calendar status/request-access/events/watch`, store-changed driven, −24 h…+14 d) behind a `CalendarSource` interface + normalised `CalendarEvent` shared with Google (7.4), fixture source; upcoming list; real EventKit permission is the human step · deps: 2.3
- [x] 7.2 🧑 (pending: real mic-apps run) Meeting detection per D-21: sidecar `mic-apps watch`, pure rule functions w/ fixture tests, notification · deps: 7.1
- [x] 7.3 Auto-create meeting note from event, attendees as participants · deps: 3.4, 7.1
- [x] 7.5 Auto-stop (3-min floor; mic app gone + event end ±5 min, else ask) and auto-enhance (no output yet + min transcript length, grace delay cancelled by resume) · deps: 4.4, 7.2
- [x] 7.4 Google Calendar OAuth + events API (mock OAuth + Google Calendar subset in `tools/mocks` for dev) · deps: 1.6

## M8 — Integrations & background agents
Exit: Notion sync works; a post-meeting pipeline runs durably after each meeting.
- [x] 8.1 Notion integration: connect, choose target database, push/update note (Notion API subset in `tools/mocks` for dev) · deps: 3.2
- [x] 8.2 eve evaluation: read bundled docs, spike a post-meeting agent, decide in `DECISIONS.md` · deps: 6.2
- [x] 8.3 Post-meeting pipeline: enhance → action items → push to integrations (eve or AI SDK + Workflow) · deps: 8.1, 8.2
- [x] 8.4 Action items extraction + checklist block + "my tasks" view · deps: 4.4

## M9 — Ship v1

- [x] Human-requested: post-PR #28 functional parity audit and Before matrix · [task](tasks/functional-parity.md)
- [x] Functional parity G2 + G5: shared typed-client join/bootstrap in both hosts and native desktop calendar settings; fast gates and Join e2e verified · [task](tasks/functional-parity.md)
- [x] Functional parity G3 + G14 + G13: shared authenticated invites/native handoff, shared host commands, route-backed search/task filters; unit/fast/API authz/invite and command browser checks verified (native OS dispatch/visuals unverified) · [task](tasks/functional-parity.md)
- [x] Functional parity G7 + G11: authorized server meeting read-through cache and repeated segment/time/block focus; desktop 571 tests/full fast gate pass. G2 Back readiness test fixed; five CPU-constrained parallel workspace suites pass (99 each). Native runtime/visuals unverified · [task](tasks/functional-parity.md)

- [x] Functional parity G8 + G18: shared document assistant/editor bridge on meetings and pages; native flush/sync and guarded local-writer approval; shared K/B/J guards. Unit/affected fast gates and assistant/document/palette browser checks pass; native runtime/visuals unverified · [task](tasks/functional-parity.md)
- [x] Functional parity G9 + G10 + G6: shared enhancement/history/restore/Undo, per-document Notion actions and page task-assignee slots; native flush/sync and guarded local-writer adoption. Unit/affected fast gate and enhance/history/Notion/tasks browser checks pass; native runtime/visuals unverified · [task](tasks/functional-parity.md)
- [x] Functional parity G17 + G16 + G4 + G12 + G1: shared renderer recovery/conflicts/Home/lifecycle actions, recording-safe route restore/history and invite queue integration. Unit/static/browser checks complete; native runtime/visuals unverified · [task](tasks/functional-parity.md)
- [x] Functional parity / PR #30 integration: merged latest main's shared shell, account menus, settings, composer and empty states while retaining functional routes/actions. Shared greeting uses first name or neutral fallback; proposal refresh waits for committed ready state. Forced uncached fast CI and requested smoke/search/assistant/workspaces/documents E2E pass; native runtime/visuals unverified · [task](tasks/functional-parity.md)

- [x] Human-requested Phase 3a final polish and gate: sidebar captions/account grouping, auth and empty-state
      consistency; full fast/E2E/axe gates, final screenshots and branch push. PR 30 follow-up restores
      macOS traffic-light clearance in expanded/collapsed sidebar headers · [task](tasks/phase3a-visual-round3.md)

- [x] Human-requested Phase 3a visual hill-climb round 2: aligned sidebar columns, quiet utility rows,
      grouped account menus, single desktop meeting header, flat Coming up, shared Home layout,
      tighter settings and inline assistant history; light/dark captures inspected, fast CI passes · [task](tasks/phase3a-visual-round2.md)

- [x] Human-requested Phase 3a visual hill-climb round 1: shared Graphite sidebar/chrome, assistant, metadata,
      settings and empty-state polish; rebuilt renderer, inspected light/dark captures, fast CI passes · [task](tasks/phase3a-visual-hillclimb.md)

- [x] Human-requested Graphite theme and shared control refresh for web and desktop · [task](tasks/graphite-ui-foundation.md)

- [ ] Human-requested: API foundation — REST parity, typed client and authenticated desktop text/JSON proxy implemented; independent review/verification pending (D-38) · deps: 5.1, 5.2, 7.4 · [task](tasks/api-foundation.md)
- [x] Human-requested: desktop workspace parity — steps 1–7 complete; PR #25/#27 follow-ups cover offline page drafts, live trash/restore, cached workspace switching/visibility and stale online-switch reconciliation. Fast CI passes; prior desktop/web evidence recorded, follow-up banner visually unverified and native macOS validation unrun · [task](tasks/desktop-workspace-parity.md)

- [x] Stale desktop e2e + acceptance specs updated for the calm shell; web typography/notion/auth spec races fixed · [task](tasks/e2e-calm-shell-specs.md)

- [x] Human-requested: one kind of workspace — drop personal, join by domain/policy, Private + Shared (D-36); steps A model, B joining, C sidebar + exit export · deps: 5.1, 5.3, 3.9 · [task](tasks/unified-workspaces.md)

- [x] Human-requested UI redesign PR 4: calm home and note surfaces · [task](tasks/ui-calm-note-surfaces.md)

- [x] Human-requested UI redesign PR 3: calm Account / Workspace settings · [task](tasks/ui-calm-settings.md)

- [ ] Shared native settings on web and desktop · [task](tasks/settings-parity.md)

- [x] Human-requested UI redesign PR 2: calm web/desktop shell · [task](tasks/ui-calm-shell.md)

- [x] Human-requested UI redesign PR 1: Geist Mono; headings stay Inter · [task](tasks/ui-type-geist-mono.md)

- [x] Human-requested: web recording, step A capture/STT/sync + step B OPFS archive/playback, header/source polish, PR 11 account/session isolation, stale-recording append, pending-sync recovery and STT finalization/reconnect reliability · authorized contrast/isolation and replay-test follow-ups pass local gates; remote CI watch pending · [task](tasks/web-recording.md)

- [x] Human-requested: unify desktop/web shell and note layout · [task](tasks/unify-shell.md)

- [x] Human-requested UI foundation: ziiz shared components and oat ramp, no app redesign · [task](tasks/ui-foundation.md)
- [x] Human-requested ziiz final pass, part 1: Home, Sonner and gallery · [task](tasks/ui-final-pass.md)
- [x] Human-requested ziiz final pass, part 2: remove bridge and Lucide; repo guards and visual/build checks · [task](tasks/ui-final-pass.md)
Exit: SPEC §9 met.
- [ ] 9.1 🧑 Code signing, notarization, auto-update (electron-updater) · deps: M2
- [x] 9.2 Onboarding: permissions walkthrough, first meeting guide · deps: M7
- [x] 9.3 (web; desktop = 9.3b) Design pass: tokens tuned, empty/loading/error states everywhere · deps: M6
- [x] 9.3b Desktop design pass (+ tickets from 9.3: editor checkbox target size, anchor 'Ask about this note' button, header overflow menu) · deps: 7.5, 2.7
- [x] 9.4 End-to-end acceptance script against the compose stack: sign up → record fixture meeting (FileSource) → enhance → share → chat → Notion (mock) · deps: M8
- [ ] 9.6 🧑 Production infra: Neon, Vercel link + preview/prod deploys, real keys (Deepgram, AI Gateway, Google OAuth, Notion, email provider) · deps: 9.4
- [ ] 9.5 🧑 Production deploy + one week of real use + human sign-off · deps: 9.6
