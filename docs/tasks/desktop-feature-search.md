# Desktop feature parity — shared search, tasks and assistant
status: review
milestone: human-requested parity · branch: devin/1795304447-desktop-assistant-tasks-search

## Goal
Extract shared search, Tasks and assistant interfaces into @oat/feature-ui for web and desktop.

## Context
SPEC §4 search; DECISIONS D-37/D-38; packages/client/README.md; Ziiz consumer skill and Claude search-dialog reference.

## Scope
Steps 1–5: shared search, Tasks and assistant, web integration, desktop wiring and runtime/accessibility/screenshot verification. Local conventional implementation/verification commits and integration merges permitted after checks. No pushes.

## Design notes
- FeatureUiProvider owns a typed client/transport, navigation and optional real hrefs, notifications,
  workspace/user and injectable search sources. No Next runtime imports in the package.
- SearchSource id `server` is reserved for serverSearchSource; other sources are local/auxiliary.
  Responses retain the existing notes/transcripts DTO sections and server pagination cursors.
- Source requests run concurrently. Server documents suppress matching auxiliary documents; distinct
  transcript segments from a single response remain visible. Status-0 server failure allows local
  results with a quiet offline message. HTTP/auth failures are surfaced, not hidden by fallback.
- Web retains host navigation/theme/new-note commands, URL query/tab updates, debounce, safe highlight
  rendering, retry, timestamp links and load-more. The palette now uses the reference's default sizing.
- Both apps declare the new package and import its @source stylesheet. Next derives transpilePackages
  from dependencies; electron-vite already bundles workspace source through its existing renderer setup.

