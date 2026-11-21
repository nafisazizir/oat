# Desktop feature parity — shared search, tasks and assistant
status: in-progress
milestone: human-requested parity · branch: devin/1795304447-desktop-assistant-tasks-search

## Goal
Extract one host-adapted search dialog and results view into @oat/feature-ui for web and desktop.

## Context
SPEC §4 search; DECISIONS D-37/D-38; packages/client/README.md; Ziiz consumer skill and Claude search-dialog reference.

## Scope
Steps 1–3: shared search, Tasks and assistant, web integration. Desktop runtime integration belongs to later handoffs. No commits or pushes.

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
- [ ] Desktop runtime uses shared search rather than its existing local-search dialog.
- [ ] Visual review in both themes and desktop/web runtime verification.

## Remaining work
Desktop runtime is not migrated in this handoff: `windows/shell-menus.tsx` still renders `LocalSearch`.
Its existing behavior explicitly keeps page hits read-only and only opens meeting hits. A desktop host
adapter must translate `search:query` snapshots into SearchResponse, use api/apiTransport, and connect
the search target to a full results surface. The native document/deep-link opening policy needs to be
handled when wiring that host; current shell only selects a document id and discards segment/time.
No local source is shipped or wired into either application yet; offline fallback is package-tested.

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
