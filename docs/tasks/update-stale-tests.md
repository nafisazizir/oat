# update-stale-tests — Bring the local gates up to date

status: review
branch: devin/1795554196-update-stale-tests

## Goal

Update stale expectations without hiding regressions, and make keeping affected tests current a requirement
for every change now that GitHub only runs the fast tier (D-42).

## Context

- [Hosted run 45476945700](https://github.com/nafisazizir/oat/actions/runs/45476945700): web E2E started
  about 5½ minutes into a 30-minute Linux job. It was still running 24½ minutes later when the job was
  cancelled. Logs showed 110 tests on four workers, retrying stale assertions and timing out in long
  sequential accessibility scans. The local gate does not retry by default.
- The workspace switcher intentionally shows a single identity line (D-41). The desktop and web use the
  shared command palette, and the desktop recording stop control lives in the transcript footer.

## Scope

Local test sources, agent test-maintenance rules, and directly related documentation. Leave product
regressions visible and report them separately. Do not restore the hosted slow jobs.

## Acceptance criteria

- [x] Stale assertions match the current intended behavior, and failures that signal a product regression
  are identified rather than hidden.
- [x] Repository rules require updating affected tests and running the local checks.
- [x] The full local CI result is recorded, including platform-specific skips.

## Verification

`DATABASE_URL=postgres://oat:oat@localhost:54329/oat OAT_TEST_TIMEOUT_SCALE=3 E2E_TIMEOUT_SCALE=2 pnpm run ci`

## Evidence

- The baseline audio unit test read pre-resume PCM; after waiting for both the resumed event and a
  fresh PCM frame, the focused sidecar suite reported `Tests 30 passed (30)`.
- The first isolated full run passed format, actionlint, typecheck, lint, unit tests, stack setup,
  migration and integration (23 tasks). It passed the previously failing auth, a11y, calm-shell,
  join, Notion and workspaces specs. The full web result was 94 passed, 17 skipped, 1 failed (5.9m).
- The one web failure was axe scanning Integrations while the fading “Loading settings…” status was
  still on screen. The captured page snapshot showed both integrations had loaded by the time the
  failure was reported. The settings scans now wait for the real controls before running the same
  axe rules; no violation is filtered out.
- The second full run passed both settings themes and all four main axe scans. The remaining failure
  was `apiRequestContext.get: read ECONNRESET` in the web conflict spec's final read after the UI had
  successfully resolved the conflict. That one idempotent GET retries a connection reset once; it
  still requires HTTP 404 and does not retry HTTP responses.
- The final full Linux run reported `ci: ok` in 621.5 s: nine steps passed, none failed and five were
  skipped because they require macOS. Web E2E reported 95 passed and 17 skipped (6.3m); editor E2E
  reported 16 passed and 2 skipped (8.1s). All 29 desktop Playwright cases were skipped on Linux.
  The desktop and acceptance changes were typechecked and linted, but not exercised on a Mac.
