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

## D-15 · 2026-11-14 · proposed · agent
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
