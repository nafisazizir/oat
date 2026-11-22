# functional-parity — Desktop/web functional parity audit

status: done
milestone: M9 · deps: api-foundation, settings-parity, desktop-workspace-parity, desktop-feature-search · branch: devin/1795313872-parity-audit

## Goal

Inventory the shipped web and desktop surfaces after PR #28, before choosing the next parity work.
The Before inventory is a source audit, not a claim of runtime equivalence. The After column tracks
subsequent completed implementation groups: G2/G5, G3/G14/G13 and G7/G11.

## Context

Read with `docs/SPEC.md`, `docs/PLAN.md`, `docs/DECISIONS.md` (last entry **D-38**), and
the four dependency task files above. D-28 preserves desktop local-first notes; D-32 permits browser
tab capture and device-local browser audio; D-35 deliberately does not introduce signup/password/reset
routes or a web onboarding wizard. D-36 defines one kind of workspace. D-38 defines shared APIs.

## Scope

In: all App Router page files, renderer view dispatch, mounted shared surfaces, main-process UX,
browser exits, state/feedback and keyboard bindings. Original audit excluded changing product code, new decisions,
production access, real invitations, runtime/visual/native permission verification. API route handlers
are not pages; their UX is accounted for at their callers (including OAuth/consent and auth handoff).

## Acceptance criteria

- [x] Every web page route and desktop view is mapped below, including exceptional states.
- [x] Menus/dialogs, shortcuts, feedback and local-only capabilities have source references.
- [x] External-opening call sites and indirect anchor/window navigation are inventoried.
- [x] Differences have a proposed disposition and S/M/L estimate; platform differences are explicit.
- [x] Documentation-only diff checked and committed locally; no push authorized.

## Verification

Static enumeration: `rg --files apps/web/src/app` filtered for page/layout/loading/error/not-found;
read renderer dispatch and mounted imports, not just package exports. Search desktop/shared code for
`openExternal`, `shell.open`, `open-external`, `OAT_WEB_URL`, `BETTER_AUTH_URL`, `window.open`,
`target=`, keyboard handlers, dialog titles and notification/toast sites. Read `apiProxyUrl` and
the client route collector. Formatting: `pnpm exec prettier --check docs/tasks/functional-parity.md docs/PLAN.md docs/LOG.md`.
Diff integrity: `git diff --check` and `git status --short`. Global CI/build/e2e gates are intentionally
not run for a documentation-only audit; no UI, DB or native behavior changed.

## Design notes

### Reading the matrix

**Before** means the checked-out main after PR #28, not the earlier dependency briefs' historical
descriptions. Paths are relative to the repository. Shorthands below expand to concrete directories:

- **W** = `apps/web/src`; **D** = `apps/desktop/src/renderer/src`; **M** = `apps/desktop/src/main`.
- **WS** = `packages/workspace-ui/src` (`@oat/workspace-ui`);
  **SET** = `packages/settings-ui/src` (`@oat/settings-ui`);
  **FEAT** = `packages/feature-ui/src` (`@oat/feature-ui`);
  **MEET** = `packages/meeting-ui/src` (`@oat/meeting-ui`).
- **G** identifies actionable functional gaps; **P** intentional platform distinctions; **=** shared
  or equivalent behavior with no proposed work. Effort is proposed implementation size, not audit size:
  S localized adapter/control; M shared extraction or a multi-surface flow; L cross-storage lifecycle.
  A dash means no fix. Grouped rows explicitly enumerate the contained surfaces.

### Before parity matrix and implementation status

G2/G5 implementation: extract the web join list into framework-neutral workspace-ui, use existing
typed APIs and host callbacks, preserve browser server-side bootstrap, add authoritative API loading
and no-workspace bootstrap on desktop, sync/select memberships locally after joining. Keep existing
auth-panel/list presentation and native recording controls. Google calendar entry navigates within
the desktop WorkspaceHost; provider consent still uses the secure browser flow from Integrations.
Shared upcoming-row extraction is deferred (different local sources/actions).

G3/G14/G13: share authenticated invite response states, declare a token lookup API, validate native
invitation links in main and queue route delivery across sign-in/setup. Both palettes use a shared
host-command builder. Search tabs and task filters live in AppRoute and serialize to web-compatible
query parameters. Full desktop history/restart restoration remains G1, not part of this group.

