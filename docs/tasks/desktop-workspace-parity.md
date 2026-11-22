# C2 · Desktop workspace parity (pages, folders, sidebar tree, trash, sharing, templates)

Phase 2 piece of the desktop/web parity plan. Base branch: `devin/1795304500-parity-integration`
(phase 1: Graphite/ziiz UI D-37, `@oat/client` + desktop API proxy D-38).

## Goal

Desktop's sidebar and document features match web, using the **same components**. Today desktop has
Home + meeting notes only. Web has: Private/Shared page tree with folders (create/rename/move/drag),
pages with the TipTap editor, trash (restore / delete forever), share dialog, templates gallery/editor,
workspace switcher with create/join/leave, invite members.

## Design

New package **`packages/workspace-ui` (`@oat/workspace-ui`)**, same shape as `packages/meeting-ui`
(TS source exports, vitest + jsdom, no Next/Electron imports). Both apps render it.

### Host adapter (`src/host.tsx`)

Every shared component gets platform things from one context, never from `next/*` or the bridge:

```ts
type AppRoute =
  | { view: 'home' }
  | { view: 'document'; id: string; query?: Record<string, string> }  // page, meeting note or folder
  | { view: 'templates' } | { view: 'template'; id: string } | { view: 'template-new' }
  | { view: 'tasks' } | { view: 'assistant'; threadId?: string } | { view: 'search'; q?: string }
  | { view: 'settings'; section?: string }
  | { view: 'join' };

type WorkspaceHost = {
  platform: 'web' | 'desktop';
  appOrigin: string;              // public web origin for copied share links
  client: OatClient;               // @oat/client
  route: AppRoute;                 // current location
  navigate(route: AppRoute, options?: { replace?: boolean }): void;
  hrefOf(route: AppRoute): string; // web: '/d/<id>' etc. (single source: src/routes.ts)
  Link: React.ComponentType<{ route: AppRoute } & Omit<React.ComponentProps<'a'>, 'href'>>;
  refresh(): void;                 // reload shell data (web: router.refresh(); desktop: refetch)
  online: boolean;                 // desktop: false when the API answers status 0
};
```

`src/routes.ts`: `hrefOf(route)` and `routeOf(pathname, search)` (web paths: `/home`, `/d/[id]`,
`/templates`, `/templates/[id]`, `/templates/new`, `/tasks`, `/assistant[/id]`, `/search?q=`,
`/settings[/section…]`, `/join`) so web and desktop share one mapping; `inSection`/`sections` labels move here.

### What moves into the package (web switches its imports, keeps its behaviour and e2e selectors)

- Tree model: `apps/web/src/lib/tree.ts` (pure helpers + `folderNode`/`documentNode`), `optimistic-tree.ts`,
  `shell-data.tsx` (`ShellDataProvider` — refresh comes from the host). Web's `lib/tree.ts` may re-export.
- `loadShellData(client, user)`: builds `ShellData` over REST (`workspaces.list`, `folders.tree`,
  `documents.list`, `documents.list({trash:true})`, `workspaces.joinable` → canJoin). Desktop uses it;
  web keeps its server loader (`getShellData`).
- Sidebar: `app-sidebar.tsx` (one shared `AppSidebar`), `page-tree.tsx`, `tree-actions.tsx` (calls
  `host.client` instead of `@/lib/api-client`), `trash-dialog.tsx`, workspace switcher,
  `create-workspace-dialog.tsx`, `leave-workspace-dialog.tsx` (create/switch/leave through the client's
  REST routes instead of server actions). Nav: Search, Home, My tasks, Assistant, Private/Shared tree,
  footer Templates · Trash · Settings, workspace switcher. Slots (props) for app-specific bits:
  `top` (desktop drag strip), `primaryAction` (New note / New meeting note), `beforeTree` (desktop
  conflicts), `footerExtra` (web ThemeMenu, desktop sync status), `accountItems` (account menu items),
  `onSearch`.
- Documents: share dialog, page editor (title + `OatEditor` + autosave + share/trash header actions;
  web-only extras like enhance, pipeline, Notion, assistant enter through slot props), folder view.
- Templates: gallery, editor, preview, icon, delete dialog, duplicate button (data via client; web may
  pass server-loaded initial data).

Style: ziiz Graphite + claude.ai clone (ziiz `apps/www/components/claude-ai/app-sidebar.tsx`,
`library.tsx`, `page-header.tsx`). Radius rule (D-37): default radius on every control, rounded-full
only for avatars/badges/dots; ramp vocab + type roles + `@tabler/icons-react` only.

