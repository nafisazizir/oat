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
