# Factory Log

Append-only. Newest at the bottom. Orchestrator writes one entry per state change.

## Waiting on human
- [ ] Hopper (used by REA) is stuck on a dialog since 13:32; REA `close_binary` returns cleanup_incomplete.
      Please dismiss/quit Hopper. Not blocking product work.
- [ ] **Sidecar real-capture test (2.3)** — needs you at the Mac, ~10 min. Steps in
      `native/oat-audio/README.md` + Design notes of `docs/tasks/2.3-oat-audio-sidecar.md`:
      `cd native/oat-audio && swift build -c release && .build/release/oat-audio capture --duration 15 | node scripts/check-frames.mjs`
      with a call/video playing on speakers; grant Microphone + System Audio Recording when prompted. Check:
      both sources present, speaker echo removed from mic (AEC), call audio not ducked, AirPods/Bluetooth
      rate switch (`format_changed` event) handled. NOTE: since 7.1 the binary embeds an Info.plist (mic,
      system-audio, calendar usage strings) — run this capture test on a build that includes 7.1.
- [ ] **Calendar access test (7.1)** — `cd native/oat-audio && .build/release/oat-audio calendar request-access`
      (grant), then `calendar status`, `calendar events --from <today> --to <+7d>` and `calendar watch`
      (edit an event in Calendar.app → a `changed` line appears). Steps in `docs/tasks/7.1-calendar.md`.
- [ ] **Mic-apps detection test (7.2)** — first real `oat-audio mic-apps watch` (README "Mic apps"): join a Zoom/
      Meet/Teams call and confirm the app appears/disappears and no permission prompt is shown; note any
      unrecognised bundle ids.
- [ ] **Try the whole app end to end (dev stack, ~20 min)** — `pnpm i && pnpm dev:up && pnpm dev`, open
      http://localhost:3000 (sign in via Mailpit http://localhost:18025) and the desktop app; record a real call
      (needs the permission tests above), enhance, chat, share. Mock AI/STT output is placeholder text by design
      (D-13) until real keys are set (9.6). Report anything odd as a LOG entry or IDEAS item.
- [ ] **Decisions to confirm (agent-made, reversible)**: D-18 (private folders/no cross-workspace moves), D-23
      (origin rule), D-24 (multi-part audio), D-26 (enhance), D-27 (assistant history after access loss),
      D-28/D-30 (local store, per-account audio), D-29 (eve for durable pipelines, rc pinned), D-31 (calendar
      event keys). All in `docs/DECISIONS.md`; tell the factory if any should change.
- [ ] **9.6 Production infra + real keys** (human checkpoint): Neon Postgres, Vercel project link + deploys,
      AI Gateway key (`AI_GATEWAY_API_KEY`), Deepgram (`DEEPGRAM_API_KEY`), Google OAuth client (sign-in +
      calendar), Notion OAuth app, email provider (SMTP/Resend), Redis (Upstash), BETTER_AUTH_SECRET(S),
      service token for agents; eve prod world (D-29 says deferred — decide Vercel Workflow vs worker fallback).
      Then run the real-model eval quality tier (`pnpm --filter @oat/ai eval -- --model real`) to set baselines.
- [ ] **9.1 Signing/notarization/auto-update** (Apple Developer account needed): bundle `oat-audio` with
      entitlements (audio-input, calendars), declare `oat://` scheme, ship THIRD_PARTY_NOTICES.md, bake prod URL.
- [ ] **9.5 One week of real use + sign-off.**

## Entries
- 2026-11-14 · setup · Docs written: CLAUDE.md, SPEC, PLAN, FACTORY, IDEAS, DECISIONS. Initial Granola
  recon (bundle listing + package.json) in `research/granola/FINDINGS.md`. Next: M0 (needs 0.1) and M1.1 in parallel.
- 2026-11-14 · decision · D-10: audio kept in local archive (never synced). Added PLAN 2.8, 3.7, 3.8; SPEC updated.
- 2026-11-14 · decision · Human answered pre-run questions: local git only (D-12), M0 research approved,
  defaults accepted (D-7/8/9 accepted, D-14), mocks-only dev AI (D-13). Containerised offline dev adopted (D-11).
  PLAN updated: new 1.10 dev env, 🧑 reduced to real-credential/real-device steps, prod infra moved to 9.6.
  FACTORY §9 standard briefs added. Starting autonomous orchestrator run.
- 2026-11-14 · ops · Mac slept mid-run (two researchers died, reviewer stalled ~3h). `caffeinate -dims` now
  holds idle sleep for the run; lid-close sleep on battery can still interrupt — keep the lid open / on power.
- 2026-11-14 · 1.1 · implemented + verified by orchestrator (all gates green on clean install); review =
  changes (vitest .tsx globs, turbo strict-env passThroughEnv) → back to implementer.