| Surface | Web | Desktop | Source (shared pkg / app-local path) | Gap & proposed fix | Effort (S/M/L) | After / status |
| --- | --- | --- | --- | --- | --- | --- |
| Root, shell and navigation | `/` redirects `/home`; authenticated `(app)` layout, responsive sidebar/top bar | `#/widget` chooses widget; every other window hash chooses main; signed-in main owns in-memory `AppRoute`, initially Home | W/app/page.tsx, W/app/(app)/layout.tsx, W/components/app-shell/app-shell.tsx; D/routes.ts, D/windows/main-window.tsx; WS/routes.ts | **G1:** desktop app routes are not restored from hash/history; add explicit native route/history/deep-link handling, not a web renderer fallback | M | — |
| Sign in | `/sign-in`, `/sign-in/confirm`: email magic link, first sign-in is signup | Signed-out, signing-in, rejected/cancel/reopen-browser states; dev-only pasted handoff | W/app/(auth)/sign-in/{page.tsx,sign-in-form.tsx,confirm/page.tsx}; D/windows/main-window.tsx; M/auth.ts | **P1:** retain browser identity flow, no embedded credentials/password UI | — | — |
| Desktop identity handoff | `/desktop/sign-in` and `desktop-handoff.tsx`, authenticated browser handoff to `oat://auth` | Main matches nonce/state, redeems handoff and stores session; renderer receives user/status only | W/app/(auth)/desktop/sign-in/{page.tsx,desktop-handoff.tsx}; M/auth.ts, M/token-store.ts | **P1:** retain security boundary | — | — |
| Join workspace | `/join`: invitations, domain join/request/pending, create-own or back; auto-provision/redirect if no choices | `view: join` renders only “Join a workspace” placeholder | W/app/(auth)/join/page.tsx, W/components/workspace/join-choices.tsx; D/workspace/desktop-routes-view.tsx | **G2:** share JoinChoiceList using client joinable/join/request/accept/decline APIs and host navigation; include no-workspace bootstrap | M | Implemented: WS/join-choices.tsx + join-workspace.tsx use typed client APIs; web adapter and desktop JoinRoute share invite/domain/request/pending/create/back; desktop bootstraps only after an authoritative empty API response and syncs/selects joined memberships locally. |
| Invite landing | `/invite/[token]`: signed-out/sign-in, invalid/inaccessible and accept/decline flow | No invite-token route/OS link dispatch to a native invite view | W/app/(auth)/invite/[token]/page.tsx, W/components/workspace/invite-response.tsx; M/auth.ts, D/windows/main-window.tsx | **G3:** keep email/browser landing but offer verified native handoff; share authenticated invite-response UI with G2 | M | Implemented: WS/invite-response.tsx is shared by both hosts; typed POST /api/invites/lookup plus existing accept/decline; invalid/expired/revoked/used/wrong-account/member/retry states. Main validates only canonical oat://invite/<32-character base64url token>, retains pending navigation across sign-in/setup and delivers via validated bridge. Browser/email remains default; authenticated recipients get optional Open in Oat desktop. |
| Public share link | `/share/[token]` read-only document/transcript viewer, separate layout and unavailable/not-found | No anonymous share viewer or share-token AppRoute | W/app/share/{layout.tsx,[token]/page.tsx,[token]/not-found.tsx}; WS/share-dialog.tsx | **P2:** public browser viewer is appropriate; optional Open in Oat only after auth/read authorization, never import share tokens into arbitrary API requests | — | — |
| Home notes | `/home` lists all shell documents except folders | Home lists local meeting summaries, grouped by date, recording marker | W/app/(app)/home/page.tsx, W/components/document/home-notes.tsx; D/meetings/home-view.tsx | **G4:** share home list model and merge accessible server pages/meetings with local pending meetings; retain offline local rows | M | — |
| Upcoming calendar | Embedded Home list, Google connect/error/no-upcoming/start/open/join-call states; no `/calendar` or `/upcoming` page | Home UpcomingList merges local calendar and Google, existing-note cross-workspace hints | W/components/calendar/{upcoming-meetings.tsx,upcoming-meeting-row.tsx,google-calendar-actions.tsx}; D/calendar/{upcoming-list.tsx,calendar-state.ts}; M/calendar-service.ts | **P3/G5:** keep EventKit source; extract common upcoming row/actions and send desktop Google-connect to native Integrations, not browser settings | M | Implemented: Google CTA navigates directly to native Settings → Integrations (including empty compact Home); main no longer has a browser-connect callback. EventKit remains native; row extraction deferred. |
| Plain document | `/d/[docId]`, editor, title, save/retry/reload/view-only/trash banner, block focus | Native DocumentRoute fetches and renders PageEditor/BlockFocus when online | WS/page-editor.tsx, WS/use-autosave.ts; W/components/document/{document-editor.tsx,block-focus.tsx}; D/workspace/desktop-routes-view.tsx; packages/editor/src/react | **G6:** web wrapper also supplies task-assignee query and Notion actions; extract those adapters into shared editor composition (see G8/G10) | M | — |
| Folder document | Same `/d/[docId]` dispatch, folder contents and actions | DocumentRoute resolves folder via folder tree and ShellFolderView | WS/folder-view.tsx, WS/folder-actions.tsx; W/app/(app)/d/[docId]/page.tsx; D/workspace/desktop-routes-view.tsx | **=:** shared folder surface | — | — |
| Meeting document and transcript | MeetingNote wraps DocumentEditor; live/stored transcript, resizable panel, participants, playback, recording | Local MeetingView/OatEditor, local autosave/transcript/playback; selected for kind=meeting or known meeting node | W/components/meeting/meeting-note.tsx; D/meetings/{meeting-view.tsx,note-autosave.ts,meetings-state.ts}; MEET/{side-panel.tsx,participant-summary.tsx} | **G7:** server-discovered meeting routes still dispatch local-only MeetingView; add authorized server read fallback/read-through cache for meetings absent locally, without replacing local writes | L | Implemented and unit/fast-gate verified: main MeetingReadThrough uses typed document/workspace reads and paginated sync.backfill. Complete authorized subtrees are cached atomically without outbox echo or cursor changes; existing local documents/pending writes win. Edits retain local autosave/outbox; loading, web-equivalent unavailable, offline/not-cached and retry states. |
| Document-scoped assistant | Toggle, side panel, document scope, proposals flush/adopt current open editor; Cmd/Ctrl+J | Global Assistant only; no mounted document assistant wrapper around PageEditor/MeetingView | W/components/assistant/{document-assistant.tsx,open-document.tsx}; FEAT/{assistant-chat.tsx,assistant-integration.tsx}; D/windows/feature-views.tsx | **G8:** extract panel/editor-registration composition with desktop settle/adopt bridge; do not equate global Assistant with note-scoped support | L | Shared FEAT/document-assistant.tsx and open-document.tsx on both hosts; native meeting flush/sync/server-visible preflight and explicit-approved meeting:save/outbox with a captured pre-approval write base; page editor retains its existing server-backed settle/adopt path. Unit/affected fast gate and assistant/document browser checks pass; native runtime/visuals unverified. |
| Manual enhance/regenerate | Meeting Enhance toolbar, template choice, streaming preview/error, version history/restore/undo, changed-while-writing choice | Post-meeting pipeline status/retry and grace line only; no manual enhancement/version controls mounted | W/components/document/{document-editor.tsx,enhance/}; D/meetings/{meeting-view.tsx,post-meeting.tsx}; FEAT/chat-session.tsx is not enhancement UI | **G9:** extract enhancement/history controls and integrate version-safe local flush/sync/adopt before server mutation | L | — |
| Notion per-document action | Send/update, status, open exported page, error/retry/consent guidance in overflow | Shared connection/target settings but no per-note send/update/open action | W/components/notion/notion-export-button.tsx; W/components/document/document-editor.tsx; SET/integrations-panel.tsx; D/meetings/meeting-view.tsx | **G10:** share NotionExportButton through typed client, preflight local flush/sync on desktop | M | — |
| Meeting citations and positions | `?t=&seg=` opens transcript/selected moment; `?block=` highlights editor block | Routes retain query; plain pages consume block; local MeetingView accepts only documentId, not segment/time/block target | W/app/(app)/d/[docId]/page.tsx, W/lib/transcript.ts; D/workspace/desktop-routes-view.tsx, D/meetings/meeting-view.tsx; FEAT/workspace-adapter.tsx | **G11:** pass normalized focus to MeetingView and consume after transcript/editor load, including repeated citations on same note | M | Implemented and unit/fast-gate verified: native MeetingView reuses existing FEAT parseDeepLink/focusedLine and editor BlockFocus, opens/highlights the requested transcript moment after loading and seeks device-local audio when available. A document-navigation revision reapplies identical citations, including repeated block scroll/highlight. |
| Participant editor | Add/remove popover and participant summary for editable meeting | Same MEET summary; add/remove through local bridge | MEET/participants.tsx; W/components/meeting/meeting-note.tsx; D/meetings/meeting-view.tsx; M/meeting-notes.ts | **=:** common UI, preserve local versus REST writes | — | — |
| Workspace tree | Private/shared sections; expand/collapse, drag/move, new page/folder | Same AppSidebar/PageTree, server-backed tree with local meeting additions | WS/{app-sidebar.tsx,page-tree.tsx,tree-actions.tsx,optimistic-tree.ts}; D/workspace/use-desktop-shell-data.ts | **=:** mutations permission/online gated; no native-only replacement needed | — | — |
| Tree/context actions | Section add page/folder; item overflow rename/move; folder new page/folder inside; delete folder/trash note; inline rename and move chooser | Same mounted shared menus/dialogs | WS/{page-tree.tsx,tree-actions.tsx,folder-actions.tsx} | **=:** these are overflow/dropdown menus, not a separate OS right-click menu | — | — |
| Page actions/sharing | Header save state/share; overflow history/Notion where applicable | Plain PageEditor default trash/share; local meeting separate share/trash strip | WS/{page-editor.tsx,share-dialog.tsx}; D/workspace/desktop-routes-view.tsx; W/components/document/document-editor.tsx | **G12:** unify action slots so local meetings get normal trash/restore/read-only affordances and same placement; retain G9/G10 actions | M | — |
| Share dialog | Immediate visibility/access save, public link/copy/revoke, permission/error feedback | Same ShareDialog, builds public URL with host appOrigin | WS/share-dialog.tsx; D/workspace/desktop-host.tsx | **=:** do not invent local file share semantics | — | — |
| Trash | Dialog list, restore/delete forever and confirmations; undo toast when trashing | Same shared TrashDialog/tree actions online; local meetings show read-only trashed badge | WS/{trash-dialog.tsx,tree-actions.tsx}; D/meetings/meeting-view.tsx | **G12:** restore/delete controls should also be discoverable inside a trashed local meeting | M | — |
| Templates gallery | `/templates`, filters/gallery empty/loading/error, duplicate/delete | `templates` view uses same gallery | WS/templates-gallery.tsx, WS/template-resource.tsx; D/workspace/desktop-routes-view.tsx | **=:** server-backed/online requirement intentional for now | — | — |
| Template detail/new | `/templates/[id]`, `/templates/new`; title/body editor, preview, save/unsaved/delete/duplicate | `template`, `template-new` same views | WS/{template-view.tsx,template-editor.tsx,template-preview.tsx,delete-template-dialog.tsx,duplicate-button.tsx}; W/app/(app)/templates | **=:** shared UI; template application to enhancement missing separately in G9 | — | — |
| Template picker | Enhance template selection | No manual Enhance picker mounted in local meeting | WS/template-picker.tsx; W/components/document/enhance/enhance-toolbar.tsx | **G9:** mount as part of enhancement flow, not another template implementation | L | — |
| Search full page | `/search?q=&type=`; notes/transcripts tabs, highlights, counts/pagination/retry | `search` route q, controlled local tab state, local + server dedupe/fallback | FEAT/{search-view.tsx,use-search.ts,sources.ts}; W/components/search/search-view.tsx; D/windows/feature-views.tsx, D/sync/local-search-source.ts | **P4/G13:** retain offline/local search; persist desktop tab in route state together with G1 rather than reset on remount | S | Implemented: AppRoute stores q/type; desktop SearchView reads and updates route fields, retaining the tab when query changes. Shared route parsing/serialization and feature-target conversions retain validated values. Full history/restart restoration remains G1. |
| Command/search palette | Cmd/Ctrl+K; Go to Home/Tasks/Assistant/Templates/Settings; Pages; New note; Toggle sidebar; Light/Dark/System with checked theme | Same SearchDialog; Home/Assistant/Tasks/Settings/New meeting (when allowed), theme; no Templates/Pages/Toggle sidebar command groups or theme check marker | FEAT/search-dialog.tsx; W/components/app-shell/command-menu.tsx; D/windows/{shell-menus.tsx,feature-search.tsx} | **G14:** share host-command builder; distinguish New page from Start recording; keep native-only commands additive | S | Implemented: FEAT/host-commands.tsx builds both palettes: common navigation/Templates/Pages, New page, Toggle sidebar, settings sections, workspace switching and checked theme marker. Web keeps New note; desktop has guarded Start recording and native-only settings. |
| Tasks | `/tasks`, controlled assigned/status/due filters and URL state, grouped documents, due picker/assignee/checkbox, empty/error/pagination feedback | `tasks` same TasksView, local controlled filters | FEAT/{tasks-view.tsx,task-toggle.ts}; W/components/tasks/tasks-view.tsx; D/windows/feature-views.tsx | **G13:** preserve desktop filter state through route/history; content UI already shared | S | Implemented: AppRoute stores assigned/created/all, status and due filters; desktop TasksView is route-controlled. URL round trips validate/normalize filters. Full history/restart restoration remains G1. |
| Global Assistant | `/assistant?thread=`; new/existing threads, messages/citations, tools/proposal approve/deny, stream stop/retry/error | `assistant` view with threadId; same chat and proxy streaming | FEAT/{assistant-chat.tsx,chat-session.tsx,chat-message.tsx,proposal-card.tsx,answer.tsx}; D/windows/feature-views.tsx | **=:** shared global chat; local-only unsynced text is not automatically server assistant context | — | — |
| Preferences | `/settings` appearance Light/Dark/System; settings search | Settings preferences, same search/nav and appearance | SET/{index.tsx,preferences.tsx,theme-provider.tsx}; W/components/settings/web-settings.tsx; D/settings/settings-view.tsx | **=:** settings/theme shared | — | — |
| Profile | `/settings/profile`, name/role/team/vocabulary, load/save/error | Same profile panel; refreshes desktop user after edits | SET/profile-form.tsx; W/components/settings/web-settings.tsx; D/settings/settings-view.tsx | **=:** shared profile UI | — | — |
| Integrations | `/settings/integrations`: Google/Notion connect/disconnect, status, Notion target picker, pipeline settings, consent notices | Same panel, provider consent via one-use system-browser ticket, reload on focus | SET/{integrations-panel.tsx,notion-target-picker.tsx,pipeline-settings.tsx}; M/settings-io.ts | **P5:** provider OAuth stays browser-based; settings themselves are native | — | — |
| Workspace general | `/settings/workspace`: name/avatar, join policy/domain controls, export, leave/delete danger zones/confirmations | Same panels; native save-file export; blocks workspace exit while recording | SET/{general-form.tsx,join-settings.tsx,danger-zone.tsx,leave-workspace-dialog.tsx}; M/settings-io.ts | **P6:** save dialog/atomic ZIP file stays native; retain recording safety guard | — | — |
| Workspace members | `/settings/workspace/members`: members roles/remove, invite dialog, pending invites revoke/resend, join-request approve/decline, optimistic errors | Same MembersPanel and InviteDialog | SET/{members-panel.tsx,members-optimistic.ts,invite-dialog.tsx} | **=:** permission controls shared, no real invites sent during audit | — | — |
| Workspace account menu | Workspace selection, Settings, Members/Invite, Create, Join when choices, Leave; profile/preferences/sign-out | Same shared workspace menu + Settings/Profile/Show widget/Reconnect/Sign out | WS/{app-sidebar.tsx,create-workspace-dialog.tsx,leave-workspace-dialog.tsx}; W/components/app-shell/user-menu.tsx; D/workspace/desktop-account-items.tsx | **=:** common management actions; widget/reconnect intentionally desktop-specific; Join remains G2 | — | — |
| Switching workspaces | Server active workspace, router refresh/loading, error toast | Shared switchActive/refresh then reconciles main snapshot; local creation fallback hints; in-memory route is retained | WS/app-sidebar.tsx; W/components/app-shell/app-shell.tsx; D/workspace/use-desktop-shell-data.ts; D/workspaces/workspaces-state.ts; M/workspaces.ts | **P7:** retain offline/local workspace snapshots and recording-aware creation guards; test switch during recording before changing policy | — | — |
| Recording setup/settings | Browser per-session permission/device selection; no device settings routes | Settings Recording: auto-stop/in-person controls; auto-enhance is in shared Integrations pipeline settings; Setup permission status + rerun walkthrough; Storage panel | D/settings/{recording-settings.tsx,setup-settings.tsx,storage-settings.tsx}; W/components/meeting/recording-controls.tsx | **P8:** keep native hardware controls local; optional browser capability guidance, not fake Mac permissions | — | — |
| First-run onboarding | No wizard by D-35; sign-in/join then Home | Onboarding replacing shell: permissions mic/system/calendar, test recording/results/retry/skip/finish; first-meeting guide; rerun Setup | D/onboarding/{onboarding-view.tsx,onboarding-steps.ts,onboarding-state.ts,first-meeting-guide.tsx}; M/{onboarding-store.ts,test-recording.ts,permissions.ts} | **P8:** native permission walkthrough stays platform-specific | — | — |
| Recording lifecycle | Browser mic + explicitly shared tab audio; start/pause/resume/stop, session banner, transcript streaming, failures | Sidecar mic + system audio, input picker, meters, pause/resume/stop/continue, capture while other views open, recovery | W/components/meeting/recording-controls.tsx, W/lib/browser-recording; D/recording/{recording-controls.tsx,transcript-panel.tsx}; M/{recording-service.ts,recording-recovery.ts,recording-setup.ts} | **P9:** native call capture stays desktop; web has full tab recording, not merely read-only transcript | — | — |
| Local audio playback | Browser-recorded audio on recording device only, seek/rate/volume and delete-audio confirm; synced notes without audio still read transcript | Main-owned local archive protocol, per-source playback/seek/rate/volume and transcript highlight | MEET/{playback-bar.tsx,side-panel.tsx}; W/components/meeting/meeting-note.tsx; D/meetings/{audio-player.tsx,playback.ts}; M/{audio-playback.ts,audio-storage.ts} | **P10:** audio never syncs; retain honest unavailable-on-this-device state on both platforms | — | — |
| Storage management | Per-note browser delete; no global storage/settings page | Aggregate usage, recording list, Show in Finder, retention preview/confirm/save, delete individual audio, active-recording guards | D/settings/storage-settings.tsx; M/{retention.ts,audio-storage.ts}; W/components/meeting/meeting-note.tsx; W/lib/browser-recording | **G15:** optional browser-device storage inventory/retention UX using browser archive; do not expose desktop files or imply synced audio | M | — |
| Offline/local persistence | Server-backed notes UI; browser capture/audio persisted locally, not a general offline document workspace | SQLite meetings/notes/transcripts/outbox, pending count, recovery/backfill; plain pages/folders/templates explicitly unavailable offline with Try again | M/{sync-service.ts,meeting-notes.ts,transcript-backfill.ts}; D/workspace/desktop-routes-view.tsx; D/sync-status.ts; W/lib/browser-recording | **P11:** preserve desktop meeting offline contract; general web/page offline parity would be a separate L product project, not a missing shared component | — | — |
| Local search | Server search; no desktop disk access | Local meeting/transcript/conflicted-copy FTS plus server, status-0 fallback, server provenance wins | D/sync/{local-search-source.ts,search-text.ts}; FEAT/{sources.ts,search.ts}; M/index.ts | **P4:** web can read synced equivalents, not unsynced desktop data; do not upload just for parity | — | — |
| Conflict resolution | Conflict-copy banner/origin link and resolve dialog on synced copies | Sidebar conflicted-copy list, side-by-side comparison, keep copy/other offline; inline note changed-elsewhere warning | W/components/document/{conflict-banner.tsx,conflict-banner-slot.tsx}; D/sync/conflicts-panel.tsx; D/meetings/meeting-view.tsx; M/sync-service.ts | **G16:** share comparison/status presentation and expose recoverable list-load/detail errors (desktop currently swallows list failure, null detail stays loading); keep local resolution transport | M | — |
| Call detection/auto-stop | No OS mic-app detection | Native notifications + start-notes banner; end-call/silence question, auto-stop countdown/Undo/keep recording, grace Start now, pipeline status/retry | M/{detection-service.ts,auto-stop-service.ts,meeting-end-grace.ts}; D/{calendar/prompt-banner.tsx,auto-stop/auto-stop-notice.tsx,meetings/post-meeting.tsx} | **P12:** OS detection stays desktop; web pipeline status/retry exists but no native auto-stop contract | — | — |
| Widget/window lifecycle | No always-on-top window | Widget: idle/starting/recording/paused/saving/error, meters/STT status/Stop/Close; account Show widget; closing main can leave capture alive | D/windows/widget-window.tsx; M/{windows.ts,index.ts}; D/routes.ts | **P13:** keep desktop-only; browser recording banner is the closest in-tab equivalent | — | — |
| Loading/empty states | Route `(app)/loading`, Home/document skeletons; Suspense calendar/conflicts; shared no pages/templates/tasks/results/messages/settings loading | Boot state, auth/setup wait, notes loading/no notes, transcript wait/no transcript; shared feature/settings states; offline shell placeholder | W/app/(app)/{loading.tsx,home/loading.tsx,d/[docId]/loading.tsx}; WS/{page.tsx,offline-state.tsx}; SET/resource.tsx; FEAT/{search-view.tsx,tasks-view.tsx,assistant-chat.tsx}; D/windows/main-window.tsx | **=:** catalogued; local/server copy differs intentionally, no runtime timing assertions made | — | — |
| Error/not-found surfaces | Root `not-found.tsx`, `global-error.tsx`; `(app)/error.tsx`, `(app)/not-found.tsx`; share 404; `/dev-probes/global-error`, dev `/d/__error` probes | Document unavailable message, offline Try again, recording issues; no equivalent top-level React crash recovery boundary in renderer root | W/app/{global-error.tsx,not-found.tsx,dev-probes/global-error/page.tsx}; D/{main.tsx,workspace/desktop-routes-view.tsx} | **G17:** add renderer error boundary with safe restart/retry, preserve main recording, avoid blank window on render errors; keep probes dev-only | M | — |
| Toasts and inline feedback | Single Sonner Toaster; CRUD/settings success/errors; trash Undo; signout error; enhance Undo/use-version; Notion success/retry; assistant proposal errors | Single Toaster; shared CRUD/settings/feature notices; reconnect/account errors; inline bridge/recording/STT/sync warnings; auto-stop toast/notification | W/components/providers.tsx; D/main.tsx; WS/tree-actions.tsx; SET/{resource.tsx,members-panel.tsx,integrations-panel.tsx}; FEAT/{provider.tsx,proposal-card.tsx}; D/recording/transcript-notices.ts | **G9/G10:** missing action feedback follows missing controls; preserve recording/down-but-still-recording and pending-sync safety messages | L | — |
| Keyboard: app commands | Cmd/Ctrl+K palette (also accepts Shift/repeat); Cmd/Ctrl+B sidebar; Cmd/Ctrl+J note assistant | Cmd/Ctrl+K ignores handled/Shift/repeat; Cmd/Ctrl+B sidebar; Cmd/Ctrl+N starts meeting recording; Escape closes settings; no J note assistant | W/components/{app-shell/command-menu.tsx,assistant/document-assistant.tsx}; D/{keyboard.ts,windows/shell-menus.tsx,meetings/meeting-list.tsx,settings/settings-view.tsx}; packages/ui/src/components/sidebar.tsx | **G18:** share shortcut guards and platform labels, prioritize editor link shortcut over global K, make page versus recording command explicit; add J with G8 | S | Both hosts use UI/hooks/use-app-shortcut.ts for K/B/J; handled, Alt, Shift and repeated keys ignored. K stays with the editor; B preserves text formatting/input ownership. Desktop-only recording N unchanged. Shared handler/unit and web editor-link/J/palette browser checks pass; native runtime/visuals unverified. |
| Keyboard: editor/dialogs/playback | Shared editor selection toolbar (including Cmd/Ctrl+K link), slash/mention suggestion arrows/Ctrl+N/P/Enter/Tab/Escape, normal TipTap formatting; popup Escape/focus; Space/playback arrows/seek and resize arrows/Home/End | Same editor/MEET primitives; local playback wrapper; settings Escape avoids popup owners | packages/editor/src/react/{bubble-toolbar.tsx,suggestion-popup.tsx}; MEET/{panel-escape.ts,side-panel.tsx,playback-bar.tsx}; D/meetings/playback.ts; D/keyboard.ts | **=:** shared primitives; K dispatch inconsistency tracked in G18, not assumed resolved by shared editor | — | — |

