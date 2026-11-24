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
pnpm dev         # app dev servers + index worker + agents server (the mocks already run in Docker)
```

The first `dev:up` pulls images and builds three small local images (postgres, oauth, mocks), so it needs
network once; after that everything works offline. To prove the whole v1 journey passes from a clean clone on
this machine, run `node scripts/acceptance-fresh.mjs` (see "Acceptance journey" → "Proving it works on a new
machine").

## Commands

The browser-safe typed REST client and injectable transport API are documented in
[`@oat/client`](../packages/client/README.md). It supports web fetch now and a desktop bridge transport
next; no feature UI is wired to it yet.

| Command          | What it does                                                                     |
| ---------------- | -------------------------------------------------------------------------------- |
| `pnpm dev:up`    | `docker compose up -d --wait`; exits 0 only when every service is healthy. Builds the local images only if they don't exist yet and never rebuilds them, so running containers are left alone (compose only recreates a service whose `docker-compose.yml` definition differs). Safe from any worktree. |
| `pnpm dev:build` | `up -d --wait --build`: rebuilds the local images (postgres, oauth, mocks) from *this* checkout and recreates changed containers. Run it from the **main checkout** after merging changes to `docker/` or `tools/mocks`. |
| `pnpm dev:down`  | Stops and removes the containers. Data volumes are kept.                         |
| `pnpm dev:reset` | `down --volumes`: also wipes Postgres, Redis and Mailpit data (dev data only).   |
| `pnpm dev:logs`  | Follows logs. `pnpm dev:logs mocks` for one service.                             |
| `pnpm dev:ps`    | Service status and health.                                                       |
| `pnpm dev:app`   | Profile `app`: builds the `web` + `migrate` + `worker` + `agents` images from *this* checkout, runs migrations, starts the web app on <http://localhost:3000>, the index worker and the agents server (loopback :3100), and waits until they are healthy. See "Web app in Docker". |
| `pnpm dev:app:stop` | Stops and removes the `web`, `worker`, `agents` and `migrate` containers (frees :3000/:3100); the rest of the stack keeps running. |

Extra arguments are passed to `docker compose` (e.g. `pnpm dev:up postgres`). The scripts live in
`scripts/dev.mjs`. The compose project is always called `oat`, so all git worktrees share one stack; run plain
`docker compose …` commands from the repo root (e.g. `docker compose exec postgres psql -U oat`).

**Shared stack rules.** One stack serves every worktree, so: `dev:up` (and `dev:app`, which only builds and
recreates its own two containers) are the only stack commands task branches run; `dev:build` and `dev:reset` happen from the main checkout (they recreate containers / wipe data that
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
| `mocks`    | `tools/mocks` (`@oat/mocks`)                         | 14010                     | AI Gateway, Deepgram, Notion, GCal   | `MOCKS_URL`, `AI_*`, `DEEPGRAM_*`, `GOOGLE_CALENDAR_BASE_URL`, `NOTION_*` |

- **Postgres**: database/user/password all `oat`. `vector`, `pg_trgm` and `unaccent` are enabled in `oat` and in
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
  on the host reaches it as `localhost:18089`, matching `OAUTH_GOOGLE_ISSUER`. A container calling
  `http://oauth:8080` would see a different `iss` (and discovery endpoints a browser can't reach), so the
  `web` container keeps the host URL and forwards `localhost:18089` to `oauth:8080` internally (see "Web app
  in Docker").

## Web app in Docker (profile `app`)

`pnpm dev:app` runs the whole web app in containers next to the stack: a new machine can demo Oat with only
Docker, and the production image path gets exercised. Day-to-day development still uses `pnpm dev` (hot
reload); both want port 3000, so stop one before starting the other (`pnpm dev:app:stop`).

```bash
pnpm dev:app                          # build web + migrate from this checkout, migrate, start, wait healthy
curl -s localhost:3000/api/health     # {"ok":true,"version":"0.0.0","db":"ok"}
pnpm dev:logs web                     # follow its logs
pnpm dev:app:stop                     # remove the app containers (stack keeps running)
```

- **Images** (`apps/web/Dockerfile`, build context = repo root): target `web` (default) is Next's
  standalone output (`output: 'standalone'` in `next.config.ts`: `server.js` + only the traced
  `node_modules`; workspace packages are compiled in) on `node:24-alpine`, as the `node` user, with a
  healthcheck on `/api/health`; ~300 MB, most of it the Node base image. Target `migrate` runs
  `packages/db/src/cli/migrate.ts` with Node's built-in type stripping and prod deps only. Dependencies are
  installed from the workspace manifests + lockfile alone, so a source edit reuses the install layer and
  only re-runs `next build`; the pnpm store is a BuildKit cache mount.
- **Startup order**: `migrate` (one-shot, needs healthy Postgres) applies this checkout's migrations to the
  compose `oat` database and exits 0; `web` starts only after that and once postgres, redis, mailpit, oauth
  and mocks are healthy. Migrations from an unmerged branch land in the shared dev database, same as running
  `db:migrate` from that worktree; `db:reset` (from main) undoes it.
- **Env**: set in `docker-compose.yml`, not from `.env` (except real provider keys and the Google
  issuer/client, which compose interpolates from the root `.env`, so real keys work as on the host).
  Server-to-server connections use service names (`postgres:5432`, `redis:6379`, `mailpit:1025`).
  URLs that a browser or the desktop app also uses keep their host form: the image's entrypoint forwards
  `localhost:18089` → `oauth:8080` and `localhost:14010` → `mocks:14010` inside the container
  (`OAT_LOCALHOST_FORWARDS`, `docker/web/entrypoint.mjs`; unset in production), so the OAuth issuer, the
  token `iss` and every discovery endpoint are identical inside and outside the container.
- **Auth in the container**: `BETTER_AUTH_URL` (default `http://localhost:3000`, what the browser uses),
  `BETTER_AUTH_SECRET` (default: the dev secret), `BETTER_AUTH_TRUSTED_ORIGINS` and `AUTH_MAX_TEAM_WORKSPACES`
  are interpolated from the root `.env` with those defaults. The image runs `NODE_ENV=production`; `@oat/auth`
  accepts the dev secret and plain http only because the URL is loopback (a public URL needs https and a
  real secret). Magic links go to Mailpit (`mailpit:1025`), the per-email send limit uses `redis:6379`, and
  Google goes through the forwarded mock issuer, so both sign-in methods work in the container as on the host.
- `/api/health` returns `{ ok, version, db }`, with HTTP 503 when Postgres doesn't answer within 2 s.
- The `oat-web:dev` image is shared by every worktree: it runs whatever the last `dev:app` built. Neither
  `dev:up` nor CI's `stack` step starts the `app` profile.

## How mocks work (`tools/mocks`)

`@oat/mocks` is a small Hono service. Each third-party API is a *provider* in `src/providers/<name>.ts`,
mounted under `/<name>` and registered in `src/providers/index.ts` (today `example`, `llm`, `stt`, `gcal`
and `notion`). A provider is a Hono sub-app plus optional
`websockets` routes (raw `ws` sockets, e.g. a Deepgram-style streaming endpoint; see the `/example/ws` echo,
with an optional `verify()` that can refuse the handshake with an HTTP status) and an optional `reset()`.
Built-in routes:

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

### The `llm` provider (stands in for AI Gateway)

OpenAI-compatible, base URL `${MOCKS_URL}/llm/v1` (what `@oat/ai` uses when `AI_GATEWAY_API_KEY` is blank).
Deterministic: the same request always gets the same content.

| Route                          | Behaviour                                                                  |
| ------------------------------ | -------------------------------------------------------------------------- |
| `POST /llm/v1/chat/completions` | Text: up to three sentences quoted from the last user message. `response_format: json_schema`: schema-valid JSON whose strings are sentences from the user messages (title-ish keys get a short phrase). `json_object`: `{ "text": … }`. `stream: true`: SSE word deltas + `[DONE]`, usage chunk with `stream_options.include_usage`. With `tools` (6.2, `src/providers/llm/tools.ts`): a scripted loop — first a tool call (the first tool with a string `query` parameter, called with the user's message; or exactly `mock:tool <name> <json args>` typed as the message), then, once tool results are in, an answer quoting the first sentence of up to three `{ cite, text }` items in them, each followed by its `cite` marker. |
| `POST /llm/v1/embeddings`      | Feature-hashed unit vectors (words + trigrams): deterministic, similar text → higher cosine. `dimensions` honoured (default 1536), `encoding_format` float/base64. |
| `GET /llm/v1/models`           | The registry's default model ids (any id is accepted).                     |

Scenario headers for resilience tests (pass them per call, e.g. `generateText({ headers })`):
`x-mock-scenario: error` (status from `x-mock-status`, default 500; 429 → `rate_limit_error`),
`x-mock-scenario: slow` (waits `x-mock-delay-ms`, default 1000), `x-mock-scenario: empty` (empty content /
no embeddings), and `x-mock-chunk-delay-ms` (pause between SSE chunks). Unit tests that don't need HTTP use
`createMockModel` / `createMockEmbeddingModel` from `@oat/ai/testing` instead; `createMockChatModel` from
`@oat/ai/chat/testing` runs this provider's code in-process (tool loop included) without a port.

Adding a provider: copy `src/providers/example.ts`, keep state inside the factory, implement `reset()`, add
it to `defaultProviders`, unit-test HTTP routes with `app.request()` and websockets with `startMocks()`. Run
the service natively while developing:

```bash
MOCKS_PORT=14011 pnpm --filter @oat/mocks dev   # tsx watch; point MOCKS_URL at it (the container keeps :14010)
```

### The `stt` provider (stands in for Deepgram)

- `POST /stt/v1/auth/grant` → `{ access_token, expires_in }` (short-lived token, D-17; body `{ ttl_seconds }`
  optional). Any or no API key is accepted.
- `WS /stt/v1/listen?encoding=linear16&sample_rate=16000&…`: binary PCM in, Deepgram `Results` JSON out
  (interim + final, `speech_final`, `start`/`duration`, words; an often-empty interim every second of
  silence), `KeepAlive`/`Finalize`/`CloseStream`, `endpointing=false`, close 1011 after 10 s without audio
  or a message. Auth: `Authorization: Token <any>` or `Bearer <granted token>`
  (or the `token`/`bearer` subprotocol pair); anything else is a 401 on the handshake.
- Transcripts: an energy VAD finds speech; words come from a fixed sentence corpus, or with
  `mock_fixture=<fixture>&mock_channel=mic|system` (+ `mock_offset_ms` after a reconnect) from
  `fixtures/audio/<fixture>.segments.json`, so tests can assert exact text.
- Scenario params (tests/dev tools only, never production code): `drop_after_ms` (+ `drop_times`,
  `mock_session`), `latency_ms`, `reject_auth=1`, `reject_status=<code>` (e.g. 402/429 on the handshake),
  `mock_idle_timeout_ms`. Full list in
  `tools/mocks/src/providers/stt.ts`.
- `POST /stt/v1/listen` (2.7): Deepgram's pre-recorded API subset — WAV (or raw `encoding=linear16`) body →
  `metadata.duration`, `results.channels[0].alternatives[0].words`, `results.utterances` (`utterances=true`).
  Same auth and word sources (`mock_fixture`/`mock_channel`/`mock_offset_ms` = time of the body's first
  sample). The desktop uses it to back-fill STT outages from the local audio archive.
- `POST /stt/_mock/outage {"down": true|false}` (2.7): while down, listen handshakes and batch requests get
  503 and open sockets are dropped ("STT is down for 3 minutes"). `sttProvider({ acceptAnyBearer: true })`
  (in-process only) accepts bearer tokens granted by another mock instance (the desktop e2e).
- `@oat/stt` points at it by default (`resolveDeepgramEndpoints()`, see "Switching a provider" below). The
  container image bundles the fixture ground truth; it gets the provider once `main` is rebuilt with
  `pnpm dev:build`.

### The `gcal` provider (stands in for the Google Calendar API)

Google Calendar API v3 subset at `${MOCKS_URL}/gcal/calendar/v3/…` (what `@oat/calendar/google` uses when
`GOOGLE_CALENDAR_BASE_URL` is blank and sign-in isn't real Google). Data: the week in
`fixtures/calendar/week.json` (3 calendars, ~17 events incl. recurring instances, a moved occurrence, all-day
events, Meet/Zoom/Teams links, a cancelled meeting), converted to Google's shapes. Full reference in
`tools/mocks/src/providers/gcal/index.ts`.

| Route                                                  | Behaviour                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| `GET /gcal/calendar/v3/users/me/calendarList`          | The fixture calendars (`cal-work` is `primary`), paginated. |
| `GET /gcal/calendar/v3/calendars/{id}/events`          | `singleEvents=true` (required), `timeMin`/`timeMax` (RFC 3339 with offset), `orderBy`, `showDeleted`, `maxResults`/`pageToken`, `syncToken` (changes since, deletions as `cancelled`; **410 `fullSyncRequired`** when stale). `primary` alias. |
| `GET` / `PATCH` / `DELETE` `…/events/{eventId}`, `POST …/events` | Read one / change / delete (→ `cancelled`) / insert: tests use these to change data between syncs. |
| `POST /gcal/_mock/expire-sync-tokens`                  | Every sync token → 410 from now on.                          |
| `POST /gcal/_mock/revoke-token` `{ "token": "…" }`     | That bearer gets 401 from now on (refresh tests).            |

- **Auth:** `Authorization: Bearer <token>` required (401 without). Any non-empty token works in dev, except a
  JWT whose `exp` has passed or a revoked token (401 `authError`) and a JWT with a `scope` claim lacking a
  calendar scope (403 `insufficientPermissions`). The mock OIDC issuer's tokens carry no `scope` claim.
- **Dates:** by default the fixture week is shifted by whole weeks (wall-clock time per event zone) so its
  Monday is the first Monday after now: there are always upcoming meetings to look at. `GCAL_MOCK_ANCHOR=fixture`
  on the container (or `gcalProvider({ anchor: 'fixture' })` in-process) serves the fixture's own dates
  (Mon 16 – Fri 20 Nov 2026), which the normaliser parity tests use.
- The container gets the provider (and bundles `week.json`) once `main` is rebuilt with `pnpm dev:build`;
  until then int/e2e tests use their own in-process instance (`apps/web/e2e/web-server.ts` starts one).

### The `notion` provider (stands in for the Notion API)

Notion public API subset, version `2022-06-28`, at `${MOCKS_URL}/notion/v1/…` (what `@oat/integrations-notion`
uses when `NOTION_OAUTH_CLIENT_ID` is blank). Full reference in `tools/mocks/src/providers/notion/index.ts`.

| Route                                                  | Behaviour                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| `GET /notion/v1/oauth/authorize`                       | Auto-approves (dev): 302 to `redirect_uri?code&state`. Needs `client_id`, `response_type=code`. |
| `POST /notion/v1/oauth/token` / `…/oauth/revoke`       | HTTP Basic client auth; single-use codes bound to the redirect URI; tokens `ntn_mock_…`. Revoked tokens get 401. |
| `POST /notion/v1/search`                               | Seeded workspace "Oat Mock Notion": pages Team Home, Meeting notes, Scratchpad; databases Meetings (Name, Date, Attendees, Oat link, Tags) and Reading list. Plus whatever was created. `filter`, `query`, paging. |
| `GET /notion/v1/databases/{id}`, `GET /notion/v1/pages/{id}` | Schema / page (archived pages still readable, `archived: true`). |
| `POST /notion/v1/pages`, `PATCH /notion/v1/pages/{id}` | Create under a page (title only) or database (typed properties); update properties / archive. |
| `GET` / `PATCH /notion/v1/blocks/{id}/children`, `DELETE /notion/v1/blocks/{id}` | List (paged) / append (`after`) / archive blocks. |
| `GET /notion/_mock/view/{id}`                          | HTML rendering of a page: the `url` of every page, so "Open in Notion" works offline. |
| `GET /notion/_mock/pages/{id}/tree`, `POST /notion/_mock/revoke-token`, `POST /notion/_mock/rate-limit` | Test controls: live block tree; revoke a token; next N calls → 429 + `Retry-After`. |

- **Validation like Notion's:** `Notion-Version` required (400 `missing_version`; other versions refused),
  block types/shapes, ≤ 2000 characters per rich-text item and link URL, ≤ 100 rich-text items, ≤ 100 blocks
  per children array, two levels of nesting, ≤ 1000 blocks / 500 KB per request; failures are 400
  `validation_error` with the offending path. Errors are `{ object: 'error', status, code, message }`.
- **Auth:** `Authorization: Bearer ntn_mock_…`; any token with that prefix is accepted unless revoked (so a
  stored dev token survives a container restart), anything else is 401 `unauthorized`.
- The container gets the provider once `main` is rebuilt with `pnpm dev:build`; until then int/e2e tests use
  their own in-process instance (`apps/web/e2e/web-server.ts` sets `NOTION_BASE_URL`).

## Switching a provider to the real thing

Every integration is selected by env: a base URL plus a key. With the key blank, code uses the mock at
`MOCKS_URL`; with a key set, it talks to the real provider. No code changes.

| Integration | Real setup in `.env`                                                                    |
| ----------- | --------------------------------------------------------------------------------------- |
| AI Gateway  | `AI_GATEWAY_API_KEY=...` (`AI_GATEWAY_BASE_URL` only to override the default). On Vercel (`VERCEL`/`VERCEL_OIDC_TOKEN` set) without a key, the gateway uses Vercel OIDC. Otherwise `AI_BASE_URL` (default `${MOCKS_URL}/llm/v1`); with `NODE_ENV=production` and none of these set, `@oat/ai` throws `AiConfigError` instead of using localhost. Models per role: `AI_MODEL_ENHANCE/CHAT/FAST/EMBED` |
| Deepgram    | `DEEPGRAM_API_KEY=...` (`DEEPGRAM_BASE_URL` only to override the default)               |
| Google      | `OAUTH_GOOGLE_ISSUER=https://accounts.google.com`, real `OAUTH_GOOGLE_CLIENT_ID/SECRET`; register the redirect URIs `${BETTER_AUTH_URL}/api/auth/callback/google` (sign-in) and `${BETTER_AUTH_URL}/api/auth/callback/google-calendar` (Connect Google Calendar), enable the Google Calendar API and add the `calendar.readonly` scope to the consent screen. Calendar reads then go to `https://www.googleapis.com` automatically (`GOOGLE_CALENDAR_BASE_URL` only to override) |
| Notion      | `NOTION_OAUTH_CLIENT_ID/SECRET` of a Notion *public* integration (capabilities: read + insert + update content), redirect URI `${BETTER_AUTH_URL}/api/integrations/notion/callback`. The API then goes to `https://api.notion.com` (`NOTION_BASE_URL` only to override). In production with nothing set, Notion is hidden ("Not available") |
| Email       | `SMTP_HOST/PORT/USER/PASSWORD/FROM` of the real provider (port 465 = implicit TLS)        |
| Auth        | `BETTER_AUTH_URL=https://<public origin>`, `BETTER_AUTH_SECRET=<openssl rand -base64 32>`; with `NODE_ENV=production` on a non-loopback URL the dev secret and plain-http URLs (app or OAuth issuer) are refused |
| Postgres    | `DATABASE_URL=<Neon URL>` (prod only)                                                   |

Real credentials are human checkpoints (FACTORY §7) and never go in `.env.example`. Real-provider smoke
tests run only when their key is set.

**Who reads the root `.env`.** Integration tests do: `vitest.shared.ts` loads it in `--mode int` (variables
already exported in the shell win). `apps/web` does in `next dev`/`next build` (`next.config.ts`). Compose uses
it only for interpolation: the `web` container takes the provider keys and Google issuer/client from it, and
nothing else (see "Web app in Docker"). `apps/desktop` loads it itself in dev builds (main process,
`process.loadEnvFile`, shell vars win); a packaged app never reads it.

## Signing in locally (`@oat/auth`)

Better Auth (D-9) runs inside `apps/web` at `/api/auth/*`; its config lives in `packages/auth`. With the
`.env.example` defaults, both sign-in methods work offline:

- **Email link:** enter any address on `/sign-in`; the link arrives in Mailpit (<http://localhost:18025>; the
  "Check your email" screen links there in dev). It opens `/sign-in/confirm`, where "Continue to Oat"
  POSTs the token (`/api/sign-in/magic-link`, same-origin only), so mail scanners that prefetch links can't
  use it up. Links are single-use and expire after 15 minutes; at most 5 are sent per address per 15 minutes
  (counted in Redis at `REDIS_URL`, in memory without it), on top of Better Auth's per-IP limit.
- **Continue with Google:** goes to the mock issuer's login page (`localhost:18089`); type any email (and
  optionally a name) and you're back, signed in. Same email as a magic-link account → the Google account is
  linked to it.
- **Connect Google Calendar** (Settings → Integrations): a separate, link-only grant (`google-calendar`
  provider: `calendar.readonly`, offline) stored on its own `account` row, so sign-in keeps minimal scopes. On
  the mock login page type **the email you're signed in with** (Better Auth only links a Google account with
  the same verified email). Home then lists the next five events from the `gcal` mock (Google-only
  working-location / out-of-office / focus-time blocks are left out). Disconnect revokes the grant at the
  issuer and deletes the row. Better Auth's `/get-access-token`, `/refresh-token` and `/account-info` routes
  are disabled over HTTP: provider tokens never reach a browser (the server uses `auth.api`).
- **OAuth tokens are encrypted at rest** (XChaCha20-Poly1305, key derived from the auth secret). Rotate the
  secret with `BETTER_AUTH_SECRETS="2:<new>,1:<old>"` (versioned, newest first; keep `BETTER_AUTH_SECRET` as
  the legacy fallback until old data is gone): new writes use the newest, old values still decrypt.
  Changing `BETTER_AUTH_SECRET` alone signs everyone out and makes stored Google tokens undecryptable
  (calendar shows "Reconnect").
- **Connect Notion** (Settings → Integrations, per Oat workspace: the active one): "Connect Notion" posts to
  `/api/integrations/notion/connect`, which redirects to Notion's consent page (the mock approves at once) with
  a signed, short-lived state cookie; the callback stores the token encrypted on the `integration` row
  (`@oat/auth` `encryptSecret`, same key and rotation as the OAuth tokens above). Then choose a page or
  database to send notes to; on a note, "Send to Notion" creates the page and "Update in Notion" replaces its
  content. Open the result through the "In Notion" link (the mock's HTML view in dev).
- There is **one kind of workspace** (D-36). A new user who has no pending invitation gets one of their own,
  named "<First name>’s workspace" ("My workspace" without a name), as its owner (`@oat/auth`
  `ensureFirstWorkspace`); an invited newcomer joins the inviting workspace instead. Each new session starts
  in the workspace the user last switched to, else the one they have belonged to longest. Create more from
  the workspace switcher (at most `AUTH_MAX_TEAM_WORKSPACES`, default 20, per user, on top of the first). A
  user's last workspace can't be left or deleted (`@oat/core` permissions).
- Protected pages (`/home`, `/d/*`, `/settings`, `/templates`) redirect to `/sign-in?next=…` without a
  session: `src/proxy.ts` checks the cookie, `(app)/layout.tsx` validates it.
- The desktop app (1.8) authenticates with `Authorization: Bearer <token>` (the signed token from the
  `set-auth-token` response header); unsigned tokens are rejected. How it gets one: "Desktop app" below.

**Web e2e** (`pnpm --filter @oat/web e2e`, needs `pnpm dev:up`) starts `next dev` through
`apps/web/e2e/web-server.ts`, which creates a throwaway `oat_test_*` database, migrates it, and drops it on
exit, so e2e sign-ups never land in the shared `oat` database. Pick a free port per worktree with
`E2E_PORT=3107`. A `setup` project signs one user in by magic link and the other specs reuse its cookies;
`auth.spec.ts` covers both sign-in methods with fresh users. `E2E_SCREENSHOTS=1 … playwright test auth`
writes the 1.6 evidence screenshots.

## Desktop app (`apps/desktop`)

Electron + electron-vite (D-5), macOS first. `pnpm --filter @oat/desktop dev` starts the Vite dev server for
the renderer and launches Electron (it is also part of `pnpm dev`); `pnpm --filter @oat/desktop build`
writes `out/` (`out/main` ESM, `out/preload/index.cjs`, `out/renderer`). Run the web app too (`pnpm dev` or
`pnpm dev:app`): the desktop signs in against it and calls its API.

- **Layout.** `src/main` (main process: windows, IPC handlers, main-owned state store, sign-in, API client),
  `src/preload` (exposes `window.oat`), `src/renderer` (React + `@oat/ui`; one bundle, the URL hash picks the
  window: `#/main`, `#/widget`). Built renderer files are served from `app://oat/` (CSP header, no
  `file://`); in dev from the Vite server.
- **IPC.** The contract is `packages/core/src/bridge.ts` (zod schemas for `invoke` / `send` / `subscribe`
  channels). Add a channel there, then register it in `src/main/index.ts` with `bridge.handle`/`bridge.on`
  (`src/main/ipc.ts` checks the sender is our renderer's main frame and validates the payload) and call it
  from the renderer with `call('<channel>')` (`src/renderer/src/bridge.ts`). Invoke results are
  `{ ok: true, value } | { ok: false, error: { code, message } }`.
- **Shared live state.** `MainStore` in main (auth status, recording placeholder, active meeting) with a
  `seq` per change, pushed to every window; components read it with `useMainState()`.
- **Sign-in.** "Sign in with your browser" opens `${OAT_WEB_URL}/desktop/sign-in?state=…&challenge=…`; after
  the normal web sign-in, "Continue to the app" opens `oat://auth?code=…&state=…`; main checks `state`,
  exchanges the code + PKCE verifier at `/api/auth/desktop/token` for a bearer token and stores it with
  `safeStorage` (`<userData>/session.bin`; Keychain key "Oat Dev Safe Storage" in dev). The renderer never
  sees the token. Sign out revokes the session on the server. Details: `docs/tasks/1.8-desktop-shell.md`.
- **`oat://` in dev.** The dev app registers the Electron binary + this checkout as the `oat://` handler
  while it runs and unregisters on quit (`OAT_REGISTER_PROTOCOL=0` turns that off). On macOS the stock
  Electron.app doesn't declare the scheme, so the browser may not hand the link over; then use "Copy link
  for the app (dev)" on the web page and paste it into the app's "Paste the link" field (same checks). Both
  are **development only**: the web page offers the copy button only outside production (`NODE_ENV`, and
  `OAT_DESKTOP_DEV_HANDOFF=0` turns it off; `=1` is refused in production), and only an unpackaged app shows
  (and accepts) the paste field. A copyable sign-in code is a phishing target, so releases never have one.
- **Env (dev builds only; a packaged app ignores all of them).** `OAT_WEB_URL` (default `BETTER_AUTH_URL`,
  then `http://localhost:3000`; https required except on localhost), `OAT_USER_DATA_DIR` (separate profile;
  also gives a separate single-instance lock), `OAT_E2E=1` (windows don't take focus, no protocol
  registration), `OAT_DEVTOOLS=1` (devtools in a built renderer; forced off when packaged). Dev builds are named "Oat Dev" (own
  userData folder and Keychain key). `OAT_AUDIO_BIN` is honoured only when not packaged
  (`src/main/sidecar.ts`). `OAT_AUDIO_SOURCE` picks the recording input: `sidecar` (default, live mic +
  system audio), `synthetic` (the sidecar's tone generator: no devices, no permission prompts) or
  `file:<fixture>` (replays `fixtures/audio/<fixture>.wav` in real time through `FileSource`; against the
  local mock the transcript is the fixture's ground truth; the e2e default). `OAT_STT_URL` replaces the
  live-transcription websocket the API names (e2e points it at a closed port to test "transcription down").
  `OAT_SYNC_URL` sends `/api/sync/*` to another origin than `OAT_WEB_URL` (same https/loopback rules; e2e
  points it at a dead port, then starts a proxy there, to test offline → drain).
- **Calendar notes + detection (7.3).** The sidebar's "Upcoming" merges the Mac's calendars with Google Calendar
  (through `/api/calendar/upcoming`); clicking an event makes (or reopens) its meeting note. Meeting detection
  shows a "Start notes?" banner + native notification. In dev both Mac sources are **off** unless asked for:
  `OAT_CALENDAR=off|eventkit|fixture:<file>` (`eventkit` = the real calendars via the sidecar — granting access is
  a human checkpoint; a fixture is a JSON array of normalised events, `{ "access", "events" }`, or `.jsonl`) and
  `OAT_DETECTION=off|sidecar|fixture:<timeline.json>` (`sidecar` = real `mic-apps watch`, a human checkpoint; a
  fixture replays a `fixtures/detection/*.json` timeline's `steps[].micApps` in process from sign-in). Packaged
  builds always use EventKit + the sidecar. e2e never shows a real notification (recorded on
  `globalThis.__oatNotifications`). Silenced apps: `<userData>/detection.json`. Details:
  `docs/tasks/7.3-calendar-notes.md`.
- **Auto-stop + auto-enhance (7.5).** While recording, `@oat/detection`'s `autoStop` rules watch detection's
  call spans, the calendar and the audio levels: a call that ends within ±5 min of its event's end → "Stopping the
  recording in 10 s · Keep recording" toast, then stop (every end must hold 30 s first; the app coming back
  = the call resumed); other ends of *this recording's* call, and 10 min of
  silence → "Meeting over? Keep going / Stop recording"; never in the first 3 min; in-person recordings only
  stop by themselves with Settings → Recording → "Also stop in-person recordings". Settings live in
  `<userData>/auto-stop.json` (per Mac). After any stop the meeting's end is held back 60 s (the header shows
  "Post-meeting steps in … s · Start now"): continuing meanwhile never writes the end, so no pipeline run
  starts. Held ends are kept in `<userData>/grace-pending.json` and written at the next launch after a crash. Then the header follows the run (`pipeline:get` → `GET /api/documents/:id/pipeline`).
  Dev/e2e knobs: `OAT_AUTO_STOP` (JSON: `floorMs`, `confirmMs`, `undoMs`, `silenceMs`, `silenceDb`, `speechDb`,
  `eventEndWindowMs`),
  `OAT_END_GRACE_MS`, and `OAT_DETECTION=file:<apps.json>` (the mic-using apps are that JSON array, re-read on
  change: a test ends a call by emptying it). The agents skip enhance below 60 s of speech
  (`OAT_AUTO_ENHANCE_MIN_SPEECH_MS`; e2e 5 s). Details: `docs/tasks/7.5-auto-stop-enhance.md`.
- **First-run setup (9.2).** After an account's first sign-in on this Mac the main window shows setup as a
  dialog over the app (D-39; centred, fixed height, four clickable progress bars; a click outside or Escape
  closes it and skips setup): microphone → system audio → calendar → a 10 s test recording (levels for Me / Them + a live transcript
  line; nothing is saved), then a dismissible first-meeting guide on the home view. Settings → Setup shows the
  permission states and reopens it. Status comes from `oat-audio permissions` (never prompts); "Allow" is the only
  thing that asks macOS (microphone: Electron's `askForMediaAccess`; system audio: a 2 s sidecar system capture;
  calendars: `calendar request-access`) — a human checkpoint. A denied permission links to its System Settings
  pane (`x-apple.systempreferences:…Privacy_*`). Per account per Mac in `<userData>/onboarding.json`. Dev/e2e
  knobs: `OAT_ONBOARDING=auto|off` (default `auto`, but `off` under `OAT_E2E=1`, so other suites start in the
  app), `OAT_PERMISSIONS=fixture:<file.json>` (`{ microphone, system_audio, system_audio_supported?, answers? }`:
  "Allow" answers in memory, no sidecar, no prompt; under `OAT_E2E=1` without it every state reads `unknown` and
  the sidecar is never asked) and `OAT_TEST_RECORDING_MS`. Details:
  `docs/tasks/9.2-onboarding.md`.
- **Recording (2.5).** Start/pause/stop in the main window (or Stop in the widget); the transcript is live
  (mic = "me", system = "them"). STT tokens come from `POST /api/stt/token` (the mock in dev, Deepgram with
  `DEEPGRAM_API_KEY`), audio goes to `<userData>/audio/<meeting>/{mic,system}.opus`. Sleep pauses the
  recording, quitting stops it gracefully first. Details: `docs/tasks/2.5-transcript-panel.md`.
- **Local database + sync (2.6, D-19, D-28).** `<userData>/oat-<userId>.sqlite` (one per account; audio rows in the never-wiped `<userData>/audio-index.sqlite`) (`@oat/local-store`, Node's built-in
  `node:sqlite`: no native module, nothing to rebuild for Electron; WAL, one writer in main). It mirrors
  `workspace`, `document`, `meeting`, `participant`, `transcript_segment` (+ local-only `audio_recording`);
  triggers queue every local write in `outbox`. A recording creates its `meeting` document (private, in the
  active workspace — or, as a viewer there, the first one the user can create in) before the audio starts and stores each final segment as it arrives. The sync engine
  pushes the outbox to `POST /api/sync/push` (debounced after each write, parents first, acked per outbox
  version) and then pulls `GET /api/sync/pull?cursor=` (change log, D-22); offline it backs off (1 s → 60 s)
  and the sidebar says how many changes are saved on this Mac. The file is a cache: corrupt, written by a
  newer app, or failing a migration for a non-transient reason → it is wiped and rebuilt from the server
  (unsynced changes are lost and logged); busy/disk-full/I/O errors never wipe (retried). Another account
  gets its own file; switching waits for a recording to end. Entries the server refuses are parked (sidebar
  count, retried every 15 min or when edited). Inspect with `sqlite3 "<userData>/oat-<userId>.sqlite"` (dev
  profile: `~/Library/Application Support/Oat Dev/`). Details: `docs/tasks/2.6-persist-segments.md`.
- **Sync 3.5 (live, conflicts, backfill, search).** The app keeps `GET /api/sync/events` open (SSE
  invalidation: `{seq, tables, ids}`, `Last-Event-ID` replay, heartbeat; reconnect 1 s → 30 s) and pulls on
  every event; the pull interval is a 60 s backstop. A document first seen after the initial sync (e.g. a
  teammate shares a meeting note) gets its meeting/participants/segments from `GET /api/sync/backfill`.
  A push whose answer was lost never becomes a conflicted copy (client hashes in `doc_sent`, server
  `sync_receipt`); a real conflict files the losing text as "<title> (conflicted copy)" with this Mac's
  name — listed in the sidebar with a side-by-side compare ("Keep this copy" / "Keep other version";
  synced, the copy goes to the trash). The web shows the same banner + compare on the copy's page and
  refreshes the sidebar/page live from the same SSE channel. The sidebar search box queries the local
  SQLite FTS5 index (trigram: substrings, case/accents ignored, words ≥ 3 characters; works offline).
  The web app's Postgres pool sets `statement_timeout` / `idle_in_transaction_session_timeout`
  (`DATABASE_STATEMENT_TIMEOUT_MS`, `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS`; defaults 30 s / 15 s): an
  open transaction holds back every change-log reader (D-22); a pull that is held back answers
  `lagging: true` (the app retries in 2 s, doubling) and the server logs the long transactions (≤ every
  30 s). Details: `docs/tasks/3.5-sync.md`.
- **Storage settings (3.8, D-10).** Sidebar → Settings → Storage: total audio size, every meeting's audio
  (sort by date/size), "Show in Finder", "Delete audio" (files + rows marked `deleted`; transcript and notes
  untouched; refused while that meeting records) and the retention policy (keep forever / older than N days /
  cap at N GB, oldest first) with a dry run. The policy lives in `<userData>/audio-retention.json` (per Mac,
  like the audio index); the sweeper runs on launch, after each recording and every 6 h, and never deletes the
  active recording or audio from the last hour. `storage:audio-status` gives the meeting view's "Audio
  deleted" / "Audio on another device" hint. Details: `docs/tasks/3.8-storage-settings.md`.
- **Playback (3.7).** A recorded note's transcript panel has a player (play/pause, Me / Them / Both, 1–2×,
  scrubber over the meeting's recording sessions; Space, ←/→). `playback:open` mints an `oat-audio://<token>/`
  URL; main serves `<mic|system|mix>.wav` — the signed-in account's Opus parts decoded on the fly onto the
  meeting clock, with range requests — so `currentTime` is the transcript's time: clicking a line seeks there
  and the line under the playhead is highlighted. Deleted / other-device / no-audio states come from 3.8's
  status. Details: `docs/tasks/3.7-playback.md`.
- **Packaging (9.1).** `src/build/fuses.ts` (`OAT_FUSES`, `applyFuses`) holds the fuse settings to flip on
  the packaged binary: no run-as-node, no `NODE_OPTIONS`/`--inspect`, asar-only + integrity, cookie
  encryption.
- **Tests.** `pnpm --filter @oat/desktop test` (main-process logic and renderer helpers, no Electron).
  `pnpm --filter @oat/desktop e2e` (macOS; needs `pnpm dev:up`): builds, then Playwright `_electron.launch`s
  the app with a temp profile against `next dev` on a throwaway database (apps/web's `e2e/web-server.ts`,
  `E2E_PORT`, default 3100). `shell.openExternal` is stubbed and deep links are delivered by emitting
  `open-url`, so no browser opens and nothing is registered with the OS. The web half of sign-in runs in
  Chromium. `E2E_SCREENSHOTS=1` writes `docs/tasks/evidence/1.8/`, `2.5/`, `2.6/`, `3.5/`, `3.7/`, `3.8/`, `7.3/`, `7.5/` and `9.2/` (screenshots, `cold-start.json`, `latency.json`, `sync.json`, `playback.json`, `storage.json`). `e2e/a11y.spec.ts` (9.3b) walks every
  renderer screen and runs axe-core in light and dark (0 serious/critical); with `E2E_SCREENSHOTS=1` it also writes
  the desktop design sweep to `docs/tasks/evidence/9.2/sweep/after/` (`E2E_SWEEP_DIR` overrides). Other
  platforms skip it.

## Database (`@oat/db`)

All take `DATABASE_URL` (root `.env`, default the compose `oat` database):

| Command                                      | What it does                                                         |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `pnpm --filter @oat/db db:migrate`           | Applies pending migrations (idempotent, safe to run concurrently).   |
| `pnpm --filter @oat/db db:seed`              | Inserts demo data (`demo@oat.local`); idempotent. Local DBs only.    |
| `pnpm --filter @oat/db db:reset [--seed]`    | Drops and recreates the database, then migrates (and seeds). Loopback hosts only, no override. Use it when unreleased migrations were rewritten on `main` (`db:migrate` then fails on existing tables). Kills open connections to that database. |
| `pnpm --filter @oat/db db:generate`          | Generates a migration from schema changes (`packages/db/drizzle/`).  |
| `pnpm --filter @oat/db db:studio`            | Drizzle Studio against `DATABASE_URL`.                               |
| `pnpm --filter @oat/db index:backfill`       | (Re-)indexes every document for retrieval (see "Retrieval indexing"). `--workspace <id>`, `--enqueue` (hand it to running workers), `--concurrency <n>`. Idempotent. |

`db:reset` only touches the one database in `DATABASE_URL`; test databases (`oat_test_*`) are separate.

## Retrieval indexing (`@oat/indexing`, 6.1)

Notes and transcripts are cut into chunks (notes: by heading/section, ~400 tokens, citing TipTap block ids;
transcripts: 60–90 s windows citing segment ids + `start_ms`/`end_ms`), embedded with `@oat/ai`'s embedding
model (the mock LLM's feature-hashed vectors in dev) and stored in `chunk` (pgvector, HNSW cosine).

- **Worker.** `pnpm dev` starts it (`@oat/indexing` `dev` script, `tsx watch`); alone:
  `pnpm --filter @oat/indexing worker`. `pnpm dev:app` runs it in the `worker` container. It follows
  `change_log` (D-22) after a cursor kept in Redis, turns document / meeting / segment changes into one
  `document:<id>` job per document on a Redis queue (debounced, one run at a time per document, leases with a
  heartbeat, retried with backoff, moved to `failed` after 5 attempts, including a worker dying mid-job), and
  re-indexes: unchanged chunks keep their embeddings, only new text is embedded (in batches of 64, each stored
  right away so a retry never re-embeds it). A write is searchable ~1–2 s later. Needs the 6.1 migration
  (`db:migrate`).
- **Env.** `DATABASE_URL`, `REDIS_URL`, the `AI_*` variables (embeddings), and optionally
  `OAT_INDEX_QUEUE_PREFIX` (default `oat:idx`), `OAT_INDEX_DEBOUNCE_MS` (1500), `OAT_INDEX_CONCURRENCY` (2), `OAT_INDEX_MAX_CHUNKS` (1000 per
  document; the rest is skipped and logged).
  Every worker on the same Redis + prefix shares one queue; only one follows the change log at a time.
- **Inspect.** `docker compose exec redis redis-cli zrange oat:idx:pending 0 -1 withscores` (due jobs),
  `hgetall oat:idx:failed` (jobs that gave up, with the last error), `get oat:idx:cursor`. Deleting the cursor
  makes the follower re-check every document (cheap: nothing unchanged is re-embedded).
- **Search.** `searchChunks({ db, permissions }, query, { k, scope: { documentId } | { workspaceId } })`
  returns chunks the user may read (permission rule applied in SQL, then re-checked with `canReadDocument`)
  with citation refs. Integration tests use their own queue prefix on the shared Redis and a throwaway DB.

## Post-meeting pipeline (`agents/`, 8.3)

When a meeting ends, its notes are finished in the background: **enhance** (unless done, or the owner switched
"Auto-enhance after meetings" off) → **index** (retrieval chunks + action items) → **Notion** (if the owner's
Notion connection has "Auto-send meeting notes" on). It runs as a durable eve workflow (D-29) in the agents
server; the web app only asks for it and shows it.

```
desktop sync push sets meeting.ended_at ─▶ web: authorise (owner/editor) → pipeline_run row (one per meeting)
   (or POST /api/documents/:id/pipeline)        └─▶ POST <OAT_AGENTS_URL>/jobs/post-meeting  (service token)
agents server (eve, Postgres Workflow world in `oat_workflow`) ─▶ steps write status into pipeline_run
meeting header polls GET /api/documents/:id/pipeline: "Post-meeting: enhancing… / done / failed — Retry"
```

- **Run it.** `pnpm dev` starts it (`@oat/agents` `dev` = `eve dev --no-ui` on 127.0.0.1:3100, after creating and
  migrating the `oat_workflow` database if needed). Alone: `pnpm --filter @oat/agents dev`, or the production
  form `pnpm --filter @oat/agents agent:build && pnpm --filter @oat/agents agent:start` (this one also fires the
  schedules). `pnpm dev:app` runs it in the `agents` container (`agents/Dockerfile`; the web container reaches it
  as `http://agents:3100` with a compose-only token, since the image runs `NODE_ENV=production`, where the dev
  token is refused).
- **Env** (`.env.example`, "Background agents"): web side `OAT_AGENTS_URL` (default `http://127.0.0.1:3100`) +
  `OAT_AGENTS_TOKEN`; agents side the same token (+ `OAT_AGENTS_TOKEN_PREVIOUS` while rotating),
  `OAT_AGENTS_HOST`/`OAT_AGENTS_PORT`, `WORKFLOW_POSTGRES_URL` (its own database, never the app's), and the app's
  `DATABASE_URL`, `REDIS_URL`, `AI_*`, `NOTION_*`, `BETTER_AUTH_SECRET(S)` (it decrypts Notion tokens with the
  same secret config, `@oat/auth` `secretSourceFromEnv`). Every eve command runs with `EVE_TELEMETRY_DISABLED=1`.
- **Agents down?** Nothing breaks: the run is `waiting` ("waiting for the pipeline") and is handed over later,
  with backoff, by the agents' minute schedule (`agent/schedules/post-meeting-sweep.ts`, fires under
  `eve start`, not `eve dev`) or by the next status read of that meeting (the header polls). One hand-over per
  attempt: the web claims the row first; the agents start one workflow per `(run, attempt)`.
- **States** (`pipeline_run.status`): `waiting` → `queued` → `running` (`current_step`) → `completed` |
  `failed` (the header's "Retry" = next `attempt`, owner/editor only; none when `error_code` says a retry can't
  help, e.g. `owner_no_access`). A meeting resumed and ended again runs again (next attempt; `ended_at`,
  `rerun_requested`). The minute schedule also settles runs quiet for 10 min (`OAT_AGENTS_STUCK_AFTER_MS`) from
  the Workflow world's record. `steps` holds each step's result
  (`ran` / `skipped` + reason). Settings: `GET`/`PUT /api/settings/pipeline` (Settings → Integrations).
- **Inspect.** `docker compose exec postgres psql -U oat -c "select status, attempt, current_step, steps, error,
  dispatch_error from pipeline_run order by created_at desc limit 5"`; the agents' own view of one run:
  `curl -H "authorization: Bearer $OAT_AGENTS_TOKEN" localhost:3100/jobs/post-meeting/runs/<workflowRunId>`.
- **Layering** (D-29): `agents/` and every package import shared server code from `@oat/services`
  (documents, enhance, Notion, pipeline…), never from `apps/*`; ESLint (`no-restricted-imports`, root config)
  enforces it. `apps/web/src/server/*` keeps thin re-exports of the moved modules.
- **Tests.** `pnpm --filter @oat/agents test:int` (real `eve build` + server, ~2–3 min: contract, full run,
  switches, failure + retry, agents down → sweep, SIGKILL mid-generation/mid-wait); the web side is
  `apps/web/src/server/pipeline/api.int.test.ts`; the web e2e server starts this checkout's agents too
  (`e2e/pipeline.spec.ts`).

## Running evals (`@oat/ai`)

AI behaviour is gated by evals (SPEC §7, D-13): fixture meetings and questions in `packages/ai/evals/`, the
harness in `packages/ai/src/evals/`. Two suites: `enhance` (5 fixture meetings → notes) and `chat` (questions
over two synthetic workspaces → the real assistant tool loop + citation filter; the "Lumen" workspace reuses the
5 enhance meetings and adds a vendor call with a planted prompt injection and a teammate's private note).

```bash
pnpm --filter @oat/ai eval                      # mock tier: offline, deterministic, a few seconds
pnpm --filter @oat/ai eval --suite chat --verbose   # one suite; --verbose lists every non-passing check
pnpm --filter @oat/ai eval --model real --runs 3    # quality tier (needs AI_GATEWAY_API_KEY), mean of 3 runs
pnpm --filter @oat/ai eval --json out.json      # machine-readable results
```

(Inside `packages/ai` the same thing is `pnpm exec tsx evals/run.ts [flags]`.) Exit codes: 0 pass · 1 structural
failure, task/judge error or regression vs the baseline · 2 bad usage.

**Tiers.**

- *structural* — absolute gate, every mode. Enhance: schema, headings, origin, notes coverage. Chat: answered;
  cited (answer fixtures); every citation resolves to an id a tool handed out in that turn and that the asker may
  read; permission fixtures leak nothing from the unreadable note (answer text, citations or any tool output);
  injection fixtures show nothing the planted instruction asked for and no forged citation survives.
- *property* — deterministic, compared to the baseline. Chat: must-mention / must-not-mention facts, cites a
  supporting source, citation precision (share of citations in the fixture's `support` set), share of the model's
  markers that resolved, and abstention on questions the data can't answer.
- *judge* — `--model real` only: an LLM judge (role `judge`, `AI_MODEL_JUDGE`, deliberately another provider)
  scores enhance grounding/coverage and chat grounding (each answer sentence vs. the text of its own citations).

**Mock vs real.** `--model mock` (default) runs each suite against an in-process mock: enhance gets an
extractive draft, chat gets the mock LLM's scripted tool loop (search → quote the top 3 excerpts with their
citations). The mock exercises the plumbing (tools, permissions, fencing, citation filter) and must pass the
structural tier; its property scores are low by design and only guard against unnoticed changes. `--model real`
uses the `enhance`/`chat` role models at temperature 0 plus the judge; without a key it falls back to the mock
and says so.

**Baselines** (`packages/ai/evals/baseline.json`). Mock: every check's score, compared per check (tolerance
0.01). Real: per-fixture and overall tier means for one task model + judge model pair (tolerance 0.1); a run with
other models is reported "not compared". After an intended change (new fixtures, renamed checks, a better
prompt), re-record and commit the diff with the change:

```bash
pnpm --filter @oat/ai eval:baseline [--suite chat]           # mock baseline
pnpm --filter @oat/ai eval:baseline --model real --runs 3    # real baseline (needs a key)
```

The update refuses while any structural check fails. Review the baseline diff like code: a score that drops
must be explained in the task file.

**Adding a chat fixture.** Add it to `packages/ai/evals/chat/fixtures.ts`; reference citations by content with
`seg('<prefix>', '<unique text>')` / `note(…)` so ids can't drift. `support` must list every citation that
backs the expected answer (precision counts the rest as imprecise). `chat-suite.test.ts` checks that facts are
stated by the support set, forbidden facts live only in unreadable notes and planted injections exist.

**Cost (real mode).** One full run is ~100 model calls: enhance 5 × (1 task + 2 judge) and chat 21 × (2–4
tool-loop steps + 1 judge), a few hundred thousand input tokens in total — a few dollars at most at Sonnet-class prices (the
AI Gateway usage page has the real figure). `--runs n` multiplies it; `--suite` narrows it.
Real runs never happen in `pnpm run ci` (D-11, D-13).

## Tests

- `pnpm test`: unit tests, in-process fakes, no containers.
- `pnpm run ci`: everything, including the stack-dependent steps (see "CI" below).
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

## CI (`pnpm run ci` is the gate)

`pnpm run ci` (`scripts/ci.mjs`, plain Node) runs every gate in order and prints a summary table with
durations; it exits non-zero if any step fails. The full gate runs locally; GitHub Actions runs only the
`--fast` steps (D-42). The `actionlint` step lints the workflow. A step whose prerequisite failed is skipped; the
others still run so you see every failure at once (`--bail` stops at the first).

| Step              | What it does                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `format`          | `pnpm format:check` (Prettier)                                                                  |
| `actionlint`      | `.github/workflows/*.yml` through the pinned `rhysd/actionlint` image (files go in on stdin; skipped if Docker is missing) |
| `typecheck`       | `pnpm typecheck`                                                                                |
| `lint`            | `pnpm lint` (turbo `lint` + ESLint on `scripts/` and `docker/`)                                 |
| `test`            | `pnpm test` (unit, no containers)                                                               |
| `stack`           | No-op when every compose service is running and healthy; otherwise `pnpm dev:up` (builds local images only if missing, never rebuilds). Never `down`/`reset`/`build`. |
| `migrate`         | Creates a throwaway `oat_test_*` database, runs `@oat/db db:migrate` against it twice, checks applied = journal entries, drops it |
| `test:int`        | `pnpm test:int`                                                                                 |
| `e2e`             | `pnpm --filter <pkg> run e2e` for every package that defines an `e2e` script, one at a time, each with a free port in `E2E_PORT` (Playwright `webServer` should listen there): today `@oat/web` and `@oat/desktop` (macOS only; skips elsewhere). Skipped while no package has one. |
| `acceptance`      | macOS only: the v1 acceptance journey (`pnpm --filter @oat/acceptance run acceptance`, own free `E2E_PORT`, same `E2E_TIMEOUT_SCALE` rule). See "Acceptance journey" below |
| `swift:build`     | macOS only: `swift build` in `native/oat-audio`                                                 |
| `swift:test`      | macOS only: `swift test`                                                                        |
| `swift:synthetic` | macOS only: `oat-audio capture --synthetic --duration 2 \| check-frames.mjs --expect-seconds 2` (no hardware, no prompts) |

Flags: `--fast` (only format → test: no stack, e2e or Swift), `--only <step|group>[,...]` (exact steps, e.g.
`--only test:int` or `--only swift`; prerequisites aren't added, so `--only stack,test:int` if the stack may be
down), `--bail`, `--list`. Turbo caches typecheck/lint/test, so a re-run on an unchanged tree is a few seconds;
`TURBO_FORCE=true pnpm run ci` measures a cold run.

**e2e under load.** Several worktrees often run CI at once (load average well above the core count), which
makes `next dev` compile and hydrate pages several times slower. The e2e suites are written for that
(ci-flakes, `docs/tasks/ci-flakes.md`):

- Waits are conditions, never sleeps, with generous budgets (expect 15 s, action 20 s, navigation 30 s),
  all multiplied by `E2E_TIMEOUT_SCALE` (default 1). The `e2e` step sets it to 2 when the 1-minute load
  average exceeds the core count; set it yourself to override.
- Web pages mark `<html data-hydrated>` once React has hydrated (root `Providers`, and `global-error.tsx`).
  The web e2e `page` fixture (`e2e/fixtures.ts`) waits for it after every `goto`/`reload`/`waitForURL`, so
  clicks never land on menus or buttons that aren't wired up yet; pages from extra browser contexts get the
  same with `hydrationAware(page)`. Sign-in controls are also disabled until hydrated (`useHydrated`).
- Web e2e runs 4 workers (`E2E_WORKERS` overrides): one `next dev` serves them all.
- No blanket retries: Playwright uses 0 retries by default and 1 when explicitly run with `CI=true`.

**Adding e2e to a package**: add an `e2e` script (e.g. `playwright test`) whose server binds to
`process.env.E2E_PORT` (fallback to a fixed port for manual runs). Chromium is installed once per machine with
`pnpm --filter @oat/ui exec playwright install chromium`.

**GitHub Actions** (`.github/workflows/ci.yml`, D-42) runs `fast` on PRs, pushes to `main`, and manual dispatch
(Actions → CI → Run workflow → pick the branch). It splits `--fast` into three parallel `ubuntu-24.04` matrix jobs:
`pnpm run ci --only format,actionlint,lint`, `--only typecheck` and `--only test`, each with its own turbo cache key
(`turbo-<os>-<static|typecheck|test>-*`). The PR gate targets < 3 min wall clock. Actions are pinned by tag, runs
on the same ref cancel each other, and there are no secrets. The 4-vCPU runner sets `OAT_TEST_TIMEOUT_SCALE=3`
(vitest timeouts); `pnpm run ci` caps turbo at half the cores for the vitest steps. GitHub no longer runs the
compose-backed full suite or Swift sidecar checks: run `pnpm run ci` locally for the full gate and
`pnpm run ci --only swift` on macOS for the sidecar alone. To lint the
workflow by hand: `node scripts/ci.mjs --only actionlint`. (Mounting the repo into the actionlint container, as in
`docker run -v "$PWD":/repo rhysd/actionlint`, fails when Docker Desktop isn't allowed to share the folder,
e.g. under `~/Documents`; the stdin form avoids that.)

## Acceptance journey (`e2e/acceptance`, 9.4)

One Playwright test (`e2e/acceptance/journey.spec.ts`, package `@oat/acceptance`) walks the whole v1 loop
(SPEC §9) as one user and a teammate would, each phase a `test.step`:

sign up on the web (magic link) → connect Notion (mock) + "Auto-send meeting notes" → desktop cold start, signed
in through that browser → "New meeting note" records the `standup-short` fixture (FileSource, real time) with
the live transcript (me/them), a typed note, the fixture ends → sync → post-meeting pipeline (enhance → index →
Notion) → the enhanced note on the web and back on the desktop → the Notion mock received the page → share by
link, a stranger reads it → the note's assistant answers with a transcript citation that jumps there → web ⌘K
and the desktop's local search find it → a teammate invited to a team workspace signs up, accepts and reads the
note through the link → desktop playback: clicking a transcript line seeks the audio there.

```bash
pnpm dev:up
pnpm --filter @oat/acceptance run acceptance          # builds the desktop app, then runs the journey (~3–4 min)
E2E_SCREENSHOTS=1 pnpm --filter @oat/acceptance run acceptance   # + docs/tasks/evidence/9.4/ (screenshots, timings.json)
pnpm run ci --only acceptance                         # the CI step (free port, load-aware E2E_TIMEOUT_SCALE)
```

- Same server as the desktop e2e (apps/web's `e2e/web-server.ts`: `next dev` on a throwaway database in
  `.next-acceptance`, in-process LLM/Notion/Calendar mocks, the index worker and this checkout's agents server);
  live transcription uses the compose STT mock. Nothing real is touched: `OAT_CALENDAR=off`, `OAT_DETECTION=off`,
  `OAT_AUDIO_SOURCE=file:standup-short`, and `OAT_END_GRACE_MS=0` so the stopped meeting ends at once (7.5).
- **Timings vs SPEC §8** are printed (`[acceptance] …`) and written to `e2e/acceptance/test-results/acceptance-timings.json`
  (git-ignored): cold start, first-segment latency per voice, transcript word recall, sync drain, pipeline
  (stop → completed, enhance/index/Notion step times), chat answer, search, playback seek error. Cold start
  (< 2 s) and first-segment latency (< 1.5 s) are asserted.
- macOS only (Electron + Keychain); elsewhere the test skips and the CI step reports `skip`.

### Proving it works on a new machine

```bash
node scripts/acceptance-fresh.mjs          # [--ref <rev>] [--keep]
```

Clones the committed `HEAD` into a temp dir (no `node_modules`, no `.env`, no build output, no git-ignored file
from this checkout), runs `pnpm install --frozen-lockfile --prefer-offline`, `pnpm dev:up` (a no-op when the
shared stack is healthy) and `pnpm run ci --only acceptance` there, prints a per-phase summary and deletes the
clone. Uncommitted changes are listed and left out, so commit first. It uses the machine-wide caches any
developer machine has after its first setup (pnpm store, Playwright's Chromium, Electron's download cache, the
Docker images); on a truly new machine the first `pnpm install`, `dev:up` and Chromium install need network once
(D-11), everything after is offline.

## Troubleshooting

- **Port already allocated** on `dev:up`: something else uses one of 54329, 63790, 11025, 18025, 18089,
  14010 (or 3000 on `dev:app`, usually a `pnpm dev` server). Find it with `lsof -nP -iTCP:<port> -sTCP:LISTEN` (macOS) or `ss -ltnp 'sport = :<port>'` (Linux),
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