- 2026-11-14 · 1.1 · shipped: monorepo skeleton (pnpm catalog, turbo, TS-source packages D-15) squash-merged to main.
- 2026-11-14 · 0.1/0.2 · done: REA healthy; bundle map in research/granola/bundle-map.md (one renderer w/ hash routes, 14 utility processes around native addons, typed preload bridge w/ sender checks, TipTap+Yjs renderer).
- 2026-11-14 · 0.3 · done: audio-path.md (Chromium capture in renderer, 16 kHz PCM 100 ms blocks, Deepgram WS per source w/ short-lived tokens, 120 s replay buffer, no audio stored). → D-17; 2.3 gets AEC requirement.
- 2026-11-14 · 0.5 · done: storage-sync.md (SQLCipher DB in worker, 5 sync mechanisms: LWW doc rows, change-log, trigger-driven outbox w/ versioned acks, append-only transcript chunks, Yjs bodies; WS = invalidation only). Note: researcher ran bundled migration DDL on an empty in-memory SQLite to derive schema — no user data/network; acceptable but at the edge of 'static only'. Adopt trigger-driven outbox for 2.6/3.5.
- 2026-11-14 · 0.4 · done: detection.md (primary trigger = known meeting app holding mic input via Core Audio process list @1 Hz; calendar only names the meeting; EventKit change-notification driven; auto-stop heuristics). Feeds 7.1/7.2. REA/Hopper session still stuck (human).
- 2026-11-14 · 0.6 · done: enhance-chat.md (server-held prompts w/ variable bags; enhance = idempotent server job + resumable SSE into a separate AI panel; mine-vs-AI by text matching; citations per line, no timestamp jump). Oat: origin attr in TipTap JSON, resumable job, keep original for undo, segment-exact citations.
- 2026-11-14 · 0.7 · M0 complete: research/granola/ARCHITECTURE.md. Adopted its suggestions as D-19 (sync), D-20 (enhancement model), D-21 (detection), D-18 (folders, from 1.7 review); PLAN updated (1.8, 2.6, 2.9 new, 3.5, 3.6, 4.3–4.5, 6.2, 6.3, 7.1, 7.2, 7.5 new); SPEC §5–7 updated.
- 2026-11-14 · 1.10 · shipped: containerised dev env (compose, mocks, testkit, DEV.md) (squash-merged).
- 2026-11-14 · 1.3 · shipped: UI tokens/theme/components/gallery (squash-merged; catalog conflict resolved).
- 2026-11-14 · 1.7 · shipped: core domain types + permissions (D-18) (squash-merged).
- 2026-11-14 · 2.3 · shipped: oat-audio Swift sidecar (synthetic-verified; real capture = human checkpoint) (squash-merged).
- 2026-11-14 · 2.1 · shipped: AudioSource + FileSource + say-generated fixtures (squash-merged).
- 2026-11-14 · 4.1 · shipped: packages/ai provider factory + mock LLM/embeddings (squash-merged).
- 2026-11-14 · 4.1 · post-merge: pnpm dev:build from main; @oat/ai test:int 11/11 passed (container acceptance test no longer skipped). Shared stack now serves /llm.
- 2026-11-14 · 1.5 · shipped: Drizzle schema, migrations, triggers (D-22), seed (squash-merged).
- 2026-11-14 · 1.5 · note for 3.5 (from re-review): a long/idle transaction stalls all pulls (xmin) — add statement/idle timeouts + monitoring; pulls must apply read permissions and emit deletes on access loss; joining a workspace needs a full fetch.
- 2026-11-14 · 1.4 · shipped: Next.js web shell + app layout (squash-merged).
- 2026-11-14 · 1.2 · shipped: pnpm run ci + GitHub Actions workflow (squash-merged).
- 2026-11-14 · 1.2 · post-merge: full `pnpm run ci` on main = ok in 41.7 s (format, actionlint, typecheck, lint, test, stack, migrate, test:int, web e2e, swift build/test/synthetic). This is now the gate.
- 2026-11-14 · 2.4 · shipped: SidecarSource + RecordingController (squash-merged).
- 2026-11-14 · 3.1 · shipped: TipTap block editor (@oat/editor) (squash-merged).
- 2026-11-14 · 2.2 · shipped: SttProvider, Fake, Deepgram adapter + Deepgram-compatible mock (squash-merged).
- 2026-11-14 · 4.2 · shipped: eval harness + 5 fixture meetings (squash-merged).
- 2026-11-14 · 1.9 · shipped: web Dockerfile + compose app profile (squash-merged).
- 2026-11-14 · 2.8 · shipped: local Ogg Opus audio archive (multi-part, crash recovery) (squash-merged).
- 2026-11-14 · 7.1 · shipped: calendar via sidecar EventKit + CalendarSource (fixture-verified) (squash-merged).
- 2026-11-14 · 3.2 · shipped: TipTap JSON <-> Markdown (injection-safe) (squash-merged).
- 2026-11-14 · 1.6 · shipped: Better Auth: magic link + Google (mock), workspaces, personal workspace (squash-merged).
- 2026-11-14 · 7.2 · shipped: meeting detection: sidecar mic-apps + pure rules (fixture-verified) (squash-merged).
- 2026-11-14 · 3.3 · shipped: documents & folders: API, live sidebar tree, document page w/ autosave (squash-merged).
- 2026-11-14 · 1.8 · shipped: Electron desktop shell, typed bridge, deep-link auth (squash-merged).
- 2026-11-14 · flake · @oat/audio opus-archive.test.ts:87 failed once under full-CI load (passes alone). Watch; investigate if it recurs.
- 2026-11-14 · 7.4 · shipped: Google Calendar: connect-only OAuth, gcal mock, normaliser parity, Upcoming on Home (squash-merged).
- 2026-11-14 · 5.1 · shipped: team workspaces: settings, members, roles, invites (+5.2) (squash-merged).
- 2026-11-14 · 4.3 · shipped: templates (5 built-ins), editor, buildMeetingContext (injection-hardened) (squash-merged).
- 2026-11-14 · flake · web e2e failed once on main right after 4.3 merge; immediate rerun 59/59 green. Likely load from parallel agent e2e runs. Watch.
- 2026-11-14 · 5.3 · shipped: document sharing + public read-only viewer (+5.4, route-coverage CI check) (squash-merged).
- 2026-11-14 · todo · 5.3: verify the share page CSP in a production build (next build && next start) in a browser — part of 9.3 design pass / 9.4.
- 2026-11-14 · 3.6 · shipped: full-text search (Postgres FTS, ⌘K + /search) (squash-merged).
- 2026-11-14 · 3.6 · search perf test is opt-in (`pnpm --filter @oat/db test:perf`) — run it in 9.3/9.4.
- 2026-11-14 · 6.1 · shipped: chunking + embeddings + change_log-driven indexing queue + searchChunks (squash-merged).
- 2026-11-14 · 5.5 · shipped: authz audit: every route/action/auth endpoint covered (squash-merged).
- 2026-11-14 · 2.5 · shipped: desktop recording + live transcript panel (real pipeline, FileSource in dev) (squash-merged).
- 2026-11-14 · flake · @oat/desktop e2e failed once after 2.5's main merge (not captured), then 3/3 green. Watch.
- 2026-11-14 · 8.1 · shipped: Notion integration: OAuth connect, target picker, send/update (mocked in dev) (squash-merged).
- 2026-11-14 · 4.4 · shipped: enhance pipeline: prompt, origin matching, resumable server job + SSE, editor streaming (squash-merged).
- 2026-11-14 · ops · e2e failures on main after 4.4 merge traced to CPU contention (load avg 35 on 14 cores; 5+ agents running full CI). documents.spec passes 8/8 alone. Orchestrator back to ≤3 concurrent implementers; ci-flakes task hardening timeouts/workers.
- 2026-11-14 · 6.2 · shipped: assistant tools + chat API (AI SDK tool loop, citations validated, proposals need approval) (+6.3) (squash-merged).
- 2026-11-14 · ci-flakes · done on `task/ci-flakes`: root causes = clicks before hydration, 5 s expect vs `next dev` compiles under load, sign-in URL race, archive queue < fixture in opus test. Desktop e2e 60/60 (10×), web 124/124 (3×), `pnpm run ci` 2/2 green under load. See docs/tasks/ci-flakes.md.
- 2026-11-14 · ci-flakes · shipped: CI reliability: hydration-gated clicks, load-scaled timeouts, desktop deep-link polling, opus queue (squash-merged).
- 2026-11-14 · 2.6 · shipped: desktop local store (node:sqlite) + outbox sync push/pull (D-19/D-28) (squash-merged).
- 2026-11-14 · 4.5 · shipped: regenerate, versions/restore/undo (snapshots — never lose text), About me profile (+4.6) (squash-merged).
- 2026-11-14 · 6.4 · shipped: chat UI: note side panel, /assistant, citation chips, proposal diff cards, deep-link reader (squash-merged).
- 2026-11-14 · 6.5 · shipped: assistant evals (21 chat fixtures: grounding, citations, abstention, injection, permissions) + speaker-label fix (squash-merged).
- 2026-11-14 · flake · one e2e failure on main after 6.5 merge (packages/ai-only change); next 2 runs green (web 53/53, desktop 7/7). Residual flake rate low; revisit in 9.4 if it recurs.
- 2026-11-14 · 8.4 · shipped: action items: taskItem owner/due, enhance mapping, action_item index, My tasks (squash-merged).
- 2026-11-15 · 3.5 · shipped: sync complete: lost-ack hashing + receipts, conflicted copies UX, SSE invalidation, backfill, xmin timeouts, desktop FTS5 (squash-merged).
- 2026-11-15 · 8.2 · shipped: eve evaluation + post-meeting spike (D-29) (squash-merged).
- 2026-11-15 · 3.4 · shipped: meeting note view (desktop live + web), shared packages/meeting-ui, participants API (squash-merged).
- 2026-11-15 · flake · assistant.spec sheet-Escape still fails occasionally in full runs (passes alone 6/6). Fold into 9.3 design pass: make Escape close the sheet even when a tooltip is open, or remove tooltips inside the sheet.
- 2026-11-15 · 3.8 · shipped: desktop storage settings: size, delete audio, Show in Finder, retention sweeper (D-30 per-account) (squash-merged).
- 2026-11-15 · flake-fix · root cause of recurring web e2e 429s: per-IP rate-limit counters (share page 120/min on 127.0.0.1) shared across parallel e2e servers via the one dev Redis. Added OAT_RATE_LIMIT_NAMESPACE (unique per e2e server).
- 2026-11-15 · 8.3 · shipped: post-meeting pipeline on eve (D-29): trigger, settings, run log, status/retry, @oat/services layering (squash-merged).
- 2026-11-15 · 3.7 · shipped: desktop audio playback synced to transcript (oat-audio:// WAV-on-the-fly, multi-part seek, highlight) (squash-merged).
- 2026-11-15 · 7.3 · shipped: calendar → meeting notes (desktop Upcoming, detection prompt wiring, web Start notes) + D-31 (squash-merged).
- 2026-11-15 · 9.3 · web design pass → review on `task/9.3-design-pass-web`: sweep + axe e2e, 22-item punch list in the task file; LOG earmarks done (sheet-Escape flake, share CSP in a prod build via `e2e:prod`, web Scheduled/Join line, search perf run). Tickets for 9.3b: editor task-checkbox target size, anchor the assistant button to the note column, doc header overflow menu; 9.4: search snippet list markers.
- 2026-11-15 · 9.3 · shipped: design pass (web + shared UI): 22-item punch list, axe-clean routes, Escape fix, prod CSP check (squash-merged).
- 2026-11-15 · 2.7 · shipped: recording resilience: startup crash recovery, STT gap detection, archive backfill via batch STT (+2.9) (squash-merged).
- 2026-11-15 · 7.5 · shipped: auto-stop (rules + undo + prompt) and auto-enhance grace period (squash-merged).
- 2026-11-15 · follow-up · 7.5: in back-to-back meetings in the same app, meeting B isn't prompted after A's note auto-stops (detection D-21 treats the app as already 'in a meeting'). Needs a small D-21 change; candidate for after human review.
- 2026-11-15 · 9.4 · shipped: end-to-end acceptance journey + fresh-clone proof + CI step (squash-merged).
- 2026-11-15 · 9.4 · AUTONOMOUS TARGET MET (pending 9.2/9.3b + 3.9): acceptance journey passes on the compose stack and from a fresh clone; see docs/tasks/9.4-acceptance.md.

## 2026-11-15 06:40 — orchestrator
- 9.2 + 9.3b implementer handed back (branch task/9.2-onboarding, ci ok; 16/19 punch-list items fixed, 2 deferred, 1 partial). Fresh reviewer spawned.
- 3.9 implementer started in parallel, branched from task/9.2-onboarding (will re-merge main once 9.2 lands).
- 2026-11-15 · 9.2 · shipped: desktop onboarding + 9.3b desktop design pass (squash-merged).
- 9.3b shipped with 9.2 (same squash 8f3c91b). Reviewer non-blocking notes (follow-ups, not blocking): calendar "Allow" while status "unknown" is a no-op; "Ask about this note" one-frame jump (useLayoutEffect); reopened Setup shows previous test-recording result; e2e permission guard in desktop index.ts lacks a unit test.
- Waiting on human (added): run the real macOS "Allow" prompts in onboarding on a packaged build (steps in docs/tasks/9.2-onboarding.md → Verification).
- 2026-11-15 06:35 · post-merge full `pnpm run ci` on main after 9.2/9.3b → ci: ok.
- 2026-11-15 · 3.9 · shipped: desktop workspace switcher — record meetings into team workspaces (squash-merged).

## 2026-11-15 07:26 — orchestrator: AUTONOMOUS RUN COMPLETE
- All agent-doable tasks in PLAN.md are done and merged to local `main` (last: 9.2+9.3b 8f3c91b, 3.9 1e10097). Final full `pnpm run ci` on main (82b216b) → **ci: ok** (format, lint, typecheck, unit, int, web+desktop e2e, v1 acceptance journey incl. team-workspace step, swift build/test/synthetic).
- Remaining unticked tasks are human-only: 9.1 (signing/notarization/auto-update), 9.6 (prod infra + real keys), 9.5 (prod deploy + a week of real use).
- Non-blocking review follow-ups were moved to docs/IDEAS.md ("Follow-ups from the autonomous run").
- Next for the human: see "Waiting on human" above (try the app end to end via docs/DEV.md; real-permission checks for sidecar/calendar/mic-apps/onboarding; confirm D-18..D-31; then 9.6 → 9.5).

## 2026-11-18 · human-requested · agent workflow generalised
- `docs/FACTORY.md` moved to `.agent/FACTORY.md` and made tool-agnostic (no Claude Code assumptions: §6 "running long sessions", §8 REA client, §9 briefs now generic). Reusable procedures extracted to `.agent/skills/` (`task-file`, `subagent-briefs`, `rea-research`) as SKILL.md files.
- New root `AGENTS.md` is the entry point for every agent tool (same content as the old `CLAUDE.md`, updated paths); `CLAUDE.md` is now a thin pointer holding only Claude Code specifics (`/loop`, `isolation: worktree`, REA `--client claude_code`). `apps/web/AGENTS.md` (Next.js-managed) unchanged.
- References updated: README, PLAN §rules, research/granola ARCHITECTURE + FINDINGS; `.agent/` added to .prettierignore and .dockerignore.
- 2026-11-18 · ci · GitHub Actions: first run on main failed (swift: setup-node pnpm cache without pnpm; checks: unit property-test timeout + backfill int tolerance on a 4-vCPU runner). Sped up: no Playwright `--with-deps` apt step (~9 min), turbo cache, caches saved on failure. PR run 2 flaked other timing tests (audio archive, post-meeting Workflow status race): vitest steps now cap turbo concurrency at cores/2, post-meeting test waits for the Workflow run to settle. Run 3: more 5 s unit timeouts, web e2e element waits, a Swift debounce test (macOS job ran tests for the first time): CI env scales vitest (x3) and Playwright (x2) timeouts; debounce delay widened.

## 2026-11-19 — human-requested ziiz foundation

- Replaced the shared UI component sources with the ziiz registry (all except chart and carousel), added Base UI, Tabler and registry dependencies, and installed ziiz 0.1.1 through the catalog.
- Imported the supplied oat palette after ziiz and before the shadcn slot bridge. Exposed the complete brand scale and retained compatibility aliases for existing app/editor consumers.
- Self-hosted UI and mono fonts; retained Newsreader for editor blockquotes. Current typography: D-33.
- Migrated render composition, menu groups and activation, Select label metadata, array-valued toggle groups and popup focus restoration without app redesign.
- Verification and screenshot evidence: docs/tasks/ui-foundation.md.
- Final fast CI green; web, desktop and gallery production builds pass. Light/dark gallery screenshots verified. Full integration tests pass; web E2E is blocked before app startup by the VM's missing pgvector extension. Editor E2E passes after installing the missing local Chromium binary; macOS-only checks are skipped on Linux.

### PR 3 CI remediation

- Fixed text contrast, Tabs activation, sidebar target size, Select indicator text, tooltip semantics, and Base UI-compatible E2E assertions. The human approved the light gray-900 AA deviation, preserving chroma and hue.
- Reproduced the DB pagination readiness race against main with held transactions and replaced its row-count wait with a specific-folder visibility wait. Main's green Linux log also contains the identical enhance heading failure marked flaky; warm the SSE route before generation instead of weakening the streaming assertions.
- UI tests, DB integration, both-theme axe and the targeted web browser suite pass locally with the repository environment loaded. Final enhance-only browser check passes (`4 passed (44.5s)`); PR CI remains in progress. Evidence and limitations are in `docs/tasks/ui-foundation.md`.
- Latest PR run after `4663a6b`: web 63 passed, editor 16 passed, DB integration 51 passed; Swift and review passed. Linux fails only the unchanged desktop backfill boundary assertion (`16600 <= 16000`). Identical failure reproduced on untouched main with 100ms mock-outage control latency; normal main focused test passes. Escalated for approval of a test-only observed-outage timing anchor; no desktop edits or empty CI retries made. Detailed evidence and isolated light/dark visual checks are in the task file.
- Human approved the test-only backfill fix: start-boundary assertions now use observed audio time at the outage-control acknowledgement, preserving all tolerances and no-loss checks. Normal and 100ms-delayed focused integration cases each pass; desktop lint/typecheck pass. Committing the pending investigation evidence with the fix and continuing PR 3 CI.
- PR 3 source commit `acd50e7` is green: Linux `135856733308`, Swift `135856733932` and Devin Review all passed (`3 passed, 0 failed, 0 pending`). Foundation CI remediation complete; task file closed with no additional source changes.

## 2026-11-19 — ziiz overhaul: desktop renderer

- Renderer moved onto ziiz ramp, type roles, Tabler icons and registry components; optimistic workspace switch and settings saves now roll back on failure; skeletons match the loaded layout; ⌘/Ctrl+N and Esc shortcuts added. [task](tasks/ui-desktop.md)
- Fast CI green except actionlint (Docker Hub 429). Desktop e2e is macOS-only and GitHub CI doesn't run it; run it on a Mac before merging.

## 2026-11-19 — ziiz final pass, part 1

- Home now uses ziiz Item/Empty, ramp colors, type roles and Tabler icons; removes redundant sharing metadata and matches loading rows to the calendar/recent-document layout. Gallery demonstrates eleven ramps, all 31 roles and floating materials. Sonner uses ramp variables and the modal material. [task](tasks/ui-final-pass.md)
- Removed only the UI Lucide dev dependency: the web dependency is still needed by excluded PR #5 files. Editor, meeting-ui, document routes and components, the catalog and bridge import are unchanged.
- Fast CI (including actionlint) and gallery build pass; six new tests pass. Light/dark ramp and toast screenshots checked. Home is not visually verified; full integration/E2E and independent review were not run in this part.


### Ziiz overhaul — document & meeting surfaces (PR 5)

- Migrated `components/{page,document/**,meeting/**,pipeline/**}`, `d/[docId]` page + skeleton, `packages/editor/src/react/**` (+ `styles.css` var map to `--ds-*`) and `packages/meeting-ui/**` to ziiz ramp/type roles, Tabler icons and registry components (`Empty`, `Alert`, `AlertDialog`, `Item`, `Field`, `RadioGroup`, `ButtonGroup`, `Spinner`, `Kbd`, `material-menu`). meeting-ui public API unchanged.
- Optimistic share access/transcript changes (writes serialized, rollback + toast; e2e `sharing.spec.ts`), optimistic attendee removal (unit test).
- `ci --fast`: format/typecheck/lint/test pass; actionlint skipped locally by Docker Hub 429. Screenshots via `design-sweep` with `env -u DATABASE_URL` (the VM shell exports an unrelated `DATABASE_URL`).

## 2026-11-19 — ziiz final pass, part 2

- Merged PR #5/main (`c697c97`) into the final-pass branch; retained both LOG histories. Removed the shadcn bridge import, unused destructive slots, final playground aliases/raw typography and last Lucide dependency/catalog/lock entries. Added repo-wide source regression guards and targeted light/dark route screenshot coverage. [task](tasks/ui-final-pass.md)
- Fast CI fully green (`ci: ok`); web, desktop and gallery production builds passed. All three built CSS outputs have zero bridge-variable references and no missing ramp variables.
- Local compose smoke/a11y/surface Playwright checks: **17 passed (2.2m)**. Visually checked Home, a populated document and Settings in both themes; screenshots and detailed evidence in the task file. Nothing remains unmigrated in the requested scope.

## 2026-11-20 — Desktop/web shell unification

- Shared NoteColumn (44rem) and transcript panel dimensions (360/280/600); desktop now uses the web's ziiz sidebar structure, search dialog, compact user menu and draggable inset toolbar. Preserved recording, upcoming events, local search/conflicts and onboarding; no main-process/IPC/Swift changes. [task](tasks/unify-shell.md)
- Fast CI green (`ci: ok`), desktop/web production builds passed; four new renderer tests and shared geometry coverage. Updated desktop E2E interactions for the dropdown/dialog arrangement.
- Compose-backed web light capture: **2 passed (42.3s)**. Inspected built-renderer desktop light/dark and web meeting screenshots at `/home/ubuntu/shell-{desktop-light,desktop-dark,web-light}.png`; aligned columns and intact surfaces. Desktop uses stubbed IPC; native macOS chrome, real capture and desktop E2E remain unverified on Linux.

- Follow-up: New meeting note now matches web's brand-text SidebarMenuButton rather than a filled button; both primary actions use SidebarMenuBadge/Kbd shortcuts. Recording handlers and pending/disabled behavior retained. Fast CI green (`ci: ok`, 35.1s); rebuilt desktop and refreshed/inspected the light screenshot (`errors: []`). [evidence](tasks/unify-shell.md#follow-up--sidebar-action-parity)

- PR #10 review: keep plain-page local-search results read-only instead of opening them in MeetingView. Added a mixed page/meeting navigation regression test; focused shell tests **5 passed**. [task](tasks/unify-shell.md#pr-10-review-fixes)
- PR #10 review: global search now respects editor-consumed Command-K/Control-K. Verified editor-target bubble handling precedes window bubble handling and added tests for both consumed/unhandled events. Fast CI after both review fixes: **ci: ok** (34.8s), including **7 passing shell tests**. [task](tasks/unify-shell.md#pr-10-review-fixes)

## 2026-11-20 — Web recording step A

- Human approved browser mic/shared-tab recording (D-32), extending local-only audio policy without changing desktop capture. Step A covers capture/STT/transcript sync; OPFS archive/playback is step B. [task](tasks/web-recording.md)
- Step A complete: browser-safe Deepgram stream with token refresh and paced replay; AudioWorklet mic/optional tab capture; retrying cookie-authenticated transcript sync; ziiz recording controls, optimistic transcript and navigation-safe session banner. No desktop capture/IPC changes. Fast CI **ci: ok** (31.1s, 11 new unit tests), production web build successful, fake-mic/mock-STT E2E **2 passed (45.0s)**; inspected `/home/ubuntu/web-rec-light.png`. Real shared-tab UI and real providers remain unverified; OPFS archive/playback remains step B.
- Review fixes + step B complete: header-row recording controls, quiet healthy sync, stable interim/desktop-buffer parity coverage (tiny bubbles are genuine mock finals); incremental local OPFS Opus/WebM parts and metadata, neutral shared playback UI with unchanged desktop IPC adapter, web clock/segment seeking and confirmed optimistic local deletion. Fast CI **ci: ok**, web/desktop production builds successful, extended fake-mic recording E2E **2 passed (43.9s)** including playback progress, part resume, segment seek, restart and persistent deletion. Inspected `/home/ubuntu/web-rec-light.png` and `/home/ubuntu/web-play-{light,dark}.png`. Real tab/dual-source audio, other browsers and real providers remain unverified. [task](tasks/web-recording.md)
- Header/player polish: History and Notion always live in More actions; Enhance/Regenerate and Share stay on one row, with pipeline status beside the header metadata. Shared playback hides Me/Them/Both unless both sources exist. Added shared source-availability coverage and updated History/Notion selectors. Fast CI **ci: ok**; recording, meeting, History and Notion E2Es **7 passed (1.2m)**. Refreshed and inspected `/home/ubuntu/web-play-light.png` in Regenerate state. [task](tasks/web-recording.md)
- PR 11 review: account-scoped OPFS and URL cleanup; capture teardown on sign-out, shell unmount and identity changes; integer-microsecond STT replay trimming with bounded finish; non-persistent playback source fallback; held Web Locks and recent-device rejection. Unit regressions and real second-tab rejection added. Fast CI **ci: ok**; browser recording E2E **2 passed**, including continued first-tab capture, playback, seek and deletion. No native recording/IPC changes. [task](tasks/web-recording.md)
- PR 11 CI follow-up: the pipeline E2E now opens overflow before checking Notion. The overflow tree keeps its open state while History arrives; a gated-versions browser check verifies this without timing sleeps. Final fast CI **ci: ok** (30.4s); recording, History, pipeline and Notion E2Es **5 passed (1.2m)**. Remote checks are watched after the combined push. [task](tasks/web-recording.md)
- PR 11 round 2: stale captures append existing audio and resume after saved segment/part ends; failed session writes persist in account-keyed outboxes and retry on that account's shell load; teardown finishes STT before sync/close; premature finishing disconnects reconnect/drain under one deadline. A cancelled restore cannot shrink a prior audio part. Fast CI **ci: ok** (26.4s), recording E2E **2 passed (42.1s)**, meeting API integration **6 passed**. Initial typecheck caught an incomplete Storage test fake; completed it. Final remote check evidence: `/home/ubuntu/oat-pr11-ci-status.md`. [task](tasks/web-recording.md)
- PR 11 recovery review at `7e529ac`: saved batches now reject recovery after persisting unacknowledged entries, and account-owned recovery failures show a shell-level non-blocking sync warning with working Retry even before opening a note. Recovery errors are separate from the live queue's status; successful retry clears the warning. Automatic recovery runs once per identity initialization, preventing auth refreshes from racing a manual retry. Fast CI **ci: ok** (27.8s); recording + recovery E2Es **3 passed (42.1s)**. [task](tasks/web-recording.md)
- PR 11 CI escalation at pushed `f2b07e9`: Linux failed; Swift and Review passed. Downloaded CI traces: dark search snippets fail axe contrast at 4.1:1; independently reproduced on `origin/main` (`6b4c68d`) after waiting for indexing. Templates encountered sync-events 429s, then dirty retry state; exact quota cause remains unverified. Existing failing specs pass locally on both branches; full base web suite **64 passed, 17 skipped**. Stopped before unrelated search styling/sync-policy changes; lead scope decision required. [task](tasks/web-recording.md)
- Authorized PR 11 CI follow-up: primary-ramp highlight text with two-theme AA token test, fresh template identity per attempt, indexed-snippet readiness before axe, and runtime sync-event request-count assertions through capture/navigation/Retry. Sync subscriber and limiter are unchanged from main; recording/recovery add no sync EventSource, and runtime counts remain stable. CI 429s were the existing per-user sync-events quota under a shared test identity (`Retry-After: 30`); exact quota bucket is not recoverable from recorded bodies. No limiter relaxation. Fast CI **ci: ok** (63.0s); affected E2Es **7 passed, 1 skipped (1.5m)**. Remote checks watched after push. [task](tasks/web-recording.md)
- PR 11 Linux follow-up: contrast, template isolation and SSE-count checks passed remotely; recording replay assertion clicked during the transient pause between archive parts. CI trace establishes pause at 11,500 ms, automatic part-2 play at 11,700 ms, then test-induced pause; final archive end is 12,730 ms. Require native ended + final-part playhead before replay, retaining all playback assertions. Fast CI **ci: ok** (26.5s); recording E2E **2 passed (42.6s)**. No production playback changes. [task](tasks/web-recording.md)

## 2026-11-21 — UI redesign PR 1: typography

- D-33 records Geist Mono, regular Newsreader display titles and the clean-room calm-layout direction.
  Replaced the mono dependency and added shared display roles across web/desktop page and note titles;
  editor body remains Inter. Added gallery/unit coverage and two-theme browser checks, including empty
  titles and the missing-document page. Included `research/granola/ui-design.md` as requested.
- Web title/document/meeting E2Es: **13 passed (1.8m)**. Built desktop renderer and visually inspected
  web document/Home and desktop meeting/transcript at 1440×900 in both themes, under
  `/home/ubuntu/shots/pr1/`. Desktop uses the existing simulated bridge, not native Electron/audio.
- First fast CI passed format/actionlint/typecheck/lint; an unchanged editor Markdown property test
  timed out at 5000 ms (5658 ms elapsed) during concurrent browser tests. Without concurrent E2E load,
  fast CI passed all five gates (**ci: ok**, 33.1s), including **112 shared UI tests**. No editor test,
  timeout or CI changes. Review retained existing 20px metrics on error/empty/signing-in titles;
  typography E2E rerun **3 passed** (including auth setup), desktop rebuilt. No PR opened.
  [task](tasks/ui-type-geist-mono.md)

## 2026-11-21 — PR 1 typography feedback

- Human requested Inter headings, not serif display titles. Removed the display roles and restored
  previous Inter title roles/usages; kept Geist Mono and existing Newsreader editor blockquotes.
  Updated D-33, gallery and typography tests. The earlier serif screenshots are superseded.
  Fast CI **ci: ok** (52.1s); revised light/dark typography E2E **3 passed** (including auth setup).
  Product title files match their pre-PR 1 Inter sources. [task](tasks/ui-type-geist-mono.md)

## 2026-11-21 — CI fast gate (D-34)

- Human: Linux CI "takes forever", target < 3 min. Looked at 55 runs: 20 green, 14 red, 20 cancelled by newer pushes. A full run takes 11.7–17.2 min, and e2e (median 517 s) + test:int (202 s) are ~90 % of that. 8 of 14 failures were flakes (timing on the slow runner, test races), and 6 were real (lockfile, typecheck, and 4 e2e-only: axe contrast, specs broken by UI changes). [task](tasks/ci-fast-gate.md)
- PRs now run `fast`: format/actionlint/lint, typecheck and unit as 3 parallel jobs with per-job turbo caches. The full `pnpm run ci` runs on pushes to main and on demand. Run times in the task file.

## 2026-11-21 — UI redesign PR 2: shell

- Started from PR 1 on `devin/1795224212-calm-shell`. Borderless headers, primary note pills,
  search-field sidebar headers, icon footers and combined workspace/account menus; web action portal
  reserved for future page actions. Existing recording/toolbar/sync and workspace actions retained.
  Removed unused breadcrumb logic and updated its navigation assertions. Rebased onto PR 1 feedback
  commit 48b4708: headings stay Inter. Settings page content remains unchanged.
  Fast CI **ci: ok** (34.6s); web shell/navigation/workspaces/trash/templates/settings/search/tasks/axe
  **39 passed, 2 existing screenshot-only skips**; final two-theme calm-shell **3 passed** including auth
  setup. Desktop shell **10 tests passed**; renderer build passed (chunk-size advisory); built renderer
  axe **0 violations** in both themes, expanded/collapsed, with target-size/Tab/halo checks.
  Sixteen 1440×900 screenshots at `/home/ubuntu/shots/pr2/` use Inter headings; desktop bridge is
  simulated, not native/audio verification. Initial selector/link-role/tooltip typing failures fixed.
  Origin/main still does not contain PR 1 feedback commit 48b4708; main rebase remains pending.
  [task](tasks/ui-calm-shell.md)

## 2026-11-21 — UI redesign PR 3: settings

- Confirmed PR 2 rebase at f8f60da: local fast CI **ci: ok** (13.5s). Started
  `devin/1795225960-calm-settings` from PR 2. Shared Account/Workspace navigation, 640px content column,
  quiet rows and bottom danger actions. Web-managed sections have explicit desktop browser links;
  native Preferences/permissions, Recording and Storage stay native. Fast CI **ci: ok** (33.5s).
  Web settings/workspaces/calendar/Notion/pipeline/profile/smoke/typography/axe **24 passed** initially;
  stale profile selector fixed, focused profile + two-theme axe rerun **4 passed**. Desktop settings,
  shell, storage-format and configured web URL unit tests **26 passed**. Built renderer + six native
  axe scans passed; 20 light/dark 1440×900 screenshots under `/home/ubuntu/shots/pr3/` reviewed.
  Browser links retain browser session/workspace; no new native editing APIs. Native macOS/audio and
  browser launch unverified on Linux. Rebase onto refreshed PR 2 while it awaits merge.
  Rebased onto `f6be005`, keeping the CI-gate and shell LOG entries. Visual review then fixed the native
  sticky-nav offset on Storage; final local fast CI **ci: ok** (47.8s), refreshed six native screenshots
  and axe scans **0 violations**. Web settings remain visually unchanged by that renderer-only offset.
  [task](tasks/ui-calm-settings.md)

## 2026-11-21 — UI redesign PR 4: calm home and note surfaces

- Implemented web/native date-grouped borderless Home, optional Coming up, Inter title/metadata
  hierarchy, compact attendee-details popover, top-bar actions, quiet bottom controls and opt-in
  per-account transcript with Escape/close/focus return. Preserved recording, citations and resize.
- Branch `devin/1795226919-calm-note-surfaces` rebased onto merged PR 3/main `12ad11c`, including
  teamWorkspace Members-link gating. No PR opened; no separate PR #17 CI investigation was needed
  after the lead confirmed its merge.
- Fast CI **ci: ok**; 37 web e2e passed and the stale calendar attendee selector was fixed, with focused
  calendar **3 passed**. Desktop 417 tests / 54 files and shared meeting UI 34 tests / 5 files passed.
  Renderer built; existing chunk-size advisory only. Final gate log: ~/shots/pr4/ci-fast-release.log.
- Reviewed 18 light/dark 1440×900 screenshots under ~/shots/pr4/; captured-state axe **0 violations**.
  Fixed a selected desktop timestamp contrast issue caught in visual verification. Native bridge,
  recording and calendar are simulated on Linux; real macOS/audio/provider behavior is unverified.
  [task](tasks/ui-calm-note-surfaces.md)

## 2026-11-21 — PR 18 review fixes

- Starting HEAD confirmed `b04c9a2`. Separate fixes: desktop recording controls outside the transcript
  row (`3b57242`); sticky web recording feedback (`394747f`); pause web audio on transcript dismissal
  (`40a898a`). New structural and real-browser regressions cover the reported scenarios.
- Fast CI **ci: ok** (47.1s); related web e2e **13 passed (1.4m)**; renderer built (665ms). At 780px,
  sidebar expanded and transcript at its 600px maximum, native Pause/Stop remain unobscured/clickable.
  Mic-denial alert and Retry stay visible with the long note's title offscreen. Both screenshots
  reviewed under ~/shots/pr4/. See the [task](tasks/ui-calm-note-surfaces.md) for logs and limitations.

## 2026-11-21 — Calm auth, setup and dialogs (UI PR 5)

- Fresh main `015561c` → `devin/1795229369-calm-auth-dialogs`. Shared unboxed ~360px auth layout across
  web passwordless sign-in/verification/invitations and desktop auth/setup. Inter and Geist Mono stay.
  Quiet numbered setup steps, one primary action, unchanged permissions/skip/back/test recording.
- Dialogs share plain headers, ziiz modal materials and ghost cancels; sharing stays immediate-save
  with Done. Calm create/invite/share/search/trash and confirmation surfaces. D-35 records the layout
  and existing-auth-model decisions. No password reset or web onboarding state machine invented.
- Fast CI **ci: ok** (38.4s); desktop **425 passed / 55 files**; renderer built (745ms), existing chunk
  advisory only. Required web auth/workspace/sharing/a11y cases passed; initial combined suite had
  **20 passed, 1 skipped, 2 extra typography failures** (unchanged sr-only Home h1 weight mismatch on
  main). Additional desktop-sign-in/templates/versions **8 passed, 1 skipped**. Final sharing/search
  **7 passed, 1 skipped**, including a new palette axe regression. See the task for exact commands/logs.
- Personally reviewed **36 light/dark 1440×900 PNGs** in ~/shots/pr5/; all captured-state axe scans
  report **0 violations**. Review fixed squeezed calendar labels and a decorative listbox separator
  exposed to AT. Keyboard/focus, permission-error/loading and setup interaction coverage retained.
  Linux desktop evidence is simulated, not native Electron/macOS/audio verification. Browser desktop
  handoff has e2e coverage but no separate screenshot. [task](tasks/ui-calm-auth-dialogs.md)

## 2026-11-21 — PR5 follow-up: visible Home typography coverage

- Corrected the typography spec rather than styling Home's sr-only h1. PR4 intentionally removed the
  visible Home display heading; the spec now checks a visible note row for Inter/body weight 400 and
  keeps display-weight 450 checks on visible document/meeting/settings/not-found titles. No UI change.
- Typography Playwright **3 passed (56.9s)** including setup/light/dark. Fast-gate command/evidence:
  `pnpm run ci --fast`, `~/shots/pr5/ci-fast-typography-fix.log`.
  [task](tasks/ui-calm-auth-dialogs.md)
- 2026-11-21 · unified-workspaces · Human decided D-36: no personal workspace; join by invite/domain with a
  per-workspace join policy; Private + Shared inside a workspace; leavers lose access but can export. SPEC §4–6
  updated, task brief written (3 steps), added to PLAN M9. Nothing implemented yet.
  [task](tasks/unified-workspaces.md)
- 2026-11-21 · unified-workspaces · done on branch `task/unified-workspaces` (not pushed, not merged to `main`).
  Steps A (no workspace kind), B (join by domain/policy, requests) and C (Private + Shared, export on leave),
  each implemented, independently reviewed and verified; `task/e2e-calm-shell-specs` merged in. Final full
  `pnpm run ci` at 12abca9: `ci: ok`, every step pass. For the human: admin (not only owner) can open a
  workspace to a domain; lookalike workspaces are possible without DNS verification; desktop deletes unsynced
  local notes of a workspace after leaving; Home no longer offers "connect calendar"; the menu offers "Leave"
  to a workspace's sole owner. [task](tasks/unified-workspaces.md)
- 2026-11-21 · Graphite UI foundation · Synced the Ziiz registry and applied Graphite and default
  control shapes to web, desktop and shared meeting UI (D-37). Local fast gate passed and web
  Playwright finished with 87 passed and 17 skipped. Built the desktop renderer and captured
  light and dark web Appearance and desktop Storage evidence in
  [PR #22](https://github.com/nafisazizir/oat/pull/22). [task](tasks/graphite-ui-foundation.md)
- 2026-11-21 · API foundation (D-38), handoff 1 · Added REST parity for workspace/member/invite/join/calendar actions, shared server operations, DTOs/schemas and authorization integration coverage. Fast CI green; relevant integration tests 139 passed. Client package and desktop proxy remain for handoffs 2/3; independent review/verification pending. See docs/tasks/api-foundation.md.
- 2026-11-21 · API foundation (D-38), handoff 2 · Added private browser-safe @oat/client with typed feature namespaces, injectable fetch/bridge-ready transport, toFetch for AI SDK, typed errors, raw streams, SSE helpers and cancellation. Shared app-only contracts moved to services DTOs; route/method inventory protects coverage. Final fast CI: ci: ok; client unit tests 4 files/49 tests passed. Desktop authenticated proxy remains handoff 3; no UI wiring or packages/ui changes. See docs/tasks/api-foundation.md.
- 2026-11-21 · API foundation (D-38), handoff 3 · Added strict core API channels, main-owned authenticated text/JSON proxy, shared typed-client route inventory, ownership/lifecycle cancellation and renderer bridgeTransport/ready client exports. Token and sensitive headers stay in main; 401 uses existing session invalidation. Fast CI: ci: ok; desktop 58 files/499 tests, client 5 files/59 tests, core 15 files/489 tests, web integration 2 files/139 tests passed. settings:open-web retained but no longer needed for phase 2 API-backed settings. Text-only bridge cannot download ZIP exports; pre-header abort must wait for the returned stream id to cancel upstream (both documented). No UI wiring; independent review/verification pending. See docs/tasks/api-foundation.md.
- 2026-11-21 · Shared feature UI/search, step 1 · Extracted @oat/feature-ui provider, pluggable search sources, dialog/results UI and pure helpers; web now uses typed-client shared search. Added both host dependencies/styles and radius coverage. Package 27 tests, web 248 tests, vocabulary 16 tests, package typecheck/lint and web typecheck passed. Desktop runtime/local-source adapter, deep-link opening policy and visual verification remain; no commits/pushes. See docs/tasks/desktop-feature-search.md.
- 2026-11-21 · Shared feature UI/tasks, step 2 · Added controlled shared TasksView, list/update/assignees client hooks and retry-once helper; web page and editor consume them. Host Link adapter restores Next Link prefetching. Shared toolbar and row structures align loading/final layouts. Package 50 tests, web 242 tests, vocabulary 16 tests, package typecheck/lint and web typecheck passed. Visual verification and desktop runtime remain unchecked; no commits/pushes. See docs/tasks/desktop-feature-search.md.
- 2026-11-21 · Shared feature UI/assistant, step 3 · Extracted assistant threads, AI SDK session, markdown/citations, proposals, transcript reader and helpers into @oat/feature-ui/assistant. Typed client handles JSON; toFetch(host transport) streams chat with stop/abort cleanup. Web retains editor application/in-place citations through an injectable integration and binds page thread selection to URL. Package 93 tests, web 220 tests, vocabulary 16 tests, package typecheck/lint and web typecheck passed. No visual, desktop runtime or full CI verification; no commits/pushes. See docs/tasks/desktop-feature-search.md.
- 2026-11-22 · Shared feature UI/desktop, step 4 · Committed steps 1–3 locally as 3ed807e, then wired signed-in api/apiTransport provider, Sonner, shared palette/full search with local FTS + server fallback, Assistant/My tasks sidebar views and native cached-meeting navigation. Uncached documents temporarily open through main's configured web origin using validated document-relative external links. Preserved recording controls across feature views; added theme commands and renderer stream-cancellation coverage. Final desktop typecheck/lint pass, 60 files/511 tests; shared feature UI 8 files/93 tests; root `pnpm run ci --fast`: every step pass, `ci: ok` (58.9s). No visual or real Electron runtime checks, no push. Independent review pending. See docs/tasks/desktop-feature-search.md; full log /home/ubuntu/feature-ui-ci-fast.log.
- 2026-11-22 · Shared feature UI/verification, step 5 · Started healthy local stack; reused AI mock and extended Assistant/Tasks/Search command-menu e2e with light/dark WCAG 2.2 AA axe scans. Fixed selected conversation-date contrast and nested palette option/link semantics, including CommandItem asChild composition. Final e2e 11 passed/1 opt-in screenshot-only skip; search/tasks/chat route integration 3 files/33 tests passed. Shared feature UI 94 tests, UI component/vocabulary 36 tests, web 220 tests and desktop shell 16 tests passed; relevant typecheck/lint green. Built desktop renderer and verified fixture bridge SSE/chat, populated Tasks, offline palette and sidebar with no browser console/page errors. Captured 20 light/dark PNGs under /home/ubuntu/screens (not committed); scratch bridge at /home/ubuntu/feature-ui-scratch/desktop.mjs. Native Electron/OS bridge smoke and independent review remain pending; no step-5 commit or push. See docs/tasks/desktop-feature-search.md.
- 2026-11-21 · Desktop workspace parity, step 1 · Extracted @oat/workspace-ui host/routes/REST loader and shared sidebar/tree/trash/workspace dialogs; web now supplies Next navigation and theme/account/search slots. Shared tests: 4 files/32 passed. All fast CI steps pass (final split runs); web production build passes. Initial formatting issue fixed; Docker Hub actionlint pull rate limit resolved through the same pinned image on Google's mirror, no config changes. Visual/e2e checks and desktop/document/template wiring remain. No commit/push. See docs/tasks/desktop-workspace-parity.md.
- 2026-11-21 · Desktop workspace parity, step 2 · Step 1 committed locally as 8b08aee. Shared PageEditor/autosave, ShareDialog, FolderView/ShellFolderView and page primitives now serve web; web-only enhancement/history/pipeline/Notion/assistant/task/portal/keepalive behavior stays in its adapter. Removed moved implementations. Shared tests: 5 files/46 passed (14 new). Fast CI passed, then affected gates and web production build passed after final conflict-reload cleanup. UI visually unverified; e2e/axe not run. Desktop integration/templates and desktop share-link origin remain later work. Step 2 committed locally; nothing pushed. See docs/tasks/desktop-workspace-parity.md.
- 2026-11-22 · Desktop workspace parity, step 3 · Added host appOrigin for copied share links and extracted templates gallery/new/detail/editor/preview/icon/delete/duplicate plus the reusable Enhance/Regenerate template picker. Web pages remain server-loaded adapters; gallery gets calm flat-card styling. Browser bundling @oat/ai/templates confirmed no external runtime imports. Fast CI and web build passed; final affected gates passed after correcting a new accessible-name assertion to the original adjacent-span name. Shared suite: 6 files/62 passed. UI visually unverified; e2e/axe not run. Local commit only; desktop integration remains. See docs/tasks/desktop-workspace-parity.md.
- 2026-11-22 · Desktop workspace parity, step 4 · Desktop now provides the workspace host, observed API status/public origin, REST shell data plus local meeting notes, shared sidebar and document/folder/template routes. Existing local search, recording/start shortcuts, onboarding, settings, conflicts and sync remain; recording controls stay available on server-only routes. Public origin added to existing app:info, no new channel. Workspace REST switches reconcile the local recording target through existing sync/workspace IPC. Shared trash/share gain offline states; ZIP export is web-only with a desktop notice. C3 surfaces and Join are placeholders. Initial fast CI exposed unstable Link identity and a missing meeting-route hint for search hits absent from the roster; fixed and final affected gates passed. Desktop 59 files/513 tests; shared 6 files/63 tests. Desktop production build passed with a large-chunk warning. UI visually unverified; e2e/axe not run. Local commit only; nothing pushed. See docs/tasks/desktop-workspace-parity.md.
- 2026-11-22 · Desktop workspace parity, step 5 · Captured/inspected 12 built-renderer Chromium desktop surfaces and 3 real-stack web comparison surfaces at 1280×800 in /home/ubuntu/evidence/c2; both capture console logs report errors: []. Fixed offline workspace count/icon fallback (cached 4 members no longer becomes 1; local roles remain authoritative), added regression coverage and re-captured. Web documents/private-shared/sharing/templates/workspaces/a11y specs: 24 passed, 1 skipped (existing screenshot-only dark editor), 0 failed; route/sidebar/leave axe passed in both themes. Initial setup failed only because Playwright Chromium was missing; installed through the project's Playwright and reran. Final affected CI: ci: ok; desktop 59 files/514 tests. Rebuilt desktop successfully (existing size warning). Native macOS/Electron recording/window chrome not tested; C3/Join remain the explicitly allowed placeholders. Local fix commit only; no push. See docs/tasks/desktop-workspace-parity.md.
- 2026-11-21 · C1 settings parity · Shared Graphite settings panels now render in web routes and inside desktop. Replaced the web-settings redirect bridge with file-save ZIP export and system-browser provider consent. Focused Playwright: 9 passed, including settings axe in both themes; authorization: 130 passed. 26 screenshots under `/home/ubuntu/screens/settings/`; macOS Electron e2e and independent review pending. See [task](tasks/settings-parity.md).
- 2026-11-22 · Shared feature UI/settings integration merge · Committed STEP 5 locally as 19ad04d, fetched and merged origin/devin/1795304500-parity-integration at 0f9060e (PR #24). Kept in-app settings/export/connect IPC, the incoming shared ThemeProvider/root Toaster, and all Assistant/Tasks/Search navigation with recording controls. Removed duplicate feature Toaster and superseded desktop theme helper; palette commands now update the settings theme store. Desktop typecheck/lint pass, 60 files/510 tests; feature UI 8 files/94 tests; root ci --fast: every stage pass, ci: ok (129.3s). Rebuilt renderer and re-shot 10 desktop feature PNGs plus two Settings PNGs under /home/ubuntu/screens, with single-Toaster and bidirectional theme assertions; no console/page errors. Both task-board/log histories retained; DECISIONS.md unchanged. Native Electron/OS smoke and independent review pending; no push. See docs/tasks/desktop-feature-search.md and /home/ubuntu/feature-ui-merge-ci.log.
- 2026-11-22 · Shared feature UI STEP 6 visual hill-climb · Matched desktop sidebar order to web; shared Tasks/Search title/subtitle headers; unified flat divided hover rows; spaced superscript citation chips and a cited-note footer; centered new-chat greeting/composer with ghost suggestions; quiet bordered thread column; proper Avatar owner badges aligned with due badges. Added semantic/layout regressions and resolved the new footer's axe label/content mismatch. Final web Assistant/Tasks/Search e2e + light/dark axe: 11 passed, 1 existing opt-in skip; feature UI: 9 files/100 tests; ci --fast: all stages pass, ci: ok (55.5s). Rebuilt desktop renderer and refreshed 24 web/desktop PNGs under /home/ubuntu/screens, including full desktop Search; fixture console/page errors []. No PNGs or scratch harness tracked. Native Electron/OS smoke and independent review remain pending. See docs/tasks/desktop-feature-search.md and /home/ubuntu/feature-ui-step6-ci.log. Local commit only; no push.
- 2026-11-22 · PR #26 review finding 1 · Forwarded x-oat-thread-id through desktop's safe stream-header allowlist; documented why chat needs it and checked enhancement headers for other client-required metadata (none). Added main-proxy safe-header coverage and a real bridgeTransport UI follow-up regression with header-only identity. Feature UI: 9 files/101 tests; desktop: 60 files/510 tests; shared typecheck passed. Pagination review fix next; push once after both commits, then continue CI loop.
- 2026-11-22 · PR #26 review finding 2 · Replaced pagination concat with provenance-aware search-page merging: server documents supersede local hits across sections, note/segment ids dedupe repeated hits, distinct server segments remain, counts/cursors stay accurate. Added page/replacement/empty/error regressions. Feature UI: 9 files/106 tests; desktop: 60 files/510 tests; ci --fast all stages pass, ci: ok (62.2s). Separate review-fix commits pushed together before C2 workspace-shell merge.
- 2026-11-22 · Desktop workspace parity, step 6 · Merged integration base 0f9060e (PR #24 settings) without rebasing. Resolved seven content conflicts, retaining workspace/settings styles, both log histories, workspace shell/meeting routing and shared in-app SettingsView. Settings/Invite members/Workspace settings/Profile target the appropriate shared section. Removed duplicate workspace-host Toaster in favor of #24's theme-aware root Toaster. Sidebar leave now reuses settings-ui's dialog and native settings:export-notes callback, with count/empty/cancel/error coverage and recording/stopping guard. Shared avatar also reuses settings-ui; no platform imports in shared workspace UI. Reinstalled merged dependencies/lockfile. Initial fast gate caught unsupported Testing Library exact options and missing error cause, fixed; actionlint passed initially and final affected format/typecheck/lint/test gates passed. Desktop 61 files/527 tests, workspace-ui 6 files/67 tests, settings-ui 2 files/12 tests. Final desktop build passed with the existing size warning. No post-merge visual/e2e or native file-save check; no push. See docs/tasks/desktop-workspace-parity.md.
- 2026-11-22 · Desktop workspace parity, step 7 · Screenshot-review fixes: New meeting note is now a brand-colored SidebarMenuButton with IconEdit/⌘N in Search's menu; pending/disabled/shortcut behavior retained, including native disabled propagation through the tooltip. Offline API status now overrides the last-success sync snapshot to show amber cloud-off, Offline label/tooltip. Rebuilt and re-captured/inspected all 14 post-merge desktop light/dark surfaces, now including shared Settings opened from the sidebar; capture console errors: []. Web set plus settings: initially 24 passed/2 failed/1 skipped; both failures were export-confirmation wording introduced by the shared-settings merge. Restored web's downloads wording while preserving desktop's ZIP-file wording, without changing e2e expectations; focused rerun 3 passed (setup + both leave cases), giving all 26 distinct non-skipped selected cases passing. Axe passed for routes/sidebar/leave/settings in both themes. Final format/typecheck/lint passed; an unchanged main-process transcript-backfill test timed out once at 5s, then the failed test step passed in full without edits after e2e completed. Actionlint passed initially, inputs unchanged. Desktop 61 files/527 tests; workspace-ui 6 files/68 tests. Final desktop build passed with existing size warning. Evidence in /home/ubuntu/evidence/c2; task records exact commands/logs. Push to existing feature branch authorized; no PR action. Native macOS recording/file-save remains unverified. See docs/tasks/desktop-workspace-parity.md.
- 2026-11-22 · PR #26 C2 integration · Merged 085930f after separately committing/pushing review fixes f2ea253 and b98e7de. Incoming shared workspace shell wins; replaced desktop feature placeholders and duplicate feature navigation with real feature views and one WorkspaceHost-to-FeatureUiAdapter helper used by both hosts. Retained web Next Link, desktop local/server search, shared palette host commands, cached-meeting/external-document fallback, settings/root Toaster and recording controls. Adapter/renderer regressions pass: feature-ui 116, workspace-ui 69, desktop 534, web 207 tests. Browser run plus focused search rerun gives all 11 distinct selected non-skipped cases passing, with light/dark axe. Fixed transcript URL ordering, test focus/portal readiness and a pre-existing random English-stemming fixture; screenshot review caught and fixed desktop Assistant's missing flex parent, with real composer-geometry assertions in the scratch harness. Rebuilt/refreshed 24 web/desktop PNGs in /home/ubuntu/screens. Final fast gate all stages pass, ci: ok (93.0s); live PR gate follows push. Native Electron/OS checks remain unverified. No D-number. See docs/tasks/desktop-feature-search.md and /home/ubuntu/pr26-c2-*.log.
- 2026-11-22 · PR #26 web source stability · Review of 20a2d69 found URL-only tab changes recreating the web client/feature search sources, refetching page one and dropping loaded pages. Memoized the client per shell, host by canonical AppRoute, and sources by client. Added real-root Playwright pagination/URL-tab regression with debounced no-refetch assertions. Fast CI all stages pass, ci: ok (41.1s); Search e2e 4 passed/1 existing opt-in skip; Assistant/Tasks e2e 9 passed, giving all 12 distinct selected non-skipped browser cases passing with light/dark axe. Web screenshots refreshed; markup and desktop unchanged. One fix commit/push, then live PR gate. See docs/tasks/desktop-feature-search.md and /home/ubuntu/pr26-client-stability-*.log.
- 2026-11-22 · PR #26 native document navigation · Corrected obsolete external fallback: uncached feature documents now use C2's native document AppRoute/PageEditor, retaining block/segment/time fields; cached meetings retain MeetingView. Reference search confirmed externalDocumentUrl had no independent callers, so removed helper/document-relative main wiring/tests. Retained safe absolute HTTP(S) shell:open-external for calendar conference links. Added deep-link provider regressions and real-renderer PageEditor/MeetingView assertions. Desktop 63 files/535 tests and feature-ui 10 files/116 tests passed; final fast gate all stages pass, ci: ok (60.9s), remote gate follows push. Native Electron/OS and visual checks not repeated; no D-number. See docs/tasks/desktop-feature-search.md and /home/ubuntu/pr26-native-document-*.log.
- 2026-11-22 · PR #26 plain-page citation focus · Follow-up to 497a29a: native DocumentRoute now consumes query.block using the existing web scrolling/highlighting mechanism extracted into @oat/editor/react; web retains a thin Next wrapper. Preserved reduced motion, bounded editor-mount waiting and highlight duration; added cleanup and same-page retargeting coverage. Desktop route regression plus shared helper tests pass; existing real web block-link E2E 2 passed. Fast format/actionlint/typecheck/lint passed. Unchanged Node-only markdown property test twice exceeded local 5000ms; failed test stage passed in full with repository CI OAT_TEST_TIMEOUT_SCALE=3, without test/config timeout edits (24 tasks, ci: ok, 24.4s). Desktop 536/editor 186/feature-ui 116/workspace-ui 69/web 207 tests pass. Separate fix commit/push, then live PR gate; native Electron/OS and visual verification not repeated. See docs/tasks/desktop-feature-search.md and /home/ubuntu/pr26-block-focus-*.log.
- 2026-11-22 · Functional parity audit after PR #28 · Added docs/tasks/functional-parity.md with Before route/view, package ownership, menus/dialogs, shortcuts, state/feedback, external exits and local-first inventories. Proposed fixes are not implemented; D-38 remains the last decision. Static source audit only; no native/browser/visual execution or production access. Updated PLAN. Acceptance gates: targeted Prettier check and git diff --check; product CI/tests intentionally not run for Markdown-only changes. Local commit on devin/1795313872-parity-audit; no push.
- 2026-11-22 · Functional parity G2 + G5 · Extracted typed-client JoinChoiceList/JoinWorkspace into workspace-ui, used by web and desktop; invitation/domain/request/pending/create/back and authoritative no-workspace bootstrap retained. Desktop syncs/selects the joined membership locally; Google Upcoming now opens native Integrations, including empty compact Home, with obsolete main browser callback removed. Minimal existing presentation reused; common upcoming-row extraction deferred. Fast gate format/actionlint/lint/test passed; initial typecheck found an undeclared test dependency, fixed via existing React server renderer; affected format/typecheck/lint rerun all pass, ci: ok. Unit totals: workspace-ui 83, desktop 543, web 208. Join e2e initially cold-compile setup timeout; supported timeout scaling/2 workers rerun 5 passed (2.5m), light/dark axe included. Web screenshot inspected; evidence /home/ubuntu/oat-parity-evidence, logs /home/ubuntu/oat-parity-*.log. Desktop/native macOS rendering/permissions and real OAuth remain unverified. Updated task After matrix/PLAN; one local handoff commit, no push, no new decision.
- 2026-11-22 · Functional parity G3 + G14 + G13 · Shared authenticated InviteResponse in workspace-ui, typed POST invite lookup plus existing recipient-authorized accept/decline; web keeps browser/email default and offers canonical native links only to authenticated recipients. Main validates fixed 32-character base64url oat://invite links and queues validated route delivery across sign-in/setup/account switching; renderer never receives a bearer. Shared feature-ui host commands align navigation/Templates/Pages/New page/sidebar/settings/workspaces/themes with visible check; desktop Start recording stays guarded, web New note retained. Desktop search tab/task filters are route-controlled and serialize to web-compatible query parameters; G1 history/restart restoration remains separate. Initial fast gate caught missing Next Route cast and incomplete test fixture, fixed; two 5-second desktop timeouts passed with supported OAT_TEST_TIMEOUT_SCALE=3. Final affected format/typecheck/lint/test gates pass, ci: ok (92.0s); initial unchanged actionlint pass retained. Unit totals: workspace-ui 98, feature-ui 122, desktop 551, web 209. API lookup/entry-point authz integration: 145 passed. Invite/workspace + command/search browser specs: 7 passed (3.6m), 1 existing opt-in evidence skip, axe included. Startup/native palette regressions cover invitation preservation after setup and typed workspace switching/error behavior. API/browser inputs unchanged by final native fixes; their earlier passes retained. Logs /home/ubuntu/oat-parity-g3-g14-g13-{fast,correction,final}.log, oat-parity-invite-int.log and oat-parity-invite-command-e2e.log. Browser behavior checked, visual/native OS registration/launch and macOS/provider checks unverified. Updated After matrix/PLAN; local commit only, no push or new decision.