### Before: every desktop browser/OS exit

This inventory includes indirect anchors: the renderer cannot freely navigate itself. Main's
`setWindowOpenHandler` and `will-navigate` guards route safe external HTTP(S) to the system browser;
unsafe schemes are blocked. OS settings/file-manager actions are distinguished from browser exits.
There is no remaining generic “Open in browser” document fallback; native PageEditor is reachable.

| Entry/call site | Destination / gating | Disposition |
| --- | --- | --- |
| M/auth.ts `AuthController` openExternal, wired in M/index.ts | Built `/desktop/sign-in` URL on configured web origin with handoff state; sign-in/reconnect/reopen browser | Keep browser identity consent (P1) |
| M/settings-io.ts `connect`, wired in M/index.ts | POST `/api/settings/consent`; accepts only same-origin `/api/settings/consent/browser?ticket=<43 URL-safe chars>`, no credentials/hash | Keep OAuth browser flow (P5); not a settings-page escape |
| M/index.ts CalendarService `google.openConnect` | Before: `new URL('/settings/integrations', config.webUrl)` | **G5 resolved:** callback removed; D/calendar/upcoming-list.tsx navigates through WorkspaceHost to native Integrations; no main-to-renderer event needed |
| M/calendar-setup.ts `openSettings`, wired in M/index.ts | `CALENDAR_PRIVACY_URL` native macOS privacy settings | Keep OS settings, not web browser UX |
| M/index.ts permissions open-settings handler | `PRIVACY_URLS[kind]` for mic/system audio/calendar | Keep OS settings; only known permission kinds |
| D/calendar/note-event-line.tsx → `shell:open-external`; M/index.ts handler | Existing event conferenceUrl; main requires safe absolute HTTP(S) | Keep meeting call destination external |
| M/index.ts webContents `setWindowOpenHandler` | Any safe HTTP(S) `target=_blank`/window.open destination; denies new Electron window | Keep browser boundary; includes following shared-link rows |
| M/index.ts `will-navigate`; M/security.ts `navigationDecision` | Own renderer URL allowed; safe HTTP(S) externalized; other navigation blocked | Keep; G1 must integrate history without weakening this policy |
| FEAT/workspace-adapter.tsx `Link` | Unrecognized external assistant/Markdown href becomes `target=_blank rel=noopener noreferrer`; known feature links use host Link | Keep external answer/reference destinations external; internal document citations remain native |
| SET/integrations-panel.tsx anchor | Connected Notion target page `target=_blank` | Keep provider page external |
| packages/editor/src/react/bubble-toolbar.tsx and editor link rendering | User-authored hyperlinks via shared editor/link UI; main navigation guards apply | Keep HTTP(S) externalization; never bypass scheme validation |
| D/settings/storage-settings.tsx → storage:show; M/index.ts | `shell.showItemInFolder` for validated local audio archive | Keep OS file manager, not browser |
| M/config.ts `desktopConfigFromEnv` | Dev web origin resolves OAT_WEB_URL → BETTER_AUTH_URL → baked/default localhost:3000; packaged ignores env overrides and uses bakedWebUrl/default origin. OAT_SYNC_URL is separate dev-only API traffic, not a UI exit | Preserve fixed packaged origin and token isolation; actual packaged deployment URL was not validated |

