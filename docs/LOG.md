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