## Acceptance criteria
- [x] Shared dialog and controlled full results page with no next/* imports.
- [x] Fake-client/source tests cover merge, dedupe, offline/error/empty cases, cancellation and keyboard selection.
- [x] Web consumes shared UI through a typed-client host adapter.
- [x] New package included in source-vocabulary radius enforcement.
- [x] Desktop shell uses shared search rather than its existing local-search dialog (renderer tests).
- [x] Web runtime, light/dark feature screenshots and WCAG 2.2 AA axe scans.
- [x] Built desktop renderer, fixture-backed bridge and light/dark feature screenshots.
- [ ] Independent review and native Electron/OS bridge smoke test.

## Remaining work
Independent review and a real Electron/OS bridge smoke test remain pending. Step 5 verifies web runtime
and the browser-served production desktop renderer with a fixture bridge, not main/preload or OS services.
Cached desktop meetings open natively;
MeetingView has no segment/time navigation props, so cached-note deep links open the note only.
Uncached documents temporarily open on the configured web origin via the external URL bridge, retaining
block/segment/time query parameters. Pages remain dependent on that web fallback until a native viewer lands.

## Verification / evidence
Executed on this branch after implementation:

```text
pnpm --filter @oat/feature-ui test
 Test Files  3 passed (3)
      Tests  27 passed (27)

pnpm --filter @oat/feature-ui typecheck && pnpm --filter @oat/feature-ui lint
> tsc
> eslint .
Exit code: 0

pnpm --filter @oat/web typecheck && pnpm --filter @oat/web test
✓ Types generated successfully
 Test Files  34 passed (34)
      Tests  248 passed (248)

pnpm --filter @oat/ui test src/source-vocabulary.test.ts
 Test Files  1 passed (1)
      Tests  16 passed (16)
```

The originally requested space-separated `typecheck lint` / `typecheck test` commands forward the second
word to tsc and fail TS6231; equivalent separate script invocations above were used successfully.
Dependencies were initially absent; `pnpm install --config.strict-dep-builds=false` restored the workspace.
Full CI, integration/e2e, visual checks and desktop runtime checks were not run. No commit/push.

## Review
Independent review pending. React checklist applied to extraction: concurrent source requests, effect
cleanup and stale-result guards, controlled view props, keyboard-accessible native navigation, no shell
imports in shared code. Step 2 restores host-provided Next Link for web hrefs.

## Step 2 — My Tasks and Link adapter
- Added optional `LinkComponent`/`FeatureUiAdapter.Link`; both shared href-rendering sites select
  the host component or a native anchor. Web supplies a `next/link` wrapper with default prefetching.
- Moved Tasks view, typed-client hooks, retry helper/tests and pure task helpers to feature-ui.
  Controlled `TaskFilters` use `value`/`onChange`; web keeps URL initialization and replaceState updates.
- List/refetch/retained data, grouping, owner/due badges, empty/error/retry states, optimistic ticks,
  stale-version retry-once, rollback/reload and host error toasts are preserved.
- Editor imports shared `useTaskAssignees`; no assignment mutation was added. Requests abort on
  unmount and assignee requests also abort when the document/client changes; lookup errors return [].
- Note header and task row links use document AppTargets; rows include blockId. Shared toolbar,
  group header, list and row structures/classes are reused for loading; visual/pixel verification remains pending.
- Deleted the dead web task client, toggle helper and toggle tests; retained a thin web URL wrapper.
- Fake-client tests cover list/grouping/links, controlled tabs/selects/refetch, retained data, empty/error
  states, optimistic success/rollback/concurrent ticks, read-only tasks, assignment lookup and aborts.

### Step 2 checks
```text
pnpm --filter @oat/feature-ui test
 Test Files  5 passed (5)
      Tests  50 passed (50)

pnpm --filter @oat/feature-ui typecheck && pnpm --filter @oat/feature-ui lint
> tsc
> eslint .
Exit code: 0

pnpm --filter @oat/web typecheck && pnpm --filter @oat/web test
✓ Types generated successfully
 Test Files  33 passed (33)
      Tests  242 passed (242)

pnpm --filter @oat/ui test src/source-vocabulary.test.ts
 Test Files  1 passed (1)
      Tests  16 passed (16)
```
Initial test assertions incorrectly expected native disabled on Base UI checkbox roots; corrected to
data-disabled. Initial test typecheck rejected unsupported Testing Library ByRoleOptions.exact; removed.
Final runs above pass. Six toggle tests moved from web to shared, accounting for web's reduced count.
No next/* imports in shared source; git diff --check clean. No visual, desktop runtime or full CI checks.

## Step 3 — Assistant
- Added `/assistant` export with AssistantChat, ChatSession, messages, Answer, ProposalCard,
  ChatSessionContext, TranscriptReader, markdown/error/transcript helpers and assistant DTO types.
  Assistant source has no Next/editor imports. Existing Tasks still uses editor's pure task-date helpers.
- JSON requests use client.chat.threads/thread/decideProposal. DefaultChatTransport wraps
  toFetch(adapter.transport), retaining the returned thread header and sending only the new question.
- Session cleanup calls stop() and aborts persisted-thread refreshes and polling delays. Thread/list
  loads have abort guards. Tests observe actual stream abort signals at the fake OatTransport boundary.
- Scope follows the opened thread. Shared selection props let web bind `?thread=` through useSearchParams
  and replaceState; initial/external selections load, newly saved selections retain the same session/draft.
- AssistantIntegrationProvider injects openCitation and prepareProposal. Web open-document.tsx retains
  TipTap locking, settle/adopt/block patch/replace/release and in-place block/transcript citation handling.
  document-assistant.tsx keeps panel/sheet/shortcut behavior while rendering shared assistant/reader.
- Document and proposal links use AppTargets/host Link; citations navigate with blockId or segmentId/timeMs.
  Fixed web target encoding to retain both transcript `t` and `seg` query parameters.
- Composer uses a rounded card-like filled surface with default-radius controls; replies are compact,
  history quiet. Empty/loading/error/offline states are supported, including retry for history errors.
- Removed dead assistant UI copies and chat client/markdown helpers from web. Transcript helper path
  re-exports shared helpers; existing web transcript tests remain. Error and markdown tests moved to package.
- Fake transport/client tests cover history, opening messages/sources, scope, URL-controlled selection,
  SSE streaming/follow-ups, saved-source refresh without remount, citation targets, safe markdown/host links,
  proposal approve/reject/editor bridge/failure, stream stop/unmount/thread-switch abort and offline/errors.

### Step 3 checks
```text
pnpm --filter @oat/feature-ui test
 Test Files  8 passed (8)
      Tests  93 passed (93)

pnpm --filter @oat/feature-ui typecheck && pnpm --filter @oat/feature-ui lint
> tsc
> eslint .
Exit code: 0

pnpm --filter @oat/web typecheck && pnpm --filter @oat/web test
✓ Types generated successfully
 Test Files  31 passed (31)
      Tests  220 passed (220)

pnpm --filter @oat/ui test src/source-vocabulary.test.ts
 Test Files  1 passed (1)
      Tests  16 passed (16)
```
Initial lint flagged synchronous effect-driven state changes in thread selection; refactored to
derive selection during render and update loaded state from request callbacks. Final checks above pass.
22 helper tests moved from web to package, accounting for web's reduced count. No screenshots, visual,
real browser/editor, desktop runtime or full CI checks. No commit/push.

## Step 4 — Desktop wiring
- Committed steps 1–3 locally as `3ed807e feat(feature-ui): share search tasks and assistant across hosts`.
  Standard git commit hook processing was enabled; no pre-commit hook or hooksPath is configured here.
  Nothing pushed.
- Added `windows/feature-views.tsx`: signed-in FeatureUiProvider with api/apiTransport, current workspace,
  normalized auth user and Sonner notifications/Toaster; no hrefFor/Link. Owns feature views and native/
  external AppTarget mapping. Main shell additions preserve recording controls and clear competing selection.
- Shared Assistant and My tasks sidebar entries render native shared views. Tasks filters and full Search
  query/tab are host-local controlled state. A missing workspace shows a quiet prompt instead of issuing
  unscoped feature requests. Leaving Assistant unmounts its session and cancels the transport stream.
- `windows/feature-search.tsx` supplies desktop navigation/new-meeting/theme commands to shared SearchDialog;
  shell-menus keeps its existing Cmd/Ctrl-K handling, including editor-handled shortcut precedence.
- `sync/local-search-source.ts` converts local FTS snapshots into safe escaped highlights and shared hits,
  honors cancellation/filtering and skips auxiliary pagination. Combined with serverSearchSource(api),
  server documents win online and status-0 failure leaves local results and an offline notice.
- The existing query-only bridge searches the entire device cache as before. Snapshots lack workspace,
  visibility and speaker/source metadata: local hits use neutral display defaults (no Private badge or
  guessed speaker identity); server hits retain real metadata. No search bridge contract was changed.
- Cached meetings open in MeetingView (it exposes no segment/time props). Uncached documents use the
  existing shell:open-external bridge with a document-relative path. Main resolves only validated `/d/id`
  paths against config.webUrl; absolute safe HTTP(S) behavior is unchanged. This small security/main change
  avoids hard-coding a web origin or exposing configuration/tokens to the renderer.
- Deleted dead LocalSearch UI; retained search-text helpers. Added persistent light/dark/system commands.
  Confirmed desktop imports feature-ui/styles.css, whose `@source './'` scans all shared feature classes.
- Renderer tests cover sidebar switching, missing workspace/name, shared palette and offline results,
  full search local query updates, cached/external document opens, ongoing recording controls and actual
  SSE stream AbortSignal cancellation after navigating away. Source/security/theme unit coverage adds
  merge priority, escaping, empty/error/filter/paging/abort behavior and strict URL resolution.

### Step 4 checks
Final scoped checks after the last code edits:
```text
pnpm --filter @oat/desktop typecheck
> tsc

pnpm --filter @oat/desktop lint
> eslint .

pnpm --filter @oat/desktop test
 Test Files  60 passed (60)
      Tests  511 passed (511)

pnpm --filter @oat/feature-ui test
 Test Files  8 passed (8)
      Tests  93 passed (93)
```
An initial desktop typecheck caught nullable auth names and SearchView's notes/transcripts-only tab;
normalized names to email and initialized the tab to notes. No visual or real Electron runtime checks.

```text
pnpm run ci --fast
 Tasks:    22 successful, 22 total
Cached:    21 cached, 22 total

step        status     time  note
format      pass      21.8s
actionlint  pass       0.5s
typecheck   pass      13.8s
lint        pass       6.7s
test        pass      16.0s
total                 58.9s

ci: ok
```
Full final gate log: `/home/ubuntu/feature-ui-ci-fast.log`. `git diff --check` clean.
React checklist: controlled host state, concurrent sources, cleanup/abort coverage, no effect-based
derived state, source identities invalidate results after sync, no new shared framework imports.
Independent review and visual/real-runtime verification remain pending; no push.

## Step 5 — browser verification and screenshot evidence

- Started the compose stack with `pnpm dev:up`; Postgres, Redis, Mailpit, OAuth and mocks healthy.
  No Docker Hub 429 occurred, so no mirror workaround was needed. Installed Playwright Chromium.
- Reused the existing in-process AI mock and existing Assistant/Tasks/Search specs (the latter two
  contain command-menu coverage). Added `e2e/feature-surfaces.ts`: light/dark WCAG 2.0/2.1/2.2 AA
  axe scans, including contrast and target-size, plus opt-in screenshots via FEATURE_UI_SCREENSHOTS.
  Scans cover Assistant empty/streamed answer with citations, populated Tasks, Search results and palette.
- Browser scans found selected thread-date contrast at 4.31:1 and nested interactive links in palette
  options. Darkened thread-date text and made each web result one native link/option. Fixed CommandItem
  asChild composition so its trailing check icon belongs inside the slotted root; added regression tests.
  Preserved host Next Link/prefetch, desktop click navigation, normal mouse/keyboard selection and
  modifier-click native new-tab navigation (checked in Playwright).
- The new modifier-click test initially waited for a page-level popup event. A trace and an isolated
  Chromium reproduction showed native Ctrl-click creates a context page without that event; changed
  the assertion to wait for the context page. No production workaround was needed.
- Built desktop with electron-vite and served out/renderer locally. Scratch harness
  `/home/ubuntu/feature-ui-scratch/desktop.mjs` injects window.oat invoke/subscribe/send, state/workspace/
  recording fixtures, api:request, api:stream-open/cancel and chunk/end subscriptions, and local search
  hits with an offline server response. It exercises an actual SSE answer, citation resolution, sidebar
  navigation, populated Tasks and Cmd/Ctrl-K with offline local results. No console/page errors.
- All screenshots are outside the repo under `/home/ubuntu/screens/` (20 PNGs, not committed).
  Web: `web-{assistant-empty,assistant-answer,tasks,search-results,search-dialog}-{light,dark}.png`.
  Desktop: `desktop-{assistant-empty,assistant-answer,tasks,search-dialog,sidebar}-{light,dark}.png`.

### Step 5 final checks

```text
DATABASE_URL=postgres://oat:oat@localhost:54329/oat \
FEATURE_UI_SCREENSHOTS=/home/ubuntu/screens E2E_PORT=3126 E2E_WORKERS=2 E2E_TIMEOUT_SCALE=2 \
pnpm --filter @oat/web e2e assistant.spec.ts tasks.spec.ts search.spec.ts
  1 skipped
  11 passed (1.7m)

DATABASE_URL=postgres://oat:oat@localhost:54329/oat \
pnpm --filter @oat/web exec vitest run --mode int \
  src/server/api/search.int.test.ts src/server/tasks/api.int.test.ts src/server/api/chat.int.test.ts
 Test Files  3 passed (3)
      Tests  33 passed (33)

pnpm --filter @oat/feature-ui test
 Test Files  8 passed (8)
      Tests  94 passed (94)

pnpm --filter @oat/ui test src/components.test.tsx src/source-vocabulary.test.ts
 Test Files  2 passed (2)
      Tests  36 passed (36)

pnpm --filter @oat/web test
 Test Files  31 passed (31)
      Tests  220 passed (220)

pnpm --filter @oat/desktop exec vitest run src/renderer/src/windows/shell.test.tsx
 Test Files  1 passed (1)
      Tests  16 passed (16)

pnpm --filter @oat/desktop build
✓ built in 1.81s

node /home/ubuntu/feature-ui-scratch/desktop.mjs
Desktop renderer screenshots complete. Console/page errors: []
```

Feature-ui, UI and web typecheck/lint passed. The sole skipped e2e is the pre-existing opt-in dark
screenshot-only test; new scans and captures cover dark mode with real results. Next logs an
`Error: aborted / ECONNRESET` during the passing Stop-stream test; the desktop build warns about
chunks above 500 kB. Neither blocks the checks. Full logs: /home/ubuntu/feature-ui-web-e2e.log,
/home/ubuntu/feature-ui-web-int.log, /home/ubuntu/feature-ui-step5-unit.log,
/home/ubuntu/feature-ui-step5-ui.log, /home/ubuntu/feature-ui-step5-web-unit.log,
/home/ubuntu/feature-ui-step5-desktop-test.log, /home/ubuntu/feature-ui-step5-desktop-build.log and
/home/ubuntu/feature-ui-desktop-screens.log. No step-5 commit or push.

## Integration merge — PR #24 settings parity

STEP 5 committed locally as `19ad04d`. Fetched origin and merged
`origin/devin/1795304500-parity-integration` at `0f9060e` (PR #24).

- Kept the incoming @oat/settings-ui panels, settings section routing, workspace-exit cleanup,
  export/connect IPC and shared ThemeProvider/root Toaster. Dropped our feature-provider Toaster.
- Kept Assistant/My tasks sidebar entries, shared palette/full results, cached document routing
  and recording controls while Settings or a feature view is open.
- Palette Settings opens the default preferences section. Back returns to the prior feature view;
  exiting a workspace clears both selected meeting and feature view.
- Palette theme commands now use the incoming shared theme store (oat-theme), not the removed
  desktop-only helper/store. Deleted its dead helper/test and added shell regressions for shared
  theme updates and Settings/Assistant/Tasks navigation.
- Kept both stylesheet sources and all dependency/lockfile additions. Retained both PLAN entries
  and both LOG histories; DECISIONS.md is identical to the incoming branch (no decision conflict).
  Confirmed settings:open-web is absent from active desktop/core bridge code.
- Refreshed the scratch bridge for oat-theme, settings environment data, settings:connect and
  settings:export-notes. Runtime capture checks a single notification region and theme changes in
  both directions between Settings and the command palette. Browser console/page errors: [].
- Re-shot all 10 desktop feature screenshots under /home/ubuntu/screens with the merged build;
  added desktop-settings-light.png and desktop-settings-dark.png. No screenshots or scratch code
  are tracked. Native Electron/OS bridge verification is still outside this Linux fixture check.

```text
pnpm --filter @oat/desktop typecheck
> tsc

pnpm --filter @oat/desktop lint
> eslint .

pnpm --filter @oat/desktop test
 Test Files  60 passed (60)
      Tests  510 passed (510)

pnpm --filter @oat/feature-ui test
 Test Files  8 passed (8)
      Tests  94 passed (94)

pnpm run ci --fast
step        status     time  note
format      pass      23.1s
actionlint  pass       0.4s
typecheck   pass      45.9s
lint        pass      13.7s
test        pass      46.2s
total                129.3s

ci: ok

pnpm --filter @oat/desktop build
✓ built in 1.25s

node /home/ubuntu/feature-ui-scratch/desktop.mjs
Desktop renderer screenshots complete. Console/page errors: []
```

Logs: /home/ubuntu/feature-ui-merge-{desktop,shared,ci,build,screens}.log.
Build retains the chunk-size advisory; no failing checks. Local merge commit requested; no push.

## STEP 6 — visual hill-climb

- [x] Desktop sidebar now follows web: My tasks, then Assistant (windows/feature-views.tsx).
- [x] Shared FeaturePageHeader owns the exact Tasks/Search title, workspace subtitle and spacing;
  used by both web route pages and desktop feature views. Desktop now uses the same page insets/measure.
  Assistant intentionally has no extra page title during a chat.
- [x] Search and Tasks share flat divided lists and rounded-md hover/focus highlights. Task dividers
  live on unstyled list-item wrappers so Item's transparent borders cannot mask them; skeleton and
  final row boxes share the same minimum height and inner/wrapper classes.
- [x] Citation chips are spaced, superscript-aligned bordered badges with a 24px target, focus/hover
  states and source title/tooltip. Added a compact footer of deduplicated cited notes using the same
  host navigation/in-place citation integration. The Ziiz reply reference has no source-list component;
  this footer uses existing shared ramp/control conventions.
- [x] New chat centers the greeting, composer and compact ghost suggestions together; after sending,
  the composer stays mounted and moves to the bottom of the conversation.
- [x] Thread navigation uses the main surface with a separating border; rounded-md rows use the
  sidebar's gray-alpha active/hover treatment.
- [x] Owner badges use the proper Avatar/Fallback, a 20px initial circle and explicit name gap.
  Owner/due badges are both 24px high; task skeletons match the row-height change.

Verification adds shared header tests (including blank workspace), composer identity/state tests,
titled citations, deduplicated source navigation and unavailable-source coverage. Web surface checks
assert actual empty-state centering, bottom composer placement, citation dimensions/border/spacing,
avatar dimensions/gap and matching badge heights before axe scans in both themes. Desktop fixtures
also assert sidebar ordering and Tasks/Search workspace descriptions.

An initial axe scan caught label-content-name-mismatch on the new footer's overridden accessible
name. Fixed by deriving the name from its numbered visible content (with a screen-reader action
prefix), preserving the visible text. Updated the skeleton regression to compare both the new
divider wrapper and its inner row; JSDOM's inline-span name whitespace is normalized in the source
footer test. Final checks:

```text
DATABASE_URL=postgres://oat:oat@localhost:54329/oat \
FEATURE_UI_SCREENSHOTS=/home/ubuntu/screens \
E2E_PORT=3126 E2E_WORKERS=2 E2E_TIMEOUT_SCALE=2 \
pnpm --filter @oat/web e2e assistant.spec.ts tasks.spec.ts search.spec.ts
  1 skipped
  11 passed (2.4m)

pnpm --filter @oat/feature-ui test
 Test Files  9 passed (9)
      Tests  100 passed (100)

pnpm run ci --fast
step        status     time  note
format      pass      16.6s
actionlint  pass       0.3s
typecheck   pass      13.3s
lint        pass       4.5s
test        pass      20.8s
total                 55.5s

ci: ok

pnpm --filter @oat/desktop build
✓ built in 1.87s

node /home/ubuntu/feature-ui-scratch/desktop.mjs
Desktop renderer screenshots complete. Console/page errors: []
```

The skip is the existing opt-in screenshot-only search test; the regular search test captures both
themes. CI includes desktop (60 files / 510 tests), shared settings, web units and vocabulary checks.

Re-shot 24 target PNGs outside the repository (all light + dark):
- /home/ubuntu/screens/web-{assistant-empty,assistant-answer,tasks,search-results,search-dialog}-{light,dark}.png
- /home/ubuntu/screens/desktop-{sidebar,settings,assistant-empty,assistant-answer,tasks,search-dialog,search-results}-{light,dark}.png

The desktop fixture remains /home/ubuntu/feature-ui-scratch/desktop.mjs. Added full-search desktop
captures to verify the second shared header. Logs: /home/ubuntu/feature-ui-step6-{tests,e2e,ci,build,desktop-screens}.log.
Visuals checked in both themes; build still has the non-blocking chunk-size advisory. Native
Electron/OS bridge smoke and independent review remain pending. Local commit only; no push.