Web also uses new-tab anchors for conference links in
`W/components/calendar/{upcoming-meeting-row.tsx,meeting-event-line-view.tsx}`, exported Notion
links in `W/components/notion/notion-export-button.tsx`, and the dev magic-link helper in
`W/app/(auth)/sign-in/sign-in-form.tsx`. Shared Notion/assistant links above exist on both hosts.
OAuth endpoints (`/api/calendar/google`, Notion connect/callback, Better Auth catchall), consent
browser/done endpoints and magic-link API are HTTP handoff/redirect routes, not additional renderer pages.

There are no separate signup/password/reset, web onboarding, calendar, or upcoming page files. Web
`app/layout.tsx`, `(auth)/layout.tsx`, `(app)/settings/layout.tsx` and `share/layout.tsx` are wrappers,
not additional destinations. Desktop settings section navigation is component state inside SettingsView,
not eight independent OS windows. Additional transient surfaces counted inside the matrix rows are:
workspace create/leave/delete and export confirmations; member removal and invite role selectors;
join-policy/domain controls; page/folder move chooser and destructive confirmations; sharing audience
selector; template delete/duplicate/preview; editor link popover/slash/mention suggestions; task
due/assignee/filter selectors; participant add/remove popover; note-history and version restore;
conflict comparison; browser audio deletion and desktop retention/audio deletion confirmations.
Shared templates and settings each supply their own pending/disabled/save-error feedback. There is
no app-defined desktop tray/menu-bar command tree or globalShortcut registration in main; Electron's
platform default menu behavior was not exercised.

