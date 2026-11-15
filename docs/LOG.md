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
      rate switch (`format_changed` event) handled.

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
