# Local development

Development is fully containerised and offline (D-11): one command starts every external dependency in
Docker, with local stand-ins for every third-party API. No API keys, no accounts, no calls to external
services. The desktop app and the Swift sidecar run natively on macOS and talk to the containers.

## Prerequisites

- Docker Desktop (or Docker Engine + the compose plugin, v2.20+)
- Node.js ≥ 22.13 (see `.nvmrc`)
- pnpm (`corepack enable` picks up the version pinned in `package.json`)

## New machine in 3 commands

```bash
pnpm install
pnpm dev:up      # creates .env from .env.example if missing, starts the stack, waits until healthy
pnpm dev         # app dev servers (everything except the mocks, which already run in Docker)
```

The first `dev:up` pulls images and builds three small local images (postgres, oauth, mocks), so it needs
network once; after that everything works offline.

## Commands

| Command          | What it does                                                                     |
| ---------------- | -------------------------------------------------------------------------------- |
| `pnpm dev:up`    | `docker compose up -d --wait`; exits 0 only when every service is healthy. Builds the local images only if they don't exist yet and never rebuilds them, so running containers are left alone (compose only recreates a service whose `docker-compose.yml` definition differs). Safe from any worktree. |
| `pnpm dev:build` | `up -d --wait --build`: rebuilds the local images (postgres, oauth, mocks) from *this* checkout and recreates changed containers. Run it from the **main checkout** after merging changes to `docker/` or `tools/mocks`. |
| `pnpm dev:down`  | Stops and removes the containers. Data volumes are kept.                         |
| `pnpm dev:reset` | `down --volumes`: also wipes Postgres, Redis and Mailpit data (dev data only).   |
| `pnpm dev:logs`  | Follows logs. `pnpm dev:logs mocks` for one service.                             |
| `pnpm dev:ps`    | Service status and health.                                                       |

Extra arguments are passed to `docker compose` (e.g. `pnpm dev:up postgres`). The scripts live in
`scripts/dev.mjs`. The compose project is always called `oat`, so all git worktrees share one stack; run plain
`docker compose …` commands from the repo root (e.g. `docker compose exec postgres psql -U oat`).

**Shared stack rules.** One stack serves every worktree, so: `dev:up` is the only stack command task branches
run; `dev:build` and `dev:reset` happen from the main checkout (they recreate containers / wipe data that
other runs are using). Changes to `docker-compose.yml` or `docker/` reach the shared stack only once merged to
`main` and built there. To test unmerged mocks code, use the in-process mocks (below), not the container.

## Services

All ports bind to `127.0.0.1` and sit in a private range so they don't clash with other local stacks.

| Service    | Image / source                                       | Host port                 | Stands in for                        | Env var(s)                        |
| ---------- | ---------------------------------------------------- | ------------------------- | ------------------------------------ | --------------------------------- |
| `postgres` | `pgvector/pgvector:0.8.7-pg17` + `docker/postgres`   | 54329                     | Neon                                 | `DATABASE_URL`                    |
| `redis`    | `redis:7.4.12-alpine`                                | 63790                     | Upstash / managed Redis              | `REDIS_URL`                       |
| `mailpit`  | `axllent/mailpit:v1.33.1`                            | SMTP 11025, UI/API 18025  | Transactional email provider         | `SMTP_*`, `MAILPIT_URL`           |
| `oauth`    | `ghcr.io/navikt/mock-oauth2-server:7.0.0` + `docker/oauth` | 18089               | Google OAuth / OIDC                  | `OAUTH_GOOGLE_*`                  |
| `mocks`    | `tools/mocks` (`@oat/mocks`)                         | 14010                     | AI Gateway, Deepgram, Notion, GCal   | `MOCKS_URL`, `AI_*`, `DEEPGRAM_*` |

- **Postgres**: database/user/password all `oat`. `vector` and `pg_trgm` are enabled in `oat` and in
  `template1`, so every database created later has them too. Connect: `docker compose exec postgres psql -U oat`.
- **Mailpit**: open <http://localhost:18025> to see every email the app sends. Any SMTP credentials are accepted.
- **OAuth**: issuer `http://localhost:18089/google`; any client id/secret is accepted. The sign-in page asks
  for an email (becomes `sub` and `email`, with `email_verified: true`), plus optional name and picture.
  Tests skip the page: `POST` the form fields `username` and `claims` (JSON) to the authorize URL and follow
  the 302 (see `packages/testkit/src/stack.int.test.ts`). Form claims can add `name`/`picture` but can't
  override `email`.
- No config is bind-mounted from the repo: the postgres init script and the oauth config are baked into small
  local images (`docker/*/Dockerfile`), so the shared stack keeps working after the worktree that built it is
  deleted. Run `pnpm dev:build` (from main) after they change.
- **OAuth issuer and Host header**: mock-oauth2-server derives the issuer from the request's Host header. Code
  on the host reaches it as `localhost:18089`, matching `OAUTH_GOOGLE_ISSUER`. A container (e.g. `web` in
  1.9) calling `http://oauth:8080` would see a different `iss`; it must use the same public URL (or the
  issuer must be pinned) so tokens validate.

## How mocks work (`tools/mocks`)

`@oat/mocks` is a small Hono service. Each third-party API is a *provider* in `src/providers/<name>.ts`,
mounted under `/<name>` and registered in `src/providers/index.ts` (today only `example`; `llm`, `stt`,
`gcal`, `notion` arrive with the tasks that need them). A provider is a Hono sub-app plus optional
`websockets` routes (raw `ws` sockets, e.g. a Deepgram-style streaming endpoint; see the `/example/ws` echo)
and an optional `reset()`. Built-in routes:

| Route                          | Purpose                                                                    |
| ------------------------------ | -------------------------------------------------------------------------- |
| `GET /health`                  | `{ status: "ok", providers: [...] }`                                       |
| `GET /_requests`               | Ring buffer (last 500) of provider calls and websocket upgrades: method, path, query, headers (credentials redacted), body, status. Filters: `?provider=llm&since=<id>&limit=<n>`. |
| `POST /_reset?provider=<name>` | Clears that provider's log entries and in-memory state only.               |
| `POST /_reset`                 | Clears everything. For humans; never from tests against the container.     |

### Container vs in-process

- **The container** (`:14010`, `MOCKS_URL`) is what `pnpm dev` and the apps talk to. It runs whatever was
  last built with `pnpm dev:build` (normally `main`) and is shared by every worktree, so its state and request
  log are shared too.
- **In-process (`startMocks()`)**: integration tests for a provider, or for code that calls one, start their
  own instance on a random port. It runs the code in *your* checkout, has private state, and needs no
  container:

  ```ts
  import { startMocks, type RunningMocks } from '@oat/mocks';
  let mocks: RunningMocks;
  beforeAll(async () => { mocks = await startMocks(); });   // mocks.url, mocks.log
  afterAll(() => mocks.close());
  ```

  Pass `mocks.url` wherever the code under test takes its base URL (`MOCKS_URL`). Assert calls with
  `mocks.log.list({ provider: 'llm' })` (or `GET ${mocks.url}/_requests`).
- If a test must use the container, find *your* calls in `/_requests` by a unique value you sent and only
  ever use the scoped `/_reset?provider=<name>`.

Adding a provider: copy `src/providers/example.ts`, keep state inside the factory, implement `reset()`, add
it to `defaultProviders`, unit-test HTTP routes with `app.request()` and websockets with `startMocks()`. Run
the service natively while developing:

```bash
MOCKS_PORT=14011 pnpm --filter @oat/mocks dev   # tsx watch; point MOCKS_URL at it (the container keeps :14010)
```

## Switching a provider to the real thing

Every integration is selected by env: a base URL plus a key. With the key blank, code uses the mock at
`MOCKS_URL`; with a key set, it talks to the real provider. No code changes.

| Integration | Real setup in `.env`                                                                    |
| ----------- | --------------------------------------------------------------------------------------- |
| AI Gateway  | `AI_GATEWAY_API_KEY=...` (`AI_GATEWAY_BASE_URL` only to override the default)           |
| Deepgram    | `DEEPGRAM_API_KEY=...` (`DEEPGRAM_BASE_URL` only to override the default)               |
| Google      | `OAUTH_GOOGLE_ISSUER=https://accounts.google.com`, real `OAUTH_GOOGLE_CLIENT_ID/SECRET` |
| Postgres    | `DATABASE_URL=<Neon URL>` (prod only)                                                   |

Real credentials are human checkpoints (FACTORY §7) and never go in `.env.example`. Real-provider smoke
tests run only when their key is set.

**Who reads the root `.env`.** Integration tests do: `vitest.shared.ts` loads it in `--mode int` (variables
already exported in the shell win). Compose only uses it for interpolation (it has none today). Apps don't
read it yet: `apps/web` (1.6/1.9) and `apps/desktop` must load the root `.env` themselves when they are wired
up (Next.js on its own only reads `apps/web/.env*`). Until then, editing `.env` affects tests only.

## Tests

- `pnpm test`: unit tests, in-process fakes, no containers.
- `pnpm test:int`: `*.int.test.ts`, needs `pnpm dev:up`. Use `@oat/testkit`:
  - `createTestDatabase()` → `{ name, url, drop() }`: a fresh `oat_test_<timestamp>_<random>` database
    per run, so parallel runs never collide. Always `drop()` in `afterAll`. It refuses any non-loopback
    Postgres host (so a stray `DATABASE_URL=<Neon>` can't be touched) unless `OAT_TESTKIT_ALLOW_REMOTE_DB=1`.
    Once per process it also sweeps leaked `oat_test_*` databases older than an hour
    (`sweepStaleTestDatabases()`).
  - `createMailpit()` → `waitForLatest(address)`, `latestFor`, `listFor`, `get`, `delete`; plus
    `uniqueAddress()` and `extractFirstLink(message)` for magic-link flows.
  - `waitFor(fn, { timeout, interval })` polls until `fn` returns a value.
  - `startMocks()` from `@oat/mocks` for provider tests (see "Container vs in-process").
  - Defaults match the compose ports; the root `.env` and exported shell vars override them.

## Troubleshooting

- **Port already allocated** on `dev:up`: something else uses one of 54329, 63790, 11025, 18025, 18089,
  14010. Find it with `lsof -nP -iTCP:<port> -sTCP:LISTEN` (macOS) or `ss -ltnp 'sport = :<port>'` (Linux),
  or `docker ps --format '{{.Names}} {{.Ports}}'`,
  and stop it. The ports are fixed by D-11; don't change them locally.
- **A service never gets healthy**: `pnpm dev:ps`, then `pnpm dev:logs <service>`.
- **Init script changes don't apply**: Postgres runs `docker/postgres/init` only on an empty volume, so run
  `pnpm dev:build` then `pnpm dev:reset && pnpm dev:up` (from the main checkout).
- **Strange data / start from scratch**: `pnpm dev:reset` wipes the dev volumes (Postgres, Redis, Mailpit).
  It also kills data other worktrees are using, so agents don't run it on the shared stack.
- **Leftover `oat_test_*` databases** from crashed runs are harmless and swept after an hour by the next
  test run; `pnpm dev:reset` removes them all.
- **Mocks/postgres/oauth image is stale**: `pnpm dev:up` never rebuilds. From the main checkout run
  `pnpm dev:build` (force with `docker compose build --no-cache mocks`).
