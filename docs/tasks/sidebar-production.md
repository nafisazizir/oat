# Approved sidebar rollout
status: done
branch: devin/1795398368-sidebar-lab

## Goal
Ship refined B1 in the shared web/desktop sidebar and retire the mock-only lab.

## Context
Approved exploration: sidebar-lab.md (historical evidence). SPEC/DECISIONS unchanged.
Settings index routes to Profile, Preferences (theme), Integrations, General and Members.
General renders WorkspaceDangerZone with Leave workspace; existing permission guards remain.

## Scope and design
Header toggle/Oat → Home; primary action/Search; collapsible Private/Shared/Chats;
footer workspace switcher only. Recent chats use host.client.chat.threads (current workspace),
newest five; error/empty/loading render no thread rows, retaining View all. Requests abort on
workspace/navigation changes; keyed workspace sections prevent stale data crossing workspaces.
Menu identity uses WorkspaceAvatar-compatible 24px rounded-md fill/ring, top-aligned.
Settings shortcut; workspace switching/create/join; Library; status/account slots/sign out.
Native desktop titlebar classes preserved. No backend permission changes.

## Acceptance
- [x] Shared production layout matches approved lab; collapsed controls remain usable.
- [x] Thread sorting/limit/active/new/all routes and empty/error/offline/workspace reset covered.
- [x] Settings retains profile/theme/members/invite/leave access; sign out remains last.
- [x] Removed navigation tests updated and lab route deleted; historic evidence retained.
- [x] Required fast and e2e checks pass; real web screenshots inspected.
- [x] Commit/push authorized on the current branch; publication follows verification closeout.

## Verification
pnpm run ci --fast
DATABASE_URL=postgres://oat:oat@localhost:54329/oat OAT_TEST_TIMEOUT_SCALE=3 pnpm run ci --only e2e
1280×800 real-expanded.png / real-switcher.png under ~/sidebar-lab-shots/.

## Review / evidence
Self-review: existing TreeSection root drop handlers retained on the label button; desktop
header/titlebar class slots unchanged. Desktop Assistant passes an explicit null selection to
clear a previously selected conversation when the sidebar starts a new chat. The web Assistant's
history update now passes null, per the installed Next.js native-history documentation: passing
the internal history state bypassed the router's search-param update, preventing sidebar active/
recent state from following newly saved threads. The real Assistant e2e exercises recent-thread
selection, its active marker, and the hover-plus reset to an empty chat. Shared client/API
permissions are unchanged. No new service/auth/data access path. Independent reviewer/verifier
sessions are not available in this tool environment.

Settings reachability checked in settings-ui index and WorkspaceDangerZone: Profile,
Preferences/theme, Members/invite, General/leave remain available with existing permission guards.
The leave/export e2e now uses Settings → General, including that surface's existing ZIP-file text.
The web sign-out still uses AccountMenuItems/authClient.signOut; desktop account actions remain.
Native Electron/macOS titlebar behavior is source/unit checked only; desktop e2e skips on Linux.

Final fast gate (after Assistant route-refresh and collapsed accessible-name fixes):
```text
step        status     time  note
format      pass      11.7s
actionlint  pass       0.3s
typecheck   pass      12.1s
lint        pass       5.6s
test        pass      18.4s
total                 48.0s

ci: ok
```
Workspace-ui: 13 files / 127 tests passed. Desktop: 81 files / 642 tests passed.
Log: ~/sidebar-lab-shots/production-fast.log. An earlier concurrent fast run hit an unrelated
5s transcript-backfill unit timeout; the final isolated fast run above passes without scaling.

Visual: authenticated real API-backed Acme workspace, persisted assistant thread, 1280×800:
~/sidebar-lab-shots/real-expanded.png, real-switcher.png, real-collapsed.png.
Compared against historical final-switcher.png: matching B1 header/group/footer composition,
24px rounded-md top-aligned identity/workspace tiles, common leading slots and muted dots row.
Retains production New note action and live-sync menu status rather than mock-only lab content.

First complete e2e run caught moved member-count assertions, collapsed accessible naming,
Settings leave/export copy, and Notion picker failures. Unchanged-HEAD Notion/pipeline comparison
passed (3 tests including setup, 1.1m), as did those two tests in the second full run. The second
run caught the Assistant URL notification issue above and one transient ECONNRESET in a
document-permission GET. Sidebar/test issues corrected; the final required e2e rerun passed,
including the Assistant sidebar regression and the previously interrupted permission check:
```text
Desktop: 29 skipped (Linux; native Electron suite requires macOS)
Web:     17 skipped / 91 passed (6.3m)
Editor:   2 skipped / 16 passed (8.5s)

━━ ci summary (--only e2e)
step  status     time  note
e2e   pass     390.9s
total           390.9s

ci: ok
```
Logs: ~/sidebar-lab-shots/production-e2e.log, production-e2e-first.log,
production-e2e-second.log, production-baseline-e2e.log. Compose images pulled via
mirror.gcr.io and retagged. Screenshots/evidence harness and baseline comparison worktree
remain outside the product diff. Native macOS runtime and independent review remain unverified.

## PR #34 review follow-up
All five findings at 7738b5c were real and have focused regression coverage:
- Export was reachable only through a permission/recording-gated Leave button. Settings General
  now offers standalone Export my notes regardless of exit permissions or recording state, using
  the same platform export service. Leave/delete guards are unchanged. Tests cover sole-owner,
  recording, empty, cancelled and failed exports (settings.test.tsx: 8 passed).
- The sidebar plus could navigate to the already-current empty Assistant URL without resetting its
  draft. A workspace-scoped UI intent now invokes the page Assistant's existing newChat routine;
  document panels and other workspaces ignore it. Modified clicks retain normal link behavior.
  Assistant regression suite: 38 passed; Chats suite: 7 passed.
- Creating from a collapsed tree section now expands it before page/folder creation, exposing the
  folder's inline rename field. Both creation paths are tested.
- Settings now registers Cmd/Ctrl+, via useAppShortcut in the shared sidebar. No application menu,
  accelerator or duplicate Settings shortcut exists in desktop source; DesktopLink also respects
  defaultPrevented. Shortcut hook tests: 9 passed; shared shell checks both web/desktop hosts.
- Icon-mode tree/chat labels are display:none, aria-hidden and tabIndex=-1, restored in expanded
  mode. Mobile's expanded sheet remains accessible. Final affected shell/Chats run: 27 passed.

Final local gate after all five fixes (`pnpm run ci --fast`):
```text
step        status     time  note
format      pass      11.7s
actionlint  pass       0.3s
typecheck   pass      19.3s
lint        pass       4.7s
test        pass      26.2s
total                 62.2s

ci: ok
```
Log: ~/sidebar-lab-shots/pr34-review-fast.log. PR checks are monitored on #34 after publication.
No new visual capture was requested: the new standalone export row and collapsed-label layout are
visually unverified. Native macOS runtime remains unverified.