### Desktop wiring

- Main window keeps an `AppRoute` in state (no browser routing) and provides the host with `api`
  (`apps/desktop/src/renderer/src/lib/api.ts`). Shell data via `loadShellData`; refetch after mutations
  and when sync completes (`sync.lastSyncedAt`).
- Meeting notes stay local-first (D-28): `document` routes whose item is a meeting note (or any local note)
  render the existing desktop `MeetingView`; local notes not yet on the server are merged into the tree as
  private meeting rows. Pages → shared page editor; folders → shared folder view; templates → shared.
- Offline (API status 0): sidebar keeps the local meeting notes and shows an offline line; server-only
  views (pages, folders, trash, share, templates) show a clear offline empty state instead of failing.
- Desktop-only items stay: recording, New meeting note, widget, local search (⌘K), conflicts, sync status,
  onboarding, Settings (desktop SettingsView; shared settings is another piece).
- **Slots for C3** (Assistant, My tasks, server search): nav items exist in the shared sidebar; on desktop
  they route to `apps/desktop/src/renderer/src/views/placeholder-view.tsx` until C3 fills them.

## Acceptance

- Same sidebar component and document/trash/share/templates components in both apps.
- Desktop: tree with folders (create/rename/move/drag), open/edit pages, trash restore/delete forever,
  share, templates gallery/editor, workspace create/join/leave/invite — natively, no "open in browser".
- Web behaviour and e2e selectors unchanged; web e2e for touched flows passes (axe).
- Unit tests for shared components with a fake client; renderer tests for desktop wiring.
- `pnpm run ci --fast` green; light + dark desktop screenshots of tree, page, trash, share, templates.

## Log

### Step 1 — shared workspace shell

- Created `@oat/workspace-ui` with the host context, shared route mapping, REST shell loader, tree
  model/optimistic state/actions, Private/Shared tree, trash dialog, workspace switcher and create/leave
  dialogs. The sidebar exposes all six host slots. No Next/Electron imports in the package.
- Web now provides its Next Link/router host and its command-menu, theme and account extras. Its server
  loader remains unchanged. Tree/navigation/avatar/event compatibility exports prevent duplicate models
  or same-tab document notifications. Existing tree/sidebar/dialog selectors and labels remain.
- Tests cover route round trips and malformed encoding, REST shell loading and failures, tree sections,
  page/folder creation, optimistic rollback, trash restore and empty trash (32 tests / 4 files).
- Initial `pnpm run ci --fast` passed typecheck, lint and tests, but caught an unformatted new test file;
  actionlint's Docker Hub pull also returned HTTP 429. Formatted the test and pulled the same pinned
  `rhysd/actionlint:1.7.12` image through `mirror.gcr.io`, tagging it locally. No CI/config changes.
- Final checks ran the fast gate's steps separately to avoid repeating unchanged checks:

```text
━━ ci summary (--only format,typecheck,lint,test)
step       status     time  note
format     pass      11.2s
typecheck  pass       6.3s
lint       pass       2.6s
test       pass       3.1s
total                23.2s

ci: ok

━━ ci summary (--only actionlint)
step        status     time  note
actionlint  pass       0.4s
total                  0.4s

ci: ok
```

- `pnpm --filter @oat/web build` (final):

```text
✓ Compiled successfully in 1261ms
  Finished TypeScript in 5.7s ...
✓ Generating static pages using 7 workers (50/50) in 274ms
```

- Logs: `/home/ubuntu/oat-workspace-ci.log` (initial),
  `/home/ubuntu/oat-workspace-ci-final.log`, `/home/ubuntu/oat-workspace-actionlint.log`,
  `/home/ubuntu/oat-workspace-build-final.log`.
- No commits or pushes. UI is visually unverified; web e2e/axe were not run in this handoff. Desktop
  integration, documents/sharing and templates remain later steps. ZIP export still requires a transport
  that supports binary Responses (the existing desktop bridge does not).

### Step 2 — shared document surfaces

- Committed step 1 locally as `8b08aee` (`feat(workspace-ui): shared sidebar, tree and workspace switcher`);
  not pushed.