### Recommended implementation order and split

1. **G7 + G11**: opening a legitimate server meeting or citation must show the requested content/moment.
   Own desktop meeting route/read model and focus integration together; explicitly test missing-local,
   forbidden, offline, empty transcript and repeated citation targets.
2. **G2 + G3**: native join/invite/bootstrap; reuse authenticated client routes rather than web actions.
3. **G8 + G9 + G10 + G6**: shared note capabilities, but split assistant, enhancement/history and Notion
   into separate tasks. All touch editor composition/local flush; agree the settle/adopt interface first.
4. **G17 + G16**: recoverable renderer failures/conflict errors; never stop main capture on UI retry.
5. **G4 + G12**: complete Home and document lifecycle affordances without dropping local pending notes.
6. **G5**: native Google connection entry and shared upcoming presentation.
7. **G1 + G13**: route/history/filter persistence; coordinate with invite/deep-link work to avoid two routers.
8. **G14 + G18**: command/shortcut consistency after routes and note scopes are agreed.
9. **G15**: optional browser storage convenience, lower priority than missing core note flows.

Keep platform-specific P1–P13: OS identity/provider consent, anonymous public web shares, EventKit,
local FTS/outbox/conflicts and device audio access, permissions/setup, native save/file manager,
system-audio recording, mic-app detection/auto-stop, widget/window lifecycle. Web already provides
synced editable notes/transcripts, shared tasks/global chat and browser-tab recording/playback; it is
not merely a read-only companion. It cannot legitimately read another device's unsynced text/audio.

