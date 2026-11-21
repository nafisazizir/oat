# api-foundation — Shared feature API foundation
status: in-progress
milestone: M9 · deps: 5.1, 5.2, 7.4 · branch: devin/1795302266-api-foundation

## Goal
Let Electron render the same feature UI as web through an authenticated typed API, without UI changes.

## Context
D-37; D-28 local-first desktop; D-36 workspace model. Existing actions in apps/web/src/server/actions and apiRoute in apps/web/src/server/api.

## Scope
In: (1) shared server operations, REST coverage for workspaces, members, invites, joining and Google calendar status/disconnect, client-safe DTOs and schemas; (2) packages/client typed injectable transport; (3) main-process allowlisted authenticated bridge proxy, including streaming.
Out: packages/ui, visual changes, replacing local-first meeting notes, removing settings:open-web.

## Acceptance criteria
- [x] Every action in the four families has a REST equivalent; reads cover settings and workspace selection.
- [x] Actions and routes share validation, permission checks, Better Auth calls and user-facing errors; only actions refresh/redirect.
- [x] Cookie writes enforce CSRF; bearer headers reach Better Auth; anonymous/non-member/non-admin deny tests pass.
- [x] Client-safe response DTOs and request schemas support a typed injectable client.
- [ ] Desktop proxy keeps Keychain token out of renderer and supports stream subscribe/cancel.

## Verification
- pnpm run ci --fast
- pnpm dev:up
- DATABASE_URL=postgres://oat:oat@localhost:54329/oat pnpm --filter @oat/web test:int
- Independent review/verification before merge; handoff 1 commits without pushing.

## Design notes
D-37 records the transport boundaries. Handoff 1 implements server API only; client and desktop proxy follow in handoffs 2/3.
Shared operations receive authenticated user and original request headers; route adapters never invoke server actions.

## Review
Pending.

## Evidence

Handoff 1 (2026-11-21): REST layer implemented; client package/proxy remain for handoffs 2/3.
Added GET /api/workspaces/joinable after mapping the join page's server-loaded choices.
The Google status DTO includes connectedAt for the settings page and never returns account ids/tokens.
Authz registry needed no exemptions: every new method has a deny marker; entrypoints automatically enumerates the new handlers.

`pnpm dev:up`: compose Postgres, Redis, Mailpit, OAuth and mocks healthy.
`pnpm run ci --fast` (final):
```text
step        status     time  note
format      pass      16.4s
actionlint  pass       0.5s
typecheck   pass      19.4s
lint        pass      10.1s
test        pass       4.3s
total                 50.7s

ci: ok
```

`DATABASE_URL=postgres://oat:oat@localhost:54329/oat pnpm --filter @oat/web test:int src/server/api/workspaces.int.test.ts src/server/entrypoints.int.test.ts`:
```text
 Test Files  2 passed (2)
      Tests  139 passed (139)
   Duration  5.68s (import 48%, tests 38%, transform 14%)
```

Initial fast gate caught two type errors (nullable test assertion and disconnect dependency return type);
both corrected before the final green run. New route tests exercise bearer authentication, CSRF,
non-member/non-admin denials, scoped child ids, CRUD, join policies and calendar status/errors.
No UI files changed; no visual check required. Full CI/e2e and independent review/verification were not
run in this handoff (requested gate: fast CI plus relevant integration tests).