- Moved sharing and autosave into the package using the host client; retained serialized optimistic
  sharing writes/rollback and versioned autosave/rebase/conflict/retry behavior. `PageEditor` renders
  the shared title, real editor, visibility/date, actions and trash banner without web extras. Its
  context/surface slots retain web's enhancement/history, preview, pipeline, Notion, assistant,
  task-assignee and TopBarActions behavior. Web supplies its keepalive save and hard-reload overrides.
- Moved folder header/actions/contents into `FolderView`, with host links and `ShellFolderView` for
  shell-derived children. Page primitives live in the package; web retains BackLink and re-exports
  them. Removed the old share, autosave and folder-action implementations.
- Fake-client tests exercise title/body saves with baseVersion (using the real editor), rebase,
  conflicts/reload, failed saves/retry, readonly/empty/trash states, keepalive override, sharing
  changes/errors/rollback, and normal/empty/shell-derived folder lists.
- Shared package: 5 test files / 46 tests passed, including 14 new document-surface tests. Platform
  import and ziiz vocabulary scans passed; moved document/folder data-testid attributes are unchanged.
- Initial `pnpm run ci --fast`:

```text
━━ ci summary (--fast)
step        status     time  note
format      pass      13.4s
actionlint  pass       0.3s
typecheck   pass       6.8s
lint        pass       7.3s
test        pass       5.3s
total                 33.1s

ci: ok
```

- Final diff review added conflict-toast dismissal after native reload plus reload-error/trash tests.
  Re-ran affected gates (actionlint inputs unchanged):

```text
━━ ci summary (--only format,typecheck,lint,test)
step       status     time  note
format     pass      14.0s
typecheck  pass       7.5s
lint       pass       3.5s
test       pass       6.5s
total                31.6s

ci: ok
```

- Final `pnpm --filter @oat/web build`:

```text
✓ Compiled successfully in 1648ms
  Finished TypeScript in 7.2s ...
✓ Generating static pages using 7 workers (50/50) in 476ms
```

- Logs: `/home/ubuntu/oat-workspace-step2-ci.log`,
  `/home/ubuntu/oat-workspace-step2-ci-final.log`,
  `/home/ubuntu/oat-workspace-step2-build-final.log`.