### Auth/API boundary (five-line handoff)

1. Latest decision is **D-38**; D-28 keeps local-first desktop writes and D-32 allows browser recording.
2. `M/auth.ts` opens browser `/desktop/sign-in`, matches the pending handoff, redeems it and supplies `withSession`; `M/token-store.ts` uses OS-backed safeStorage (no plaintext/basic_text persistence).
3. `packages/client/src/client.ts` declares typed endpoint method/path metadata; `packages/client/src/routes.ts` recursively collects that metadata into `apiRoutes` (not an independent hand-maintained allowlist).
4. `M/api-proxy.ts:apiProxyUrl` checks exact method/template, safe IDs, literal-route priority and same configured origin; rejects encoded/traversal/absolute or malformed paths before requesting.
5. `registerApiProxy` injects main-owned bearer via `withSession`, limits response headers and owns/cancels streams per sender/session; renderer/preload transports never receive the token (`M/ipc.ts` validates IPC sender/payload).

## Review

Self-review only: traced mounted call sites to distinguish exported/shared capabilities from desktop
features actually rendered. In particular, shared global chat does not mean document assistant exists;
typed enhancement APIs do not mean local MeetingView mounts Enhance; retained query fields do not mean
meeting citation focus is consumed. No independent reviewer or visual/runtime verifier was used.

## Evidence

- Enumerated every `page.tsx` under W/app and all `AppRoute` cases in WS/routes.ts; checked separate
  widget/auth/onboarding dispatch in D/routes.ts and D/windows/main-window.tsx.
- Read external-opening handlers in M/index.ts plus auth/settings/calendar wrappers and config;
  checked both direct IPC conference links and shared external anchors.
- Static source evidence only. Native macOS recording/permissions/keychain, browser flows, and current
  accessibility/visual appearance were **not executed or visually verified** on this Linux audit.
- Initial formatting attempt reported `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "prettier" not found`:
  the checkout had no node_modules. Restored the repository environment with
  `pnpm install --frozen-lockfile` (26 workspaces, lockfile resolution skipped, exit 0); no tracked
  dependency/configuration files changed.
- `pnpm exec prettier --check docs/tasks/functional-parity.md docs/PLAN.md docs/LOG.md`:
  `Checking formatting...` / `All matched files use Prettier code style!`.
- `git diff --check`: exit 0, no output. Only this task file, PLAN and LOG are included in the commit.

### G2 + G5 implementation verification

- Shared JoinChoiceList/JoinWorkspace use existing @oat/client workspace/invite endpoints and host
  callbacks, with no Next.js/Electron imports. No endpoint declarations, custom response headers,
  bearer-token handling, bridge schemas or proxy allowlists changed.
- Desktop routes the synced-empty Home state into Join, but bootstrap uses authoritative API data,
  never the local empty snapshot alone. After join/create it syncs and selects the API session's
  active workspace locally before Home; Back preserves the existing local selection.
- Google CTA now opens native Integrations, including the compact empty Home list. The obsolete main
  browser callback is removed. EventKit permissions and real provider consent remain platform-specific.
  Upcoming-row extraction was not cheap enough for this bounded group and is deferred.
- Unit regressions: shared join 14 passed; desktop calendar/service/route 18 passed; web adapter 1
  passed. Coverage includes invitations, decline refresh, join/request/pending, create/back, loading,
  empty/member bootstrap, load/action/bootstrap errors, pending disables, unmount, native Google
  navigation and unchanged EventKit IPC.
