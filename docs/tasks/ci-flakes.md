# ci-flakes — CI reliability under load

status: done
branch: task/ci-flakes

## Goal

`pnpm run ci` passes reliably while several agents run CI on the machine at once. Flakes seen on 2026-11-14
(docs/LOG.md): `@oat/desktop` e2e (deep-link sign-in `desktop.spec.ts:156`, recording `recording.spec.ts:102`),
`@oat/web` e2e (`documents.spec.ts`, 3 tests), `@oat/audio` `opus-archive.test.ts:87`. Fix root causes, no
blanket retries.

## Root causes

1. **Clicks before hydration (web pages, both e2e suites).** Server-rendered buttons are visible before
   React hydrates them. Under load `next dev` takes seconds to hydrate, so a click landed on a dead button:
   - desktop sign-in: "Continue to the app" (fetch-on-click) did nothing, `waitForResponse` waited out the
     90 s test timeout. Reproduced 2/5 at load average ~35 on 14 cores (trace: no `POST /desktop/code`).
   - the sign-in form: submitting before hydration is a native GET (`/sign-in?email=…`), no email sent.
   - web documents spec: "Add to Private" menu trigger clicked before hydration.
   This is also a small product bug (dead clicks / email in the URL on a slow connection).
2. **5 s default expect timeout vs `next dev` compiling routes on first hit under load** (e.g. `/d/[id]` after
   "New page": `toHaveURL` failed at 5 s, reproduced 3/3 documents tests at load ~35).
3. **Race reading the opened sign-in URL (desktop).** The app shows "signing in" *before* `openExternal`
   (it awaits the PKCE challenge in between); the helper read `openedUrls()` once. Same for `window.open`.
4. **Web e2e ran 7 workers (50 % of cores) against one `next dev`** — more queueing behind compilation.
5. **`opus-archive.test.ts:87` (`droppedFrames === 0`)**: `FileSource` `speed: 'fast'` pushes the whole
   fixture (≈ 4,500 frames for both sources) independent of the encoder's progress; the archive's default
   queue is 3,000 frames. Measured peak queue depth under load: up to 1,699 frames in a lone vitest run, so in
   a full parallel `pnpm test` the encoder can fall far enough behind to drop. Timing assumption in the test.
6. **`web-server.ts` cleaned the wrong dev cache**: it always removed `apps/web/.next/dev`, even for the
   desktop e2e server (`OAT_NEXT_DIST_DIR=.next-desktop-e2e`), whose own stale cache was never cleaned.

Ruled out: Mailpit (every test uses a `uniqueAddress()`, searched by recipient), shared DB (each e2e server
uses its own `oat_test_*` database), Electron userData (fresh `mkdtemp` per spec file; single-instance lock is
per userData), ports (`ci.mjs` picks a free one per package). Cold start (536–698 ms vs 2 s budget) and
first-segment latency (~560–580 ms vs 1.5 s) stayed well within budget at load ~35, so those SPEC budgets
are unchanged.

## Fixes

- `apps/web/src/lib/use-hydrated.ts` (`useHydrated`): sign-in form controls and the desktop hand-off
  buttons are disabled until hydrated (product fix; Playwright waits for enabled). Calendar row reuses it.
- Root `Providers` (and `global-error.tsx`) set `<html data-hydrated>` after hydration. Web e2e `page`
  fixture (`e2e/fixtures.ts`) waits for it after `goto`/`reload`/`goBack`/`goForward`/`waitForURL` on Next
  pages; `hydrationAware(page)` for extra contexts (sharing, workspaces specs).
- Playwright configs (web + desktop): expect 15 s, action 20 s, navigation 30 s, web test timeout 60 s, all
  × `E2E_TIMEOUT_SCALE`; `scripts/ci.mjs` sets it to 2 when load average > cores. Web workers 4
  (`E2E_WORKERS`). Desktop specs scale their own `test.setTimeout`s (`scaled()`).
- Desktop helpers: `waitForSignInUrl()` polls `openedUrls()`; `window.open` check polls.
- `opus-archive.test.ts`: `maxQueuedFrames: 10_000` (holds the whole fixture; the suite tests content, not
  back-pressure).
- `web-server.ts` removes `<OAT_NEXT_DIST_DIR>/dev`, i.e. its own cache only.
- Retries unchanged: 0 locally / in `pnpm run ci`, 1 only with `CI=true` (pre-existing, GitHub Actions).
- Not changed: turbo concurrency for `test:int` (no int failure seen).

## Evidence

All at load average 26–37 on 14 cores (other agents' CI plus a `turbo run test --force` loop in this
worktree).

| Run | Before fixes | After fixes |
| --- | --- | --- |
| desktop e2e `--repeat-each` | 5×: 2 failed (sign-in, `waitForResponse` hang) / 28 | 10×: **60/60** (cold start 519–644 ms, latency 560–587 ms) |
| web e2e (full suite) | 1×: 3 failed (documents) / 43 | 3× (minus `templates:47`, see below): **124/124**; 1× full: 43/43 inside each CI run |
| `opus-archive.test.ts` | — (peak queue 1,699/3,000 frames measured) | 5×: 17/17 each |
| `pnpm run ci` (with load loop) | — | 2 runs back to back, both `ci: ok` (load 31–40; `e2e` step chose `E2E_TIMEOUT_SCALE=2`): run 1 305 s, run 2 with `TURBO_FORCE=true` 209 s (desktop 6/6, web 43/43, editor 16/16 each; `test` incl. opus-archive ran cold in run 2) |

`templates.spec.ts:47` fails under `--repeat-each` only (it expects the shared setup user to have no custom
template yet); every CI run starts from a fresh database, so it is excluded from repeat runs, not a flake.

### Orchestrator verification (pre-merge)
Root causes: pre-hydration clicks (also a product bug: sign-in GET leaked email into URL — fixed with useHydrated), 5 s waits vs next dev compile under load, desktop URL race, opus test queue < fixture, .next clearing. Evidence: desktop e2e 60/60 ×10 under load (was 2/28 failing), web e2e 124/124 ×3 under load; full ci twice green under load 31–40.