- No known web behavior loss. UI remains visually unverified; web e2e/axe have not run in this step.
  Desktop integration remains later work, including a public web origin for copied share links
  (the extracted dialog retains web's current-origin URL construction). Step 2 is committed locally
  with `feat(workspace-ui): shared page editor, share dialog and folder view`; nothing pushed.

### Step 3 — shared templates and public share-link origin

- Added required `WorkspaceHost.appOrigin`; web supplies its browser origin, and ShareDialog uses the
  host's public web origin rather than the renderer origin. Updated host fakes and added a clipboard
  regression using a different desktop-renderer/web origin, including a trailing-slash origin.
- Moved template editor, preview, icon, duplicate and delete controls into the package; deleted the
  web implementations and template-client wrapper. Mutations use `host.client.templates` and host
  navigation/refresh. Added `TemplatesGallery`, `TemplateView` and `NewTemplateView`: server-provided
  initial data is used without fetching, otherwise they load through the typed client. Web pages
  remain server components with their existing metadata, authorization loaders and 404 behavior.
- Gallery uses a wider calm content column, flat bordered card grid, ramp/type roles and default
  corner shapes, following the clone library/header references. Kept existing test IDs and card
  accessible-name ordering. Preview placeholder lines are no longer pill-shaped.
- Template application on web lives in `document/enhance/enhance-controls.tsx` (Enhance/Regenerate),
  not a separate new-note-from-template flow. Extracted its lazy template menu as `TemplatePicker`;
  web retains enhancement orchestration and passes selection/history slots. Existing enhance selectors
  and accessible trigger labels remain unchanged.
- Browser safety: the only runtime dependency of `@oat/ai/templates` is Zod; its core imports are
  type-only. All shared runtime AI imports use this subpath, not the package root. An in-memory Vite
  browser-library build reported:

```text
@oat/ai/templates browser bundle: pass (ES bundle, no external runtime imports)
```

- Fake-client coverage: initial/client-loaded/empty/error/retry gallery, loaded/editable/error detail,
  creation and viewer denial, duplicate/delete success and failure, picker selection/empty/error, and
  copied share-link origin. Final shared suite: 6 files / 62 tests passed. Platform-import/ziiz scans
  and moved-template test-ID checks passed.
- `pnpm run ci --fast`:

```text
━━ ci summary (--fast)
step        status     time  note
format      pass      13.1s
actionlint  pass       0.4s
typecheck   pass       7.1s
lint        pass       7.2s
test        pass       6.8s
total                 34.6s

ci: ok
```

- Final review preserved the original card text order and added an exact accessible-name assertion
  plus empty-picker coverage. The new assertion initially assumed a space between adjacent inline
  name/badge spans; corrected it to the original adjacent-span accessible name. Final affected gates
  (actionlint inputs unchanged):

```text
━━ ci summary (--only format,typecheck,lint,test)
step       status     time  note
format     pass      11.5s
typecheck  pass       5.4s
lint       pass       3.3s
test       pass       6.1s
total                26.3s

ci: ok
```

- Final `pnpm --filter @oat/web build` (only the test expectation changed afterward):

```text
✓ Compiled successfully in 949ms
  Finished TypeScript in 5.5s ...
✓ Generating static pages using 7 workers (50/50) in 339ms
```

- Logs: `/home/ubuntu/oat-workspace-step3-ci.log`,
  `/home/ubuntu/oat-workspace-step3-ci-final.log` (intermediate assertion failure),
  `/home/ubuntu/oat-workspace-step3-ci-final2.log`,
  `/home/ubuntu/oat-workspace-step3-build-final.log`.
- No known web functionality loss. UI is visually unverified; web e2e/axe were not run. Desktop host
  wiring must supply its configured public web origin. Committed locally with
  `feat(workspace-ui): shared templates`; nothing pushed.

### Step 4 — desktop workspace host, sidebar and content routing

- New renderer `workspace/` files hold the host, API observation, REST/local shell data, sidebar slots,
  account items and routes; `views/placeholder-view.tsx` is the named C3 integration slot. Main window
  holds an `AppRoute`; its old sidebar block is replaced with `DesktopSidebar`. Existing MeetingView,
  HomeView, onboarding, prompt/auto-stop, recording controls and SettingsView remain in place.
  `shell-menus.tsx` only adds controlled-open support to DesktopSearch, without changing local search
  results or shortcut handling. New meeting note moves into the primary-action slot, keeping its ID,
  click behavior and shortcut; collapsed-sidebar controls use icon sizing.
- Desktop host uses the existing `api`, stable hash-anchor Link, package hrefs, state navigation and
  shell refresh. Network status follows `OatApiError.status === 0`; a failed shell load also falls back
  to local data. Added only public `appOrigin` to the existing validated `app:info` response, derived
  from main's `config.webUrl` (also the API base). No new IPC channel, session data or credentials.
  Share links cannot be copied until that origin is available.
- Shell data loads with `loadShellData(api, user)` and reloads after refresh, active-workspace changes,
  sync completion and the browser online event. Local-only notes are merged into the active workspace
  as private meeting nodes, excluding IDs already live or trashed; local titles remain immediate while
  server tree/access metadata stays authoritative. Offline/failed-load fallback uses the local workspace
  snapshot, local notes and matching cached tree data. REST workspace mutations sync membership and
  update main's local recording target through existing `sync:now`/`workspaces:set-active`; recording
  creation is disabled while the displayed and local active workspaces disagree.
- Shared AppSidebar slots: 48px drag strip, New meeting note, local-search trigger, ConflictsPanel,
  SyncLine/offline line and desktop account actions. Kept `signed-in`, `signed-in-email`, `home-nav`,
  `meeting-list-item`, `data-document-id`, recording dot and new-meeting IDs. Updated desktop e2e
  section/empty selectors to shared tree IDs, workspace menu assertions to member counts, and native
  workspace-settings/hint wording. The old separate sidebar/workspace menu is no longer rendered.
- Routes: Home remains existing home/meeting surface; local or known meeting documents remain
  local-first MeetingView. Meeting-open events/search/recording carry a meeting hint so they still open
  locally even before appearing in the roster. Pages load through the proxy into PageEditor, folders
  use ShellFolderView and live shell metadata/children, and templates use shared client-loaded views.
  Server surfaces have an independently scrollable/selectable content area and layout-matched loading,
  unavailable and offline states (including retry). Recording controls remain available while browsing
  them. Meeting actions expose shared sharing and trash without replacing the local editor.
- Settings/member-invite routes map to existing desktop SettingsView. Assistant, My tasks and server
  Search show neutral C3 placeholders; Join uses the allowed placeholder (no trivial native join view
  existed). Profile (web), meeting widget, connection check and sign-out remain account actions. Native
  toast feedback is mounted for shared mutations and account feedback.
- Shared trash/share dialogs show calm offline empty states rather than issuing server-only requests.
  Desktop LeaveWorkspaceDialog hides ZIP export and explains that export is available on the web;
  web export is unchanged. Create/switch/leave, page/folder operations and sharing use the API proxy.
- Tests: desktop now 59 files / 513 tests (14 added), shared workspace UI 6 files / 63 tests (one added).
  Renderer coverage includes API tree/page editor, local-only meeting routes, missing-roster search
  hits, cold offline/local fallback, page offline/retry and 404, offline trash/share, empty folder and
  post-sync metadata, C3 placeholder, recording controls during navigation, existing shell actions and
  shortcuts. Helper tests cover merge/dedup/trash/workspace filtering, unknown roles, network status
  versus authorization refusal, and REST/local workspace switch ordering. Shared test covers hidden
  desktop ZIP export.
- Initial `pnpm run ci --fast`:

```text
━━ ci summary (--fast)
step        status     time  note
format      pass      11.8s
actionlint  pass       0.3s
typecheck   pass      21.1s
lint        pass       6.0s
test        FAIL      23.2s  pnpm run test --concurrency=4 exited with 1
total                 62.5s

ci: FAILED (test)
```

- Fixed unstable Link identity during host updates, scoped the existing search-result assertion to
  the dialog (sidebar now contains the same page title), scoped account feedback versus its toast,
  removed a new hook dependency warning, and added an explicit local-meeting route hint for search
  hits absent from the roster. Final review added content scrolling, collapsed-button sizing and live
  folder metadata coverage. Final affected gates (actionlint inputs unchanged):

```text
━━ ci summary (--only format,typecheck,lint,test)
step       status     time  note
format     pass      10.9s
typecheck  pass       8.2s
lint       pass       4.9s
test       pass      12.3s
total                36.2s

ci: ok
```

- `pnpm --filter @oat/desktop exec electron-vite build`:

```text
out/main/index.js  1,401.57 kB
✓ built in 285ms
out/preload/index.cjs  239.16 kB
✓ built in 35ms
out/renderer/assets/main-window-D7ih0Ako.js  1,075.46 kB
(!) Some chunks are larger than 500 kB after minification. Consider:
✓ built in 646ms
```

- The chunk-size warning is a bundle-size warning, not a missing-environment/build failure; no build
  configuration changes or warning suppression. Install's deprecated-subdependency notices likewise
  did not indicate a missing environment (all dependencies resolved; typecheck/lint/build passed).
- Logs: `/home/ubuntu/oat-workspace-step4-ci.log` (initial failures),
  `/home/ubuntu/oat-workspace-step4-ci-reviewed.log`,
  `/home/ubuntu/oat-workspace-step4-build-reviewed.log`.
- UI is visually unverified; desktop/web e2e and axe were not run. Full task visual/e2e acceptance and
  C3 placeholder integration remain separate work. Local commit:
  `feat(desktop): shared workspace sidebar, pages, trash, share and templates`; nothing pushed.

### Step 5 — visual evidence and web e2e

- Built desktop with `pnpm --filter @oat/desktop exec electron-vite build`, served only the built
  renderer on localhost and drove Chromium through Playwright with a stubbed `window.oat`. No earlier
  capture helper was present on this machine; the earlier task notes describe the same built-renderer
  approach. Reusable capture sources are retained at `/home/ubuntu/evidence/c2/capture-desktop.mjs`
  and `capture-web.ts` (the latter reuses web's hydration and `seedSweepContent` helpers).
- Desktop fixture: signed-in user, completed onboarding, three local meeting notes (including two
  absent from REST), two folders and a nested page, private/shared pages and meetings, two trash items,
  real TipTap heading/paragraph/list content, sharing settings and built-in/custom templates. Offline
  is the bridge network-error envelope that `bridgeTransport` maps to `OatApiError.status === 0`, not
  just a forced CSS empty state. Verified local-only notes remain in the sidebar while the page shows
  the offline state. Both themes captured at exactly **1280×800**.
- Screenshots inspected (all under `/home/ubuntu/evidence/c2/`):
  - `desktop-tree-light.png`, `desktop-tree-dark.png` — Home with expanded Projects and nested page.
  - `desktop-page-light.png`, `desktop-page-dark.png` — page content after autosave settles.
  - `desktop-trash-light.png`, `desktop-trash-dark.png` — two trashed items.
  - `desktop-share-light.png`, `desktop-share-dark.png` — sharing controls open.
  - `desktop-templates-light.png`, `desktop-templates-dark.png` — shared gallery.
  - `desktop-offline-light.png`, `desktop-offline-dark.png` — local notes retained, page offline.
  - `web-tree-light.png`, `web-tree-dark.png`, `web-templates-light.png` — authenticated, real API/DB
    comparison surfaces using the compose-backed e2e server, not stubbed web responses.
- Visual review caught the desktop workspace member count dropping from 4 to 1 offline: local
  snapshots do not contain member counts. `localShellData` now retains cached member counts/icons by
  workspace ID, without overriding the current local role/name or leaking metadata across workspaces.
  Added a helper test for cached count/icon, a downgraded viewer role and an uncached workspace. Rebuilt
  and re-captured after the fix. No overlap/clipped controls found; gallery content naturally continues
  below the 800px viewport. Desktop's 48px drag area/primary action and web's top-bar action remain
  intentionally platform-specific. The offline fixture retains main's last-success sync glyph alongside
  the explicit Offline label because its main sync snapshot stays idle; API status is tracked separately.
- Final capture logs: `desktop-capture-final.log`, `desktop-console.json`, `web-capture.log`,
  `web-console.json` in the evidence directory. Both console summaries:

```json
{ "errors": [] }
```

- `DATABASE_URL=postgres://oat:oat@localhost:54329/oat pnpm dev:up` built missing local images and
  started all five healthy services; Docker Hub did not return 429 on this run, so no mirror retagging
  was needed. Initial web setup could not launch Chromium (missing Playwright-managed browser).
  Checked the environment/cache, installed with `pnpm --filter @oat/web exec playwright install
  chromium`, then reran the same selected specs. No application code changed to address setup.
- Web command:

```sh
DATABASE_URL=postgres://oat:oat@localhost:54329/oat E2E_PORT=3126 E2E_WORKERS=2 \
  pnpm --filter @oat/web exec playwright test \
  e2e/documents.spec.ts e2e/private-shared.spec.ts e2e/sharing.spec.ts \
  e2e/templates.spec.ts e2e/workspaces.spec.ts e2e/a11y.spec.ts
```

```text
  1 skipped
  24 passed (2.8m)
```

- Zero failed tests. The skipped template dark-editor case explicitly requires `E2E_SCREENSHOTS`
  (screenshot-only, not a failure); dark route/axe and desktop template gallery coverage ran. Route axe
  scans, sidebar axe and leave-dialog axe passed light/dark. Console guards passed. The Next dev server
  emitted the known share-404 theme-script warning (already documented in `5.3-sharing.md` and narrowly
  filtered by `sharing.spec.ts`) and one `The destination stream errored while writing data.` diagnostic;
  the latter was not diagnosed, no browser capture error occurred, and all selected tests passed. No
  root-layout/streaming changes made outside this task. Full log: `/home/ubuntu/oat-c2-web-e2e-final.log`;
  initial browser-install failure log: `/home/ubuntu/oat-c2-web-e2e.log`.
- Final affected CI after the offline metadata fix (`/home/ubuntu/oat-c2-fixes-ci.log`):

```text
━━ ci summary (--only format,typecheck,lint,test)
step       status     time  note
format     pass      14.3s
typecheck  pass      11.0s
lint       pass       6.1s
test       pass      15.1s
total                46.6s

ci: ok
```

- Desktop: 59 test files / 514 tests passed. Shared workspace UI: 6 files / 63 tests passed. No
  actionlint inputs changed since the recorded passing fast gate. Final desktop build log:
  `/home/ubuntu/oat-c2-fixed-build.log`, renderer `✓ built in 1.04s`; unchanged large-chunk warning.
- Requested visual/web verification complete. Native Electron/macOS window chrome, actual recording
  and native desktop e2e were not run on Linux; desktop evidence uses the requested stubbed bridge.
  Join and C3 routes remain the placeholders explicitly allowed in Step 4. Screenshots/capture scripts
  live outside git at the requested persistent evidence path. Fix and docs committed locally; no push.

### Step 6 — merge shared-settings base (PR #24)

- Ran `git fetch origin devin/1795304500-parity-integration && git merge FETCH_HEAD`, merging
  `0f9060e95ffb2d864f8690743ff946139c634587` into this branch, no rebase/force/push.
- Seven content conflicts resolved:
  1. `apps/desktop/src/renderer/src/windows/main-window.tsx`: retain workspace host/sidebar and
     route-based meeting/document behavior, plus #24 SettingsView props, workspace context,
     recording/stopping guard, setup and workspace-exit callbacks. Settings section derives from
     the workspace route; new `workspace/settings-section.ts` maps `workspace/members` to `members`,
     preserves workspace/profile/preferences/integrations/device sections and defaults safely.
  2. `apps/desktop/src/renderer/src/styles.css`: keep both workspace-ui and settings-ui imports.
  3. `apps/web/src/app/globals.css`: keep both workspace-ui and settings-ui imports.
  4. `apps/web/src/components/workspace/workspace-avatar.tsx`: use #24 settings-ui re-export; make
     workspace-ui's avatar a re-export of the same component to avoid duplicate implementations.
  5. `packages/settings-ui/src/danger-zone.tsx`: keep #24 services and local shared leave dialog;
     discard obsolete web server-action/workspace-ui imports (no app imports or package cycle).
  6. `packages/workspace-ui/src/leave-workspace-dialog.tsx`: adapt settings-ui's shared dialog to
     WorkspaceHost; REST leave still closes/navigates Home/refreshes. Optional host export callback
     uses native file saving on desktop, while web retains REST Response/blob download and 429
     handling. No Electron/bridge/Next imports in the shared package. The old desktop web-only notice
     is removed. Recording/stopping blocks leaving; export remains available.
  7. `docs/LOG.md`: retain both C1 and C2 histories and append this integration entry.
- `docs/PLAN.md`, `shell-menus.tsx`, desktop main/bridge and the lockfile auto-merged. Preserved the C1
  task entry and C2 completed steps. Retained shell-menus' controlled local search and #24's section
  callback changes. Updated the newer workspace account slot's stale Profile (web) action to in-app
  Profile, eliminating the last renderer call to removed `settings:open-web`.
- Removed workspace-host's extra Toaster: only #24's theme-aware `DesktopToaster` in renderer
  `main.tsx` mounts for the main window. Desktop host supplies `settings:export-notes`, mapping native
  cancel to null and zero notes to 0. Existing main-owned authorization, save dialog and streaming
  implementation is untouched. Added workspace-ui dependency on settings-ui and ran
  `pnpm install --config.strict-dep-builds=false` (exit 0); regenerated lockfile preserves both packages.
- Tests added/updated: desktop settings route mapping (normal, default/unknown, nested members),
  shell clicks for Invite members / Workspace settings / Profile, native host export success/empty/
  cancellation/error (assert no text-proxy export), and recording-time leave blocking.
- `pnpm run ci --fast` initially: format/actionlint/test pass; typecheck/lint failed on new Testing
  Library `exact` options and missing caught-error cause. Fixed both; a dependent desktop typecheck
  then exposed the other new `exact` option, also fixed. Final affected gates:

```text
━━ ci summary (--only format,typecheck,lint,test)
step       status     time  note
format     pass      10.7s
typecheck  pass      14.2s
lint       pass       5.2s
test       pass      12.2s
total                42.3s

ci: ok
```

- Actionlint passed in the initial `--fast` run (`0.3s`); its inputs did not change afterward.
  Workspace-ui and desktop tests ran through CI's package test tasks (not skipped):

```text
Desktop:      Test Files 61 passed (61)   Tests 527 passed (527)
Workspace UI: Test Files  6 passed (6)    Tests  67 passed (67)
Settings UI:  Test Files  2 passed (2)    Tests  12 passed (12)
```

- Final `pnpm --filter @oat/desktop exec electron-vite build`: exit 0, renderer
  `✓ built in 659ms`. Existing chunk-size warning remains; no build-config changes.
- Logs: `/home/ubuntu/oat-workspace-step6-install.log`, `oat-workspace-step6-ci.log` (initial fast
  gate), `oat-workspace-step6-ci-final.log` (dependent type error), `oat-workspace-step6-ci-reviewed.log`
  (final affected gates), `oat-workspace-step6-build-final.log`, all under `/home/ubuntu/`.
- Post-merge UI is visually unverified; did not rerun web e2e/axe or native macOS Electron/file-save
  interactions in this step. Step 5 screenshots are pre-merge evidence, not proof of the new settings
  surfaces. Merge committed locally; nothing pushed.