- `pnpm run ci --fast`: format/actionlint/lint/test passed; typecheck caught the new web test importing
  an undeclared Testing Library dependency. Replaced that test with the existing React server renderer,
  without adding a dependency. Final affected gate rerun:
  `pnpm run ci --only format,typecheck,lint` → all pass, `ci: ok`.
  Earlier unchanged actionlint/test passes retained; all 24 unit-test tasks passed, including
  workspace-ui 83, desktop 543 and web 208 tests. No property-test timeout scaling was needed.
  Logs: /home/ubuntu/oat-parity-fast-gate.log and /home/ubuntu/oat-parity-fast-correction.log.
- Join browser check: initial cold setup timed out while compiling Home alongside typechecks. Retried
  with the repository-supported budgets and fewer workers:
  `DATABASE_URL=postgres://oat:oat@localhost:54329/oat E2E_TIMEOUT_SCALE=3 E2E_WORKERS=2 E2E_SCREENSHOTS=1 pnpm --filter @oat/web e2e join.spec.ts`
  → `5 passed (2.5m)`, including light/dark axe, invite-only, request/approval/decline, no-match
  bootstrap, auto-join and create-own. Compose stack started successfully; Chromium installed.
  Log: /home/ubuntu/oat-parity-join-e2e.log.
- Web requested-state screenshot inspected: /home/ubuntu/oat-parity-evidence/join-screen-requested-light.png.
  All generated Join screenshots saved in that directory; original tracked historical images retained.
  Desktop native rendering, macOS permissions and real OAuth were not visually/runtime verified.

### G3 + G14 + G13 implementation verification

- Authenticated invite UI is framework-neutral workspace-ui, driven by typed @oat/client APIs.
  Web keeps its signed-out landing and no-referrer metadata. Read-by-token uses POST to avoid adding
  invite secrets to API URL logs; the response omits the token. Mutation authorization remains the
  existing recipient-only server operation. API/proxy route coverage includes lookup automatically.
- Only canonical oat://invite/<32 base64url characters> reaches native route dispatch: no credentials,
  ports, encoded tokens, suffixes, queries, fragments, extra paths, other schemes/hosts or newlines.
  Main retains the pending invite until completion, including signed-out/first-run setup and wrong-account
  sign-out. New navigation bridge channels carry only a schema-validated invite route, never bearer tokens.
  Existing startup/open-url/second-instance queue feeds the main parser. Protocol registration and
  native OS launch dispatch are statically wired, not certified by browser tests.
- Shared host commands cover navigation, Pages, Templates, New page, Toggle sidebar, common settings,
  workspace switching and themes with an actual check icon. Web retains New note; native Start recording
  reuses its guarded recording action; native Recording/Storage/Setup remain additive. Host adapters own
  workspace-switch failures/toasts and platform transports. Shared packages import no Next.js/Electron.
- Search and task state are route-controlled, with normal/empty/invalid URL round trips and adapter
  preservation tests. This does not implement desktop browser-like history or restart restoration (G1).
- First fast gate: format/actionlint/lint passed. Typecheck caught a missing Next Route cast in the web
  adapter; the desktop route test fixture omitted workspace.name. Fixed both. Two other desktop tests
  timed out at 5000ms during concurrent browser compilation; affected gates passed using the supported
  OAT_TEST_TIMEOUT_SCALE=3, without changing timeout/test configuration. Unit totals at that gate:
  workspace-ui 98, feature-ui 122 and web 209. Final desktop total: 551 tests in 67 files.
  The startup regression confirms first-run setup preserves queued native invitations. Palette adapter
  regressions confirm workspace switches use the typed API (whose existing observer updates local
  selection), report failures and avoid navigation on failure.
- Final affected gates: OAT_TEST_TIMEOUT_SCALE=3 pnpm run ci --only format,typecheck,lint,test →
  format pass (30.0s), typecheck pass (28.0s), lint pass (8.5s), test pass (25.4s), total 92.0s,
  ci: ok; 24/24 test tasks successful, 23 cached with unchanged inputs. Initial actionlint pass retained:
  no workflow/actionlint inputs changed. After the final documentation update, targeted Prettier and
  git diff --check are the only affected checks.
- API integration: DATABASE_URL=postgres://oat:oat@localhost:54329/oat pnpm --filter @oat/web exec vitest run
  --mode int src/server/api/workspaces.int.test.ts src/server/entrypoints.int.test.ts → 2 files,
  145 tests passed. Includes unauthenticated lookup refusal, unknown/malformed tokens, invited/wrong-account
  lookup, recipient-only mutations and post-response states. No real provider/production requests.
- Browser: DATABASE_URL=postgres://oat:oat@localhost:54329/oat E2E_TIMEOUT_SCALE=3 E2E_WORKERS=2
  pnpm --filter @oat/web e2e workspaces.spec.ts search.spec.ts → 7 passed (3.6m), 1 existing opt-in
  dark-evidence skip. Covers authenticated accept, wrong-account sign-out, revoked/used notices, safe
  native href, command accessibility, Templates/Members navigation and checked themes, plus search
  pagination/tab stability. One Next destination-stream diagnostic was printed; all selected cases passed.
- Logs: /home/ubuntu/oat-parity-g3-g14-g13-fast.log,
  /home/ubuntu/oat-parity-g3-g14-g13-correction.log, /home/ubuntu/oat-parity-g3-g14-g13-final.log,
  /home/ubuntu/oat-parity-invite-int.log and
  /home/ubuntu/oat-parity-invite-command-e2e.log. Better Auth endpoint inventory logs discovery failures
  against its deliberately configured localhost:9 test issuer; this is not an unloaded environment.
- Browser behavior/axe checked by Playwright; new surfaces are visually unverified. Electron OS
  protocol registration, macOS native rendering/permissions and real provider consent remain unverified.

### G7 + G11 implementation verification

- Main-owned typed document/workspace/backfill reads and an atomic no-echo cache are implemented.
  A cache fill never replaces an existing document, pending write or subtree; failed/incomplete reads
  commit nothing. Edits continue through MeetingNotes/NoteAutosave and the normal outbox. Account/store
  switches discard in-flight responses. Existing authorized backfill pagination is reused, with no
  server changes, new response headers or renderer bearer access.
- MeetingView reuses the already-shared feature-ui focus parser/line resolver and editor BlockFocus.
  Navigation revisions reapply identical segment/time/block citations; audio seeking remains device-local.
- OAT_TEST_TIMEOUT_SCALE=3 pnpm run ci --fast initially caught new fixture typing, transport-query typing
  and synchronous derived-state-effect lint errors; corrected those. First corrected format/typecheck/lint
  passed (24.0s/22.3s/10.6s). Initial actionlint passed with unchanged inputs.
