# Decision Log

Format: `D-<n> · date · status (accepted/proposed/superseded) · decided by (human/agent)`.
Agents may add `proposed` entries; anything marked `human` changes only with the human's approval.

## D-1 · 2026-11-14 · accepted · human
Build our own product inspired by Granola's core loop; no parity clone. REA is a research tool, not a code source.

## D-2 · 2026-11-14 · accepted · human
Scope includes auth, personal + team workspaces, sharing, integrations and AI assistants.

## D-3 · 2026-11-14 · accepted · human
Vercel AI SDK for all AI features.

## D-4 · 2026-11-14 · accepted · human
TipTap editor with Notion-style blocks.
Detail (agent recommendation, accepted unless human objects): TipTap JSON is canonical; Markdown is derived.
Why: Markdown can't hold block IDs, mentions, callouts, AI-vs-mine marks; changing storage later is a migration.

## D-5 · 2026-11-14 · accepted · agent
Electron + Vite for desktop. Evidence: Granola 7.786.3 ships Electron with Vite build output
(`dist-electron/main/index.js`) — see `research/granola/FINDINGS.md`.

## D-6 · 2026-11-14 · accepted · agent
UI: shadcn/ui + token-based theme from day one instead of copying Granola's UI or blocking on a bespoke design
system. Layout/flow inspiration from Granola is fine; visual identity is ours.

## D-7 · 2026-11-14 · accepted · human (agent proposal)
Agents: interactive assistant = AI SDK tool loop; durable/background agents = eve, decided at task 8.2 after
reading eve's bundled docs. Tools live in `packages/ai` so both can reuse them.

## D-8 · 2026-11-14 · accepted · human (agent proposal)
Audio capture as a Swift sidecar binary (not a Node addon) with `AudioSource` abstraction + `FileSource`
for tests. Why: crash isolation, simpler build, makes the pipeline verifiable by agents.

## D-10 · 2026-11-14 · accepted · human
Keep recorded audio in a local cache on the recording device, for reference and archive. Never uploaded or
synced. Agent detail: per-source Ogg Opus files written incrementally, retention settings, playback synced
to transcript (SPEC §4, §6; PLAN 2.8, 3.7, 3.8).

## D-9 · 2026-11-14 · accepted · human (agent proposal)
Better Auth (organization plugin) for auth; Neon Postgres + Drizzle; Deepgram streaming STT behind an interface.

## D-11 · 2026-11-14 · accepted · human
**Development is fully containerised and offline.** `pnpm dev:up` (docker compose) provides every external
dependency; no API keys and no calls to external services are needed to develop, test or demo. Moving to a new
machine = install Docker + Node + pnpm, clone, `pnpm i && pnpm dev:up && pnpm dev`.
Agent detail:
- Compose project `oat`, ports in a private range to avoid clashing with other local stacks:
  | service | image / source | host port | stands in for |
  |---|---|---|---|
  | postgres | `pgvector/pgvector:pg17` | 54329 | Neon (prod) |
  | redis | `redis:7-alpine` | 63790 | Upstash/managed Redis (queues, rate limits, pub/sub) |
  | mailpit | `axllent/mailpit` | SMTP 11025, UI 18025 | transactional email (magic links, invites) |
  | oauth | `ghcr.io/navikt/mock-oauth2-server` | 18089 | Google OAuth/OIDC |
  | mocks | `tools/mocks` (our Node service) | 14010 | OpenAI-compatible LLM + embeddings (AI Gateway), Deepgram-compatible streaming STT websocket, and later Notion + Google Calendar API subsets |
  | web (profile `app`) | `apps/web` Dockerfile | 3000 | Vercel (prod) |
- Every integration is selected by env (base URL + key). `.env.example` defaults point at the mocks, so real
  keys switch to real providers with no code change. Real-provider smoke tests run only when a key is set.
- Unit tests (`pnpm test`) use in-process fakes and need no containers. Integration tests (`pnpm test:int`)
  use the compose services; each run creates its own throwaway Postgres database so parallel worktrees can
  share one stack.
