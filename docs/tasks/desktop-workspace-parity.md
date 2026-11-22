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