- The test stage failed twice in unchanged workspace-ui join-workspace.test.tsx:
  “requests access, displays the pending badge and confirmation, and offers Back to members”,
  “expected "vi.fn()" to be called once, but got 0 times” at line 100 (onHome).
  Suspected pending-transition/click-readiness race; whether the button was disabled at click time is
  unverified. A detached b11a76d baseline at /home/ubuntu/oat-g7-baseline passed both the focused case and
  the standalone workspace suite (98 tests); this does not establish a preexisting parallel-gate failure.
  Follow-up authorization allowed fixing our G2 test. Back already has native disabled semantics and
  disabled styling while pending; a deferred-acceptance member regression verifies it cannot navigate
  then. The request test now waits for Back to become enabled before clicking. No component behavior
  changed. The original click-time state was not captured, but the readiness fix passes stress and CI.
  The detached baseline was removed with git worktree remove.
- Independent affected desktop suite: OAT_TEST_TIMEOUT_SCALE=3 pnpm --filter @oat/desktop test →
  70 files, 571 tests passed (18.98s), including load/cache/error/retry/empty transcript/role/account
  boundaries, segment/time/block focus and identical repeat citations. Gate local-store: 85 passed;
  core: 507; client: 59; feature-ui: 122; web: 209.
- Five concurrent runs of taskset -c 0-3 env OAT_TEST_TIMEOUT_SCALE=3
  pnpm --filter @oat/workspace-ui test all passed: 8 files/99 tests each (495 test executions).
  Logs: /home/ubuntu/oat-parity-g7-g11-stress-{1,2,3,4,5}.log.
- Final OAT_TEST_TIMEOUT_SCALE=3 pnpm run ci --fast: format pass (22.0s), actionlint pass (0.4s),
  typecheck pass (22.2s), lint pass (6.3s), test pass (31.6s), total 82.5s, ci: ok.
  All 24 test tasks successful; desktop 571 and workspace-ui 99 tests passed.
  Log: /home/ubuntu/oat-parity-g7-g11-final-fast.log.
- Logs: /home/ubuntu/oat-parity-g7-g11-{fast,correction,desktop,baseline-join,baseline-workspace}.log.
  Web sources/server behavior/shared focus implementations were not changed, so browser e2e was not
  rerun. Native runtime/visuals remain unverified. One local group commit; no push or new decision.

## G8 + G18 implementation and verification

- Moved the document assistant panel, responsive sheet, toggle anchoring, block/transcript focus and
  editor registration/settle/adopt bridge into feature-ui/document-assistant.tsx and open-document.tsx.
  Web keeps thin Next navigation adapters; shared code imports neither Next nor Electron.
  Native MeetingView and AssistantPageEditor both host document-scoped chat. The native toggle joins
  the existing recording/transcript bar; the content column remains a bounded flex column.
- ChatSession awaits the host preflight before POST /api/chat, with abort checks around it. Native
  meetings flush NoteAutosave, call sync:now and compare the authorized server document with the local
  saved base before asking or approving. Unsaved, failed, offline or not-yet-visible writes block the
  request. No bearer token reaches the renderer. The existing proxy already forwards x-oat-thread-id
  and the AI stream header (covered by api-proxy.test.ts), so no allowlist/header/API additions were needed.
- Approval retains the existing server-authorized/version-guarded proposal decision. Only after the
  explicit Approve action succeeds does the native adapter persist the returned approved body through
  meeting:save and its ordinary SQLite/outbox path, rather than adopting a remote version directly.
  The local write base is captured before the approval request; newer incoming local copies use the
  existing conflict-copy guard instead of being overwritten. New pending edits, save errors, a missing
  approved document or a later server version surface an error and do not replace the editor body.
  Same-body outbox pushes remain idempotent through server/sync/push.ts.
- Plain pages retain their existing server-backed PageEditor autosave/settle/adopt transport, consistent
  with D-38; this group does not introduce a new SQLite page store. Their assistant uses that editor
  bridge, not a second editor or a desktop-only assistant implementation. G6/G9/G10 remain separate.
- UI/hooks/use-app-shortcut.ts binds K/B/J for both hosts: Cmd or Ctrl required, handled/Alt/Shift/repeat
  events ignored. K never steals the editor link command. B leaves editable fields and editor formatting
  alone. J toggles the shared document assistant. Desktop recording Cmd/Ctrl+N is unchanged.
- Added shared panel/anchor/unavailable-state, shortcut modifier/editor/input/unmount, pre-send stream
  gating/error/empty question, settle/approve/adopt/error/citation and native page bridge tests. Native
  meeting tests cover flush-before-sync ordering, empty notes, unsaved/offline/not-synced refusal,
  explicit-approved normal writer, disk/conflict errors, captured bases across later sync rebases and
  edits becoming pending after preparation.
- Two full OAT_TEST_TIMEOUT_SCALE=3 pnpm run ci --fast attempts passed tests but exposed new static
  errors: an undeclared desktop DTO import and React ref-access checks around factory calls. Fixed
  using PageEditor public prop types, memoized transport callbacks and an editor accessor registered
  outside the pure native factory. Initial actionlint passed (0.7s), with its inputs unchanged.
  Final affected gate after the concurrency regression fix:
  format pass 21.6s / typecheck pass 20.9s / lint pass 13.3s / test pass 36.5s; total 92.4s, ci: ok.
  All 24 test tasks successful: desktop 580, feature-ui 135, ui 124, web 209, workspace-ui 99 tests.
- Browser compose checks used DATABASE_URL=postgres://oat:oat@localhost:54329/oat,
  E2E_TIMEOUT_SCALE=3 and E2E_WORKERS=2. Initial assistant/document/search run: 19 passed (3.5m),
  one existing opt-in dark-evidence skip; includes palette accessibility/navigation/theme checks.
  After the shared column layout fix, assistant + document specs: 15 passed (2.6m). After the final
  approval-base fix, assistant specs: 8 passed (2.1m), including explicit approval/stale proposals,
  citations, responsive focus/Escape, abort and editor-owned K versus shifted app shortcuts.
  Unchanged document/search passes retained.
- Logs: /home/ubuntu/oat-parity-g8-g18-{fast,final-fast,correction,approval-final}.log and
  /home/ubuntu/oat-parity-g8-g18-{e2e,final-assistant-e2e,layout-e2e,approval-e2e}.log.
  No screenshot review or native Electron/macOS runtime check was performed: the user-facing surfaces
  remain visually unverified. Local group commit only; no push and no new decision.