- Neon, Vercel, Deepgram, AI Gateway, Google, Notion become **prod-only** human checkpoints (PLAN 9.6); they do
  not block dev milestones.
- The desktop app and Swift sidecar run natively on macOS (cannot be containerised); they talk to the
  containerised API/mocks.

## D-12 · 2026-11-14 · accepted · human
Local git only (no GitHub remote for now). The factory commits, branches and squash-merges to local `main`.
The GitHub Actions workflow is still written; `pnpm run ci` runs the identical checks locally and is the gate.

## D-13 · 2026-11-14 · accepted · human
Dev AI is mocks only — no local LLM or local STT containers. The mock LLM returns deterministic,
schema-valid output. Evals therefore have two tiers: structural checks (always, against the mock) and
quality scoring (only when a real model key is configured). Note quality is judged by the human once real keys
are added.

## D-14 · 2026-11-14 · accepted · human
SPEC §10 open questions resolved with the defaults: Better Auth, Deepgram (behind `SttProvider`), Postgres +
Drizzle, Swift sidecar, no Windows in v1, product name "Oat".

## D-15 · 2026-11-14 · accepted · agent
Internal workspace packages (`packages/*`, `@oat/<name>`) are **TypeScript-source packages**: `exports` point
at `./src/*.ts` (`.` → `./src/index.ts`, `./*` → `./src/*.ts`), there is no per-package build step, and
consumers compile them (Next.js `transpilePackages`, electron-vite/Vite, Vitest). Shared dependency versions
live in the pnpm `catalog:` in `pnpm-workspace.yaml`.
Why: no build ordering or watch processes between packages, instant cross-package edits in dev, go-to-definition
lands in source, one less cache layer in turbo. Cost: every consumer must be able to compile TS (all of ours
can), and packages can't be published to npm as-is (not a goal). If a package ever needs to run under plain
Node without a bundler (e.g. a CLI), give that one package a build step rather than changing the default.
Turbo still invalidates dependents' `typecheck`/`test` caches when a dependency's source changes via a `transit`
task (`dependsOn: ["^transit"]`).
Consumer requirements: Next.js (`apps/web`) must list every `@oat/*` package in `transpilePackages`;
electron-vite (`apps/desktop`) externalizes dependencies in its main/preload builds by default, so `@oat/*` must
be excluded from externalization (bundled) — otherwise Node tries to load `.ts` files at runtime.
Package `exports` map `./*` → `./src/*.ts` but block test files with `"./*.test": null`.

## D-17 · 2026-11-14 · accepted · agent
STT credentials and resilience, informed by `research/granola/audio-path.md`:
- The desktop never holds a long-lived STT key. `apps/web` issues short-lived STT tokens to signed-in clients
  (Deepgram temporary keys/grants in prod; the mocks service implements the same grant endpoint in dev).
- One STT stream per source (mic, system) — never mixed; segments tagged by source.
- Reconnect replays a rolling in-memory buffer of recent audio (≥120 s per source) into the new connection;
  longer outages are back-filled by re-transcribing from the local Opus archive (D-10) — our advantage.
- Mic path uses OS echo cancellation (Apple voice processing) so speaker playback doesn't leak into "me".

## D-18 · 2026-11-14 · accepted · agent
Private folders belong to their owner; only the owner adds children. Moving a document into a private folder
requires owning both and makes the document `private`. No cross-workspace moves in v1. Re-enabling link
sharing rotates the share token. Only owners remove/demote admins. (From 1.7 review.)

