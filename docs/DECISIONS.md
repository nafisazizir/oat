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

## D-7 · 2026-11-14 · accepted · human (agent proposal) — durable part resolved by D-29
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

## D-23 · 2026-11-14 · accepted · agent
Block `origin` editing rule (from 3.1): a newly created block is `me`; an `ai` block keeps `ai` while the user
edits words inside it; if the user deletes all of an AI block's text and writes their own, it becomes `me`.
Joining two blocks of different origin yields `me` (never relabel the user's words as AI).
Revisit with real use (an "edited" state could be added later without a migration — it's an attribute).

## D-24 · 2026-11-14 · accepted · agent
Audio archive details (from 2.8): codec `libopus-wasm` (MIT wrapper, BSD libopus; WASM, no native addon),
mono 16 kHz, 24 kbps, 20 ms packets, DTX on (~12 MB per meeting-hour for both sources); our own Ogg muxer.
Gaps (pause/overrun) inside one recording session are filled with silence so file time == session time.
**Multiple recording sessions per meeting** (stop then resume later) create numbered parts
(`<meeting_id>/{mic,system}.<n>.opus`, part 1 may keep the unnumbered name for compatibility) — one
`audio_recording` row per part with `offset_ms` from the meeting's first start; transcript segment times stay on
the meeting clock, and playback/seek maps a segment to (part, offset). No multi-hour silence padding.

## D-25 · 2026-11-14 · accepted · agent
Sharing (from 5.3): link tokens are 192-bit base64url, issued fresh when link sharing is turned on, cleared when
off, replaceable via "reset link". Documents in private folders can't be link-shared. Link viewers see the note
only; the transcript is shown only when `document.share_transcript` is on (default off). The public page is
server-rendered from TipTap JSON through schema validation + an allowlist sanitiser (ids stripped), with nonce
CSP, no-referrer, noindex, per-IP rate limiting and no cookies. Every API route must have a deny-case test
(`denies('<METHOD> <route>')` marker) or an explicit public-route entry — enforced in CI. Sharing changes
(visibility, token, share_transcript) do not bump the document content `version` (D-19 conflict detection is
about content), so toggling sharing never creates a conflicted copy.

## D-26 · 2026-11-14 · accepted · agent
Enhance details (from 4.4): block origin = fuzzy match of output blocks to the user's note lines (similarity
≥ 0.85 → `me`), never trusted from the model; user lines the model drops are re-inserted under "Other notes".
One run per document (Postgres advisory lock + Redis lock), idempotency keys, SSE stream with a Redis event log
for `Last-Event-ID` resume, 2-min run timeout / 3-min staleness. If the user edited the note during a run, their
body wins and the output is stored with `applied: false` ("Use enhanced version"). Indexing needs no hook — it
follows change_log (D-22).

## D-27 · 2026-11-14 · accepted · agent
Assistant (from 6.2/6.3): tools re-check permissions per row and ignore share tokens; citations are allowed only
for ids returned by tools in the current turn (filtered in-stream); `updateDocument` only creates proposals that
the thread owner approves (applied at baseVersion inside the locking transaction). The server ignores
client-supplied history. Per-user chat rate limit 20/min, 500/day. Known trade-off: tool outputs already stored
in a thread stay in its history after the user later loses access to that note (threads are private to their
owner; revisit with retention settings).

## D-28 · 2026-11-14 · accepted · agent
Desktop local store (from 2.6): built-in `node:sqlite` (no native rebuild; WAL works in Electron 45's Node 24).
One database file per signed-in user; switching accounts keeps the previous user's file and is refused while
recording. The cache is wiped only on genuine corruption / too-new schema / failed migration, never on
transient errors. Audio recording metadata lives in a separate, never-wiped index next to the audio folder (D-10,
D-24). Outbox entries that the server rejects or that can't be sent are parked (visible in sync status), never
silently dropped and never allowed to block the queue.

## D-29 · 2026-11-15 · accepted · agent
Durable/background agents (resolves D-7 after the 8.2 spike + review): use **eve**, pinned to an exact version,
for durable pipelines. Fixed pipelines (post-meeting: enhance → index → integrations) are plain
`"use workflow"`/`"use step"` functions with **idempotent step bodies** started by our own route; model-driven
eve sessions only where a model must decide. Guardrails:
- D-11: `EVE_TELEMETRY_DISABLED=1` everywhere; the build-time model catalog is pre-written locally (no fetch).
  No other phone-home found (reviewed). Workflow state in its own Postgres DB (`oat_workflow`), never the app DB
  (fail fast if unset). Lock-stale window 30 s (above the world's renewal interval).
- `/jobs/*` contract: the web app authorises the user against the meeting via `@oat/core` before calling; the
  body carries `workspaceId` and the agent rejects mismatches; service token ≥ 32 random bytes with
  current+previous accepted for rotation; the agents server is never public.
- Run log in our own storage. Prod world is deferred to 9.6 (Postgres world needs a long-running process;
  Vercel Workflow untested). Fallback: the idempotent steps run as one 6.1 worker job.
- Revisit trigger: if an eve upgrade strands runs or costs more than a day of work in a milestone, drop to the
  6.1 Redis worker.
- Layering: agents must not import `apps/*`; services move into packages (8.3), enforced by lint.

## D-30 · 2026-11-15 · accepted · agent
Local audio belongs to the account that recorded it (refines D-10/D-28): the audio index records the
recording account's user id; Storage settings list, delete and the retention sweeper act only on the signed-in
account's recordings; retention policy is per account per Mac. Recordings of other accounts on the same Mac are
shown only as an aggregate "Other accounts: N GB" with no actions.

## D-31 · 2026-11-15 · accepted · agent
Notes from calendar events (from 7.3): `meeting.calendar_event_id` holds the **meeting key**
(`calendarEventKey`, `@oat/calendar`): `ical:<iCalUID>@<start ISO>` when the event has a UID, else the source's
event id — so the same invite seen through EventKit (desktop) and Google (web) maps to one note, matching the
`mergeCalendarEvents` rule (all-day events key by start date, `ical:<UID>@YYYY-MM-DD`; a rescheduled occurrence
gets a new key — its earlier note no longer matches, accepted). A note made from an event keeps `started_at`/`ended_at` empty until a recording
starts (`started_at` stays "recording start"; nothing looks "in progress" and the post-meeting trigger on
`ended_at` is not fired); its scheduled time and join link are read from the calendar by key while the calendar
has the event (no schema change). Such a never-recorded meeting of **mine** may be recorded on any of my Macs (D-24
refined: no start and no transcript = nothing to continue); a teammate's never-recorded note is not (theirs to
start) — "Start notes" makes my own. The web resolves the event server-side from the user's own
calendar and never trusts client-sent titles/attendees; reuse requires `canReadDocument`.

## D-32 · 2026-11-20 · accepted · human
Web recording supports meetings held in a browser tab: microphone = "me", shared tab audio = "them".
Audio stays on the recording device in browser storage (OPFS), never uploaded or synced. This extends
D-10 without changing it; desktop remains the capture path for native call apps. Implementation is split:
step A adds browser capture, live STT and transcript sync; step B adds the local archive and playback.

## D-33 · 2026-11-21 · accepted · human
UI redesign direction: a Granola-inspired calm layout, described in
`research/granola/ui-design.md`, with Oat's own visual identity (clean-room rules still apply).
Self-host Geist Mono through Fontsource for all mono roles. Headings, page/document titles and UI/body
text stay Inter. Newsreader remains available for editor blockquotes only. Per human feedback, no serif
display-title roles are introduced. Layout changes follow in later PRs.

## D-34 · 2026-11-21 · accepted · human
CI has two tiers (refines D-12; `pnpm run ci` is still the local gate). The human asked for PR CI under 3 min
wall clock. The **PR gate** is the `--fast` steps (format, actionlint, typecheck, lint, unit) as 3 parallel GitHub
jobs, each running `pnpm run ci --only …` with its own turbo cache. The **full** `pnpm run ci` (stack, migrate,
test:int, e2e; ~15 min) runs on every push to `main` and on demand (`workflow_dispatch`, any branch), not on PRs.
Why: in 55 runs, e2e + test:int were ~90 % of the time and caused most red runs (8 of 14 were flakes). The
real e2e catches (axe contrast/a11y, specs broken by UI changes) still run post-merge and on demand. Revisit when
web e2e is sharded or runs against a production build fast enough for PRs. Evidence: `docs/tasks/ci-fast-gate.md`.

## D-35 · 2026-11-21 · accepted · agent
Auth and setup use an unboxed ~360px centered column with a small Oat mark and one primary action per
step. Dialogs retain the ziiz modal material, share a plain Inter heading hierarchy, and use ghost
cancel actions. Sharing remains immediate-save with Done, not a misleading cancel/undo affordance.
Passwordless signup is still first sign-in; no password/reset routes or web onboarding wizard are
invented. Security warnings and permission guidance take precedence over shortening helper copy.

## D-36 · 2026-11-21 · accepted · human
One kind of workspace; no personal workspace (supersedes the "personal + team workspaces" part of D-2's scope
and SPEC §4/§5/§6 wording). The human found two ways to be private (a personal workspace *and* `private`
visibility inside a workspace) confusing. Privacy is now only per item: every workspace has **Private** (my
`private` notes and folders, D-18 unchanged) and **Shared** (`workspace` / `link`), like Notion.
- **Sign-up:** after the first verified sign-in a user either joins an existing workspace or gets one created.
  With no invite and no joinable workspace, a workspace named "<First name>'s workspace" is created silently
  (no form); it is an ordinary workspace — they can rename it, invite people, or delete it later.
- **Finding a workspace by email domain:** a workspace may list allowed email domains. Only verified emails
  match; public mailbox domains (gmail.com, outlook.com, …, a list in `@oat/core`) can never be listed; an
  owner/admin may only add the domain of their own verified email.
- **Join policy** (per workspace, owner/admin setting): `invite_only` (default) · `request` (matching-domain
  users ask; owner/admin approves and picks the role) · `auto_join` (matching-domain users join as `member`).
- **Leaving / removal (human chose "company owns it" + export):** a removed or departing member loses access to
  everything in that workspace, including their private notes (as today). They can export their own notes
  (Markdown) before leaving; the leave dialog offers it. Admins still cannot read other members' private notes.
  What happens to orphaned private notes afterwards (retention/purge) is unchanged and stays a later task.
- **Agent refinements (reversible):** while a user has one workspace the workspace menu shows no workspace list or
  selector arrows (the menu itself stays, so settings, invite, create and join remain reachable); the last workspace
  a user belongs to can't be left or deleted without first creating/joining another (no account is ever
  workspace-less); where the desktop used to fall back to Personal (recording while the active workspace is
  view-only), it falls back to the first workspace the user can create in, else asks them to create one.
- **Migration:** existing `personal` rows become ordinary workspaces in place (same id, so no document moves),
  renamed from "Personal" to "<First name>'s workspace"; `kind` and its constraints are dropped.