## D-19 · 2026-11-14 · accepted · agent
**Sync design** (from `research/granola/ARCHITECTURE.md` §11, improving on Granola's five ad-hoc mechanisms):
- One mechanism for every synced table: SQLite triggers enqueue `(table, id, op)` into an outbox with a
  monotonically increasing version; push acks by version; an "applying remote" flag suppresses echo.
- Pull: opaque cursor, paged until done, applied in one transaction that also clears matching outbox rows;
  stale cursor → 409 → full resync.
- Conflicts: push carries the base `version`; server rejects a stale base with 409; client keeps the server
  copy and saves its own as a new "conflicted copy" document (never silent overwrite).
- Realtime: per-user SSE invalidation channel ("pull X / ids Y", sequence numbers, replay-from-seq) plus a
  periodic poll backstop. No row streaming.
- Desktop SQLite is a disposable cache: schema version stored, wipe + resync on corruption/too-new/failed
  migration; single writer, WAL; growing data (segments, outbox) lives in SQLite, never JSON files.
- `transcript_segment` ids are client-generated and stable; a final replaces its interim; only finals sync.

## D-20 · 2026-11-14 · accepted · agent
**Enhancement model.** After enhancement the document body *is* the enhanced note: TipTap JSON whose blocks
carry `origin: me | ai` (set during structured-output → TipTap conversion; drives styling). The user's raw notes
at enhance time are kept immutably (`enhancement.input_notes_json`), and every enhancement output is kept
(`enhancement.output_json`, versions) so undo/restore and "show my original notes" work. Enhancement is a
server job with `status: generating|completed|failed`, an idempotency key, staleness timeout and a resumable
stream; the client re-attaches after a crash. Templates = title, description, ordered sections
{heading, instructions}; one prompt builder serves all templates; section budget scales with transcript length.
One shared `buildMeetingContext()` feeds enhance and note-scoped chat. Regenerating warns when the current body
differs from the last output.

## D-21 · 2026-11-14 · accepted · agent
**Detection scope.** Primary signal: a known meeting app holding mic input (Core Audio process objects, macOS
14.2+, our 14.4 minimum covers it) via a sidecar `mic-apps watch` command (~1 Hz, diffs only). Rules are pure
functions with fixture tests (allowlist + helper→parent map as data, asymmetric debounce, ~2 s prompt delay,
2-min rate limit, no prompt while recording, per-app silence). Deliberate difference: browsers prompt only when
a calendar event overlaps. Calendar names the meeting (in progress or starting within 90 s, started ≤ 15 min
ago) and adds a "meeting starting" notification ~1 min before events with attendees. Deferred to IDEAS:
accessibility-tree reader, browser extension, app-level encryption at rest.

## D-16 · 2026-11-14 · accepted · agent
`oat-audio` wire protocol (protocol 1, `native/oat-audio/PROTOCOL.md`): stdout carries binary frames — 14-byte
little-endian header (`u8 kind` audio/event, `u8 source` mic/system/none, `u64 t_us` on one shared monotonic
capture clock, `u32 payload_len`) + payload (audio = s16le mono PCM at the announced rate, 50 ms frames by
default; event = UTF-8 JSON `{"type":…}`). Control on stdin = newline-delimited JSON
`{"cmd":"pause"|"resume"|"stop"}`, EOF on a pipe = stop. Logs on stderr only.
Why: length-prefixed binary keeps PCM cheap to parse in Node (no base64/JSON per audio frame); one stream for both
sources + events keeps a single clock and the order between events and audio; JSON events stay debuggable and
forward compatible (unknown fields/types ignored). Rejected: JSON lines with base64 audio (~33% overhead + parse
cost); one pipe/socket per source (more fds and lifecycle for Electron, event/audio ordering lost).
`scripts/check-frames.mjs` is the contract test; breaking changes bump `protocol`.

## D-22 · 2026-11-14 · accepted · agent
`change_log` (backing D-19 cursor pulls and SSE invalidation) is written by Postgres triggers on every synced
table — so Better Auth writes and FK cascades are captured, not just app code — and carries
`txid xid8 default pg_current_xact_id()`. Readers return only rows whose transaction is older than the current
snapshot's xmin, ordered by (txid, seq), so out-of-order commits are never skipped. Workspace hard-deletion via
Better Auth is disabled; workspace deletion will be a soft-delete path of our own. (From 1.5 review.)
