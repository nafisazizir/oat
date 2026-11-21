# unified-workspaces — one kind of workspace, Private + Shared inside it
status: in-progress
milestone: M9 · deps: 5.1, 5.3, 3.9, ui-calm-shell · branch: task/unified-workspaces (steps: task/unified-workspaces-a, -b, -c, each merged into it in order)

## Goal
Remove the personal/team split (D-36). A workspace is just a workspace; privacy is per note/folder. New users
join an existing workspace (invite, or email-domain match subject to the workspace's join policy) or get one
created for them. Inside a workspace the sidebar shows **Private** and **Shared**. Why: today there are two
places a private note can live, and the human finds the product confusing because of it.

## Context
- D-36 (this change), D-18 (private folders — unchanged), D-22 (soft delete), D-27, D-35 (no onboarding wizard:
  the new join/create step is one calm screen, not a wizard).
- SPEC §4 Workspace/Sharing rows, §5 "Everything carries `workspace_id`", §6 data model.
- Where `kind` / "personal" lives today:
  - Schema: `packages/db/src/schema/workspace.ts` (`kind`, `workspace_personal_created_by_uq`,
    `workspace_deleted_team_only_ck`), `schema/enums.ts`, `auth-mapping.ts`, `seed.ts`; desktop
    `packages/local-store/src/{migrations,store}.ts` (`personalWorkspaceId()`), `packages/core/src/{types,sync}.ts`.
  - Rules: `packages/core/src/permissions.ts` (`kind === 'team'` in manage members / remove / delete).
  - Auth: `packages/auth/src/{workspaces,server,members}.ts` (`ensurePersonalWorkspace`, `personal-` slug guard,
    every session starts in personal, `pickActiveWorkspace`).
  - Web: `apps/web/src/server/{shell,workspace-settings,sharing}.ts`, `lib/{workspace,tree}.ts`,
    `components/app-shell/app-sidebar.tsx`, settings/workspace pages, share dialog, templates pages.
  - Desktop: `apps/desktop/src/main/{workspaces,sync-service,meeting-notes,meeting-persistence}.ts`,
    renderer `workspaces/*`, `windows/main-window.tsx`, `calendar/upcoming-list.tsx`.
  - Find the rest with: `grep -rIl -iE "personal|WorkspaceKind|kind === 'team'" apps packages`.

## Scope
Three steps, each its own branch/PR, in order. Each must leave `main` green.

**Step A — model (no new UI).** Drop `kind` everywhere (Postgres migration + local-store migration + sync DTOs);
existing personal rows stay in place and are renamed "<First name>'s workspace" (fallback "My workspace").
Sign-up creates an ordinary workspace via one `ensureFirstWorkspace` (only when the user has no membership and
no pending invite). Sessions start in the last active workspace, else the oldest membership. Permissions lose
the `kind` checks and gain "can't leave/delete your last workspace". Desktop record-target fallback per D-36.
Remove "Personal" labels/special cases from web and desktop UI (avatar, settings gating, leave dialog).

**Step B — joining.** New columns on `workspace`: `join_policy` (`invite_only` default | `request` |
`auto_join`) and allowed domains (table `workspace_domain(workspace_id, domain)`, unique per pair); new table
`join_request(id, workspace_id, user_id, status: pending|approved|declined, decided_by, timestamps)`. Public
mailbox domain list + `canAddDomain` / `canRequestToJoin` / `canDecideJoinRequest` in `@oat/core` permissions.
After first sign-in with no membership: one screen listing matching workspaces (Join / Request access) with
"Create my own workspace" as the alternative; no match → straight into the auto-created workspace. Workspace
settings: join policy + domains; Members page: pending requests (approve with role / decline). Email to
owners/admins on a request and to the requester on a decision (Mailpit in dev, D-11).

**Step C — Private / Shared and exit.** Sidebar tree splits into Private (items I own with `private`
visibility) and Shared (everything else I can read) on web and desktop; new notes and recordings default to
Private (already the document default). Switcher hidden with one workspace. Leave dialog explains that private
notes stay behind and offers "Export my notes" (zip of Markdown from `content_md`, own documents only).

Out: purge/retention of a departed member's private notes; transferring note ownership; cross-workspace moves
(still D-18); SSO/SCIM; domain verification by DNS; billing/seats; changing roles or visibility rules.

## Acceptance criteria
Step A
- [x] No `kind` column, enum, type or "personal" special case remains (`grep` above returns only migrations,
      this file and docs).
- [x] A user who existed before the migration keeps every document under the same workspace id; their former
      personal workspace is listed under its new name and can now invite members and be renamed.
- [x] A brand-new user with no invite lands in an auto-created workspace as `owner`; signing up twice
      concurrently creates exactly one.
- [x] Leaving or deleting your only workspace is refused (rule in `permissions.ts`, with deny tests); it works
      once you belong to a second one.
- [x] Desktop: with a view-only workspace active, a new recording lands in a workspace where I can create; with
      none, the user is asked to create one and no recording is lost.
- [x] Desktop upgrades an existing local store without re-download or data loss (migration test from a
      fixture DB containing a `personal` row).
Step B
- [x] `invite_only` workspace is never shown to a matching-domain stranger; `request` shows "Request access";
      `auto_join` joins as `member` — each covered by an e2e and an integration test.
- [x] Unverified email, public mailbox domain, or a domain other than the admin's own: denied (unit deny tests).
- [x] Approve creates the membership with the chosen role; decline does not; both notify the requester; a
      declined user can't spam (one pending request per user per workspace).
- [x] Only owner/admin can see or decide requests and edit policy/domains.
Step C
- [x] Sidebar shows Private and Shared sections on web and desktop; a note moves between them when its
      visibility changes, without reload; another member never sees my Private items (e2e with two users).
- [x] Switcher is absent with one workspace and present with two.
- [x] Export downloads a zip containing only my documents; after leaving, I can no longer read any of them.
- [x] axe: 0 violations on the join screen, join settings, requests list and sidebar, light and dark.

## Verification
- `pnpm run ci` (full) on each step's branch — migration check must pass from a DB at `main`'s schema.
- `pnpm --filter @oat/core test permissions` · `pnpm --filter @oat/auth test` · `pnpm --filter @oat/local-store test`
- `pnpm --filter @oat/web exec playwright test e2e/workspaces.spec.ts e2e/auth.spec.ts e2e/calm-auth.spec.ts e2e/sharing.spec.ts`
  plus new `e2e/join.spec.ts` (B) and `e2e/private-shared.spec.ts` (C); desktop `e2e/workspaces.spec.ts`.
- Screenshots 1440×900 light/dark under `docs/tasks/evidence/unified-workspaces/`: join screen (match / no
  match), join settings, requests list, sidebar with Private + Shared, leave dialog with export.

## Design notes
- Step A's Postgres migration drops a column and an enum (destructive, FACTORY §7). The human approved it on
  2026-11-21 and confirmed there is no production database, so no compatibility window is needed for data.
- Better Auth still calls these "organizations"; keep the mapping in `auth-mapping.ts`, only remove `kind`.
- Slugs: stop reserving `personal-`; existing `personal-<userId>` slugs get a generated slug in the migration.
- The one-desktop-version window in which the sync DTO would keep `kind` as an optional, ignored field was
  dropped (orchestrator, 2026-11-21): there is no production database and no released desktop build.

### Step A (branch `task/unified-workspaces-a`)
What was decided, and what steps B/C need to know.

**Model**
- Postgres migration `0013_unified_workspaces` (after `main`'s 0012; `db:generate` reports no drift). In order:
  rename former personal rows still called "Personal" to "<First name>’s workspace" (fallback "My workspace"; a
  name its owner had already changed is kept), replace every `personal-<userId>` slug with a generated
  `<words-from-name>-<12 hex>` one, then drop `workspace_deleted_team_only_ck`, the
  `workspace_personal_created_by_uq` index, the `kind` column and the `workspace_kind` enum. Ids don't change,
  so no document moves. The renames go through the `change_log` trigger, so syncing desktops get the new name.
  Test: `packages/db/src/unified-workspaces-migration.int.test.ts` (migrates a DB at `main`'s schema with data).
- New column `user.last_active_workspace_id` (nullable, no FK, like `session.active_workspace_id`): the
  workspace the user last switched to. Written only by `@oat/auth` (`rememberActiveWorkspace`, from an after-hook
  on Better Auth's `organization/set-active`, HTTP and in-process alike); never client-settable.
- Sync DTO: `kind` is gone from `syncWorkspaceRowSchema` (rows are `{ id, name, role }`); `SYNC_PULL_SCOPE` was
  **not** bumped, so nothing is re-downloaded. The "accept old clients for one desktop version" note above was
  skipped as agreed (no production database, no released desktop): an old desktop build can't parse new pulls.
- Local store migration 5 is `ALTER TABLE workspace DROP COLUMN kind` (in place; a failing local migration
  would wipe the cache, so `migration-5.test.ts` upgrades a version-4 fixture —
  `src/fixtures/v4-two-kinds.sql` — and checks rows, outbox entries, cursor and search are untouched).
  `LocalStore.personalWorkspaceId()` became `firstWorkspaceId()` (first by name; no meaning beyond "sync has
  brought a workspace").

**Rules** (`packages/core/src/permissions.ts`)
- `WorkspaceAccess` is `{ id }`. `canManageMembers`/`canInvite`/`canChangeRole` no longer look at a kind.
- Last workspace: `isLastWorkspace(ctx, workspaceId)`; `canRemoveMember` refuses **leaving** it and
  `canDeleteWorkspace` refuses deleting it. It is read from `ctx.memberships`, which must hold *all* of the
  actor's live memberships — a context built from one workspace's rows fails closed (refuses). Removing
  someone *else* from their only workspace, or an owner deleting a workspace that is another member's only one,
  is still allowed: that person gets a workspace of their own the next time they open Oat (below).
- `@oat/auth` `members.ts`: leave/delete take a per-user advisory lock (`lockUser`) and load the actor's full
  context inside the transaction, so leaving/deleting two workspaces at once keeps one (concurrency tests).

**Sign-up and sessions** (`packages/auth/src/workspaces.ts`)
- `ensureFirstWorkspace(db, userId)` replaces `ensurePersonalWorkspace`: under `lockUser`, returns the user's
  oldest live membership; else, if a pending, unexpired invitation to their address into a live workspace
  exists, creates nothing and returns its token; else creates an ordinary workspace (`firstWorkspaceName`,
  `workspaceSlug`) with the user as `owner`. Called from `user.create.after`, `session.create.before` and the
  web shell.
- **Step B hook-in point:** this function is where "matching joinable workspaces" belongs — today the only
  reason not to create is a pending invite. The web shell (`apps/web/src/server/shell.ts` `getContext`)
  redirects a workspace-less user with a pending invite to `/invite/<token>` (accept → joins; decline → next
  visit creates their own). An invited newcomer who neither accepts nor declines stays on that page: B's
  join screen ("Create my own workspace") should replace that redirect.
- Sessions start in `startingWorkspaceId`: `user.last_active_workspace_id` if still a live membership, else the
  oldest membership (`membership.created_at`, then id). `pickActiveWorkspace(workspaces, sessionActive,
  lastActive)` applies the same rule when a session's workspace is gone; `UserWorkspace` gained `joinedAt`
  and lost `kind`; `listUserWorkspaces` now orders by name.
- `AUTH_MAX_TEAM_WORKSPACES` keeps its name; it now caps workspaces a user creates *on top of* the one made at
  sign-up (the old count excluded personal ones, so the effective limit is unchanged).
- Nothing reserves `personal-` slugs any more; a first workspace's slug can be changed like any other.

**Web**
- Removed: the "Personal workspace" settings note (`settings/workspace/layout.tsx`, `create-team-button.tsx`
  deleted), the brand-coloured avatar, "Personal space" labels, Members hidden for personal, the personal
  wording in the share dialog, templates pages and sign-in page.
- "Only you" badges now depend on the workspace having one member (`isWorkspaceOfOne`), not on a kind. The
  sidebar's "Shared" section is always shown (it used to be hidden in a personal workspace). **Step C**
  replaces the sidebar sections anyway.
- Danger zone: Leave and Delete (owners) are shown disabled with "This is your only workspace…" for the last
  workspace (`WorkspaceSettings.lastWorkspace`); the actions return the same reason. The switcher offers
  "Leave …" only with more than one workspace. **Step C** (switcher hidden with one workspace) must keep a
  way to reach "Create workspace" — the desktop sends view-only users there.

**Desktop**
- New notes go to the active workspace if I can create there, else the first workspace (by name) where I can,
  else nowhere (`Workspaces.snapshot().targetId === null`, `newNoteTarget`). With nowhere to go,
  `beginMeeting` / "Start notes" are refused *before any audio is captured* with "…Create a workspace of your
  own in Oat on the web, then try again." (`noNoteWorkspaceMessage`; a never-synced database still says
  "connect once"), and the sidebar hint says the same — so no recording exists that could be lost.
- With no stored choice the active workspace defaults to the first one I can create in, and that default is
  now persisted, so a workspace arriving later (sorting earlier) doesn't change what the sidebar shows.
- A workspace row without a role (`role: null`) is no longer assumed writable (that guess needed `kind`).
- `SyncService.personalWorkspace()` → `awaitWorkspaces()` (boolean); `MeetingPersistence` now requires
  `newNoteWorkspace`.

**For step C (review finding 6, deferred):** "Only you" on a `workspace`-visibility item depends on the member
count (`isWorkspaceOfOne`), so in a workspace of one it reads "Only you" and silently becomes readable by
whoever joins next. Settle the wording when the sidebar gets Private / Shared.

**Grep criterion** — `grep -rIl -iE "personal|WorkspaceKind|kind === 'team'" apps packages` now returns only:
Drizzle migrations/snapshots, `local-store` migration 1 + its migration-5 test and fixture, the Postgres
migration test, and Google-**calendar** fixtures/tests where a calendar is titled "Personal"
(`packages/calendar/src/google/source.test.ts`; also `tools/mocks`, `fixtures/calendar`) — unrelated to
workspaces and left alone.

**Out of scope touched:** `docs/DEV.md` and `.env.example` (two paragraphs/one comment describing the old
model); test fixtures in `packages/ai`, `packages/indexing`, `agents` (dropped `kind`, renamed identifiers);
`apps/desktop/e2e/workspaces.spec.ts` was already failing on `main` (stale against the ui-calm shell:
transcript behind its toggle, Upcoming on Home) — adapted so the spec runs again, all 4 tests pass.

**Known red on `main`, not caused by this step** (reproduced on `main` at d3b92e2): the other desktop e2e
specs and the acceptance journey fail on selectors the ui-calm tasks removed (`meeting-start`, the transcript
panel, `sync-status`, …). So `pnpm run ci` reports `e2e` (package `@oat/desktop`) and `acceptance` as FAIL
on this branch exactly as on `main`; they need their own task.
Web e2e: `notion.spec.ts` (phone-width overflow, 1178 > 390) fails whenever it runs next to other specs —
reproduced on `main` with `playwright test e2e/notion.spec.ts e2e/documents.spec.ts`; it passes alone on
both. `typography.spec.ts` (dark) failed once in the full run and is listed as flaky under load in `LOG.md`.
Final full run on this branch: web e2e 75 passed / 2 failed (those two), desktop 8 passed / 10 failed / 10
not run (all pre-existing; `workspaces.spec.ts` 4/4 pass), everything else `pass`.

### Step B (branch `task/unified-workspaces-b`, from step A's `a1329ce`)
What was decided, and what step C needs to know.

**Model**
- Postgres migration `0014_join_policy` (after step A's 0013; `db:generate` reports no drift; additive only):
  enum `join_policy` + `workspace.join_policy` (default `invite_only`), table `workspace_domain(workspace_id,
  domain, added_by, created_at)` with primary key `(workspace_id, domain)` and a check that the domain is
  stored normalised, enum `join_request_status` + table `join_request(id, workspace_id, user_id, status,
  decided_by, decided_at, role, created_at, updated_at)` with the partial unique index
  `join_request_one_pending_uq (workspace_id, user_id) WHERE status = 'pending'`. `role` is the role granted
  on approval (null otherwise); `decided_by` is null for a request settled without a decider (below).
- **Not synced to the desktop.** `workspace_domain` and `join_request` have no change-log trigger and no sync
  DTO, and `join_policy` is not in `syncWorkspaceRowSchema` (rows stay `{ id, name, role }`): they are
  owner/admin settings and a pre-membership flow that only the web has UI for, and a non-member's desktop has
  no workspace to sync them under. `SYNC_PULL_SCOPE` and the local store are untouched. Side effect: changing
  the policy updates the `workspace` row, so its existing trigger writes one change-log entry and desktops
  re-pull that (unchanged) row — harmless. A joined member's desktop learns about the workspace through the
  `membership` trigger, as with an accepted invite.
- Better Auth: `join_policy` is not an organization field (`auth-mapping.ts` unchanged) and
  `beforeUpdateOrganization` still refuses every key but name/slug/logo, so it can't be set through
  `organization/update`.

**Rules** (`packages/core`)
- `email-domains.ts`: `PUBLIC_MAILBOX_DOMAINS` (about 140 consumer, ISP and disposable providers) plus
  `PUBLIC_MAILBOX_FAMILIES` (review 6: `<outlook|hotmail|live|yahoo|gmx|yandex|proton|icloud|…>.<tld>` and
  `.<co|com|net|org|ne|or>.<cc>` are public by rule — the registrable label must *be* the name, so
  `liveperson.com` is not; it errs towards public, e.g. a company on `live.tv` has to invite),
  `normalizeDomain`, `emailDomain`, `isPublicMailboxDomain`. The list can't be exhaustive; the second half of
  the rule is that only one's *own* verified domain can be listed.
- `permissions.ts` (table in the file header; deny tests in `permissions.join.test.ts`, coverage still 100 %):
  `matchingJoinDomain` (verified email, non-public domain, listed, workspace not deleted — exact match, no
  subdomains), `canEditJoinSettings` (owner/admin: policy, removing a domain), `canAddDomain` (owner/admin,
  verified, only their own email's domain, never public), `canAutoJoin`, `canRequestToJoin`,
  `joinOption` (`join` | `request` | `requested` | `null` — `null` is "not shown at all", which is what an
  `invite_only` workspace always is to a stranger), `canDecideJoinRequest` (owner/admin of the request's
  workspace, pending only, approving with a role ≤ their own).
- **Decided: a declined request is final.** `canRequestToJoin` takes the status of the person's latest request
  to that workspace: `pending` or `declined` → no. So "can't spam" is both the unique index (one pending) and
  "a no stands": the workspace is no longer offered to them and asking again is refused; an owner/admin can
  still invite them. The same `declined` status blocks `canAutoJoin` (review 1/2), so a "no" also stands
  when the policy later becomes `auto_join`. Someone approved once who *left* since may ask or join again.
- The person is always an `EmailIdentity { email, emailVerified }` built from the user row; no rule takes an
  address or a domain from a request.

**Server** (`packages/auth/src/joining.ts`; int tests `joining.int.test.ts`)
- `getJoinChoices(db, userId)` → `{ invites, workspaces }`: pending, unexpired invitations to the user's
  (verified) address whose sender may still send them, and workspaces offered by `joinOption`. A workspace
  that invited them appears once, as the invitation.
- `ensureFirstWorkspace` **moved here from `workspaces.ts`** and now returns
  `{ workspaceId: undefined, created: false, choices: true }` (was `pendingInviteToken`) whenever
  `getJoinChoices` is non-empty; `createOwnWorkspace` is the same thing without that check ("Create my own
  workspace"; still only for a user with no workspace, so pressing twice creates one). `workspaces.ts` keeps
  `createWorkspaceFor`, `lockUser` (now also returns `emailVerified`) and the lists.
- `joinWorkspace` (auto-join, as `member`), `requestToJoin`, `decideJoinRequest`, `setJoinPolicy`,
  `addOwnDomain`, `removeDomain`, `listJoinRequests`, `getJoinSettings`. Locks in the same order as step A:
  the actor's `lockUser`, then the workspace row `FOR UPDATE` (`lockWorkspace` from `members.ts`, now
  exported) — so a join, a decision, a policy change and a soft delete of one workspace are serialised.
  Memberships are inserted `ON CONFLICT DO NOTHING` on `membership_workspace_user_uq`. Tested concurrently:
  8 joins → one membership; 8 requests → one row; approve/approve/decline/decline → exactly one wins, the
  rest get `JoinRequestDecidedError`; join racing a delete never ends in a membership of a live workspace.
- `addOwnDomain` has **no domain parameter**: the domain is read from the actor's user row. `removeDomain`
  takes one, only as the key of the row to delete.
- To a non-member, "may not join/ask" is `NotFoundError`, exactly like an unknown or deleted workspace, so
  ids can't be probed; a member/viewer deciding or editing gets `ForbiddenError`.
- Someone who gets in another way has their pending request settled as `approved` with `decided_by` null:
  on auto-join (policy changed while they waited) and on accepting an invitation (`afterAcceptInvitation`
  hook in `server.ts`). An approval for someone who is already a member keeps the role they have.
- Pending requests stay decidable after the policy goes back to `invite_only` or the domain is removed (the
  decider is granting membership, like an invite). People who joined stay when a domain is removed.
- Email (`email.ts` `joinRequestEmail`, `joinDecisionEmail`; same escaping/unlinkable rules as the
  invitation): a new request mails every owner and admin once (re-asking while pending sends nothing); a
  decision mails the requester. Sent after the transaction commits, through the same SMTP config
  (`apps/web` `getMailer()`; Mailpit in dev); a failed send is logged and never fails the request/decision.
  The request email links to `/settings/workspace/members`, which shows the *active* workspace — the text
  names the workspace to switch to (a link that switches workspace on GET was not added).

**Web**
- `/join` (`app/(auth)/join/page.tsx`, the calm 360 px auth column; in the proxy matcher): rows for
  invitations (Accept / Decline) and matching workspaces (Join / Request access / "Requested"); the first
  actionable row is the one primary button, "Create my own workspace" the ghost alternative (it becomes the
  primary when the only thing left is a request that is waiting). No choices → the page creates the
  workspace and goes Home, so nobody ever sees an empty join screen; a user who already has a workspace is
  sent Home. The shell (`getContext`) redirects a workspace-less user with choices to `/join` — this replaces
  step A's redirect to `/invite/<token>`. `/invite/<token>` itself is unchanged (email links, signed-out).
- Settings → Workspace → General gets a **Joining** section (owners/admins only; not rendered for others):
  three radios, saved on change, and "Allowed email domains" with Remove and one "Allow <my domain>" button —
  no text field. An owner on a public mailbox address is told why there is nothing to add.
- Members page: **Requests to join** (owners/admins; hidden when empty) — role select (roles ≤ own), Approve,
  Decline. `WorkspaceSettings` gained `joining`, `joinRequests`, `approveRoles`.
- Actions in `server/actions/joining.ts`; deny cases for each in `entrypoints.int.test.ts` (`createMyWorkspace`
  is `SELF_SCOPED` in the authz registry).

**For step C / follow-ups**
- A user with a workspace has no way to find other workspaces open to their domain (`/join` sends them
  Home). If C adds "Join a workspace" next to "Create workspace", `getJoinChoices` already works for members
  (it skips workspaces they are in); the page's two redirects are what to relax.
- `auto_join` + step A's finding 6: a `workspace`-visibility note in a workspace of one reads "Only you" and
  becomes readable by whoever auto-joins. Turning on `request`/`auto_join` is now a second way that happens;
  settle the wording with Private / Shared.
- Removal (review 1): being removed **by someone else** is recorded as a `declined` `join_request` (by the
  remover; a request of theirs that was waiting is declined too), so the removed person can neither
  auto-join nor ask again — an invitation is the only way back, and accepting one writes a new `approved`
  row so the "no" stops standing. Leaving on one's own records nothing. Separately, the `workspace_domain`
  rows someone added are dropped when they stop being owner/admin (demoted, removed or leaving), next to
  `revokeInvitesBeyondAuthority`; a row another current owner/admin could list themselves (verified email
  on that domain) is kept and re-attributed to them. The policy is left as it is.
- An invited newcomer whose email is **not verified** is not held for the invitation (invitations are only
  offered to verified addresses), so `ensureFirstWorkspace` gives them a workspace of their own. Not
  reachable today — magic link and Google both verify — but a future password or unverified sign-up flow
  must revisit it (with the `/change-email` note below).
- Desktop: someone who signs in on the desktop only and has choices gets no workspace until they open the web
  (step A's "You’re not in a workspace… on the web" message covers it). No join UI on the desktop.
- `/change-email` is disabled (`DISABLED_AUTH_PATHS`). If it is ever enabled, the new address must be
  verified before `emailVerified` stays true — domain matching trusts that flag.
- Axe: the join screen is scanned whole (0 violations of any impact, light and dark); the Joining section and
  the requests list are scanned as sections (`include`), because the pages around them belong to the main
  sweep. Seen while scanning the whole General page, **not fixed (pre-existing, outside step B)**:
  `label-content-name-mismatch` (serious) on the "Choose workspace icon" button (visible text "Add icon"),
  a page `a11y.spec.ts` doesn't visit; plus `region` (moderate) findings in the app shell.

**Out of scope touched:** `members-panel.tsx` `ROW` — rows drew a box instead of a divider as soon as a list
had two rows (`border-gray-alpha-300` coloured all four sides of `Item`'s border); now bottom edge only. It
shows in the members list too. `apps/web/e2e/workspaces.spec.ts`: the invited-newcomer part now goes through
`/join`. `test-harness.ts`: `signUp(label, domain?)` and `outbox`.

### Step C (branch `task/unified-workspaces-c`, from step B's `96f938b`)
What was decided, and what a reviewer needs to know.

**The split** (`packages/core/src/sections.ts`, unit tests `sections.test.ts`; shared by web and desktop)
- `sidebarSection(item, userId)`: **Private** = `visibility === 'private'` **and** `ownerId === userId`;
  everything else the viewer can read is **Shared**. `splitSections` (flat lists, desktop), `sectionTree`
  (tree: a section's items and its top level), `SECTION_INFO` (labels + empty-state lines), `visibilityLabel`
  / `visibilityBadge` (wording). Display only: nothing here authorises a read and `permissions.ts` is
  untouched. A private item that is not the viewer's is never filed under Private.
- Decided: the split is **per item**, not per top-level ancestor. My private page inside a shared folder is a
  top-level item of Private (before, it sat inside the folder under Shared with a lock icon); the folder's own
  page still lists it for me, with the lock. So "Private" is exactly "what nobody else can see".
- Order: Private first (where a new note starts), then Shared. Empty states: "Notes only you can see." /
  "Notes everyone here can see." No boxes; the existing `SidebarGroupLabel`s.
- Web: `lib/tree.ts` (`areaOf`, `sectionOf`, `rootsOf` take the user id), `page-tree.tsx`. A note changes
  section without reload because the Share dialog already refreshes the shell data. Dropping a row on the
  other section's label is still refused (now: "To change who can see it, open it and use Share").
- Desktop: `MeetingNoteSummary` gained `ownerId`; `MeetingList` renders the two sections from
  `splitSections`; a change arriving by sync re-renders it (`meetings:changed`). `MeetingNotes.list()` also
  drops a private note that isn't mine should one ever be in the local store (sync never sends one).
- New notes are Private everywhere — verified, no change needed: web "New note" and the `+` of Private, web
  calendar notes (`calendar-notes.ts`), sync push (`push.ts`), desktop `createMeeting` (recordings and
  "Start notes" on a calendar event; asserted in the desktop e2e). The `+` of **Shared** on the web still
  creates a shared page on purpose.

**Switcher**
- With one workspace the bottom button stays (workspace name, the menu with Workspace settings, Invite
  members, Create workspace, account) but has no selector arrows and **no workspace list**; with two or
  more the list is back. Same on the desktop (its menu keeps "Workspace settings (web)").
- **The test id `workspace-switcher` is still on that button in both cases** (≈100 uses across web, desktop
  and acceptance specs, some being edited on another branch). "Absent" is asserted as
  `data-switchable="false"`, no `workspace-list`, zero `workspace-option`. Renaming the id is a follow-up.
- Joining stays reachable: `ShellData.canJoin` (`getJoinChoices` non-empty, one extra query set per shell
  load) shows "Join a workspace" → `/join`, which now shows a member their choices with "Back to Oat"
  instead of "Create my own workspace". A member with nothing to join is still sent Home (step B's spec).
  The desktop has no create/join UI (as before: the hint sends people to the web).

**Labels** (step A review finding 6)
- `audienceLabel` / `isWorkspaceOfOne` are gone. Badges come from `visibilityBadge`: "Private", "Everyone in
  <workspace>", "Everyone in <workspace> + link" — never "Only you" for a `workspace`/`link` item, whatever
  the member count. Web document and meeting headers, shared folder page, desktop note header. The Share
  dialog already said "Everyone in X (only you, so far)" and is unchanged.

**Leaving and export**
- Leave dialog: says access to everything is lost, private notes included, that they stay behind unreadable
  to anyone else; offers "Export my notes" (a plain download link) above Cancel / Leave.
- `GET /api/workspaces/:id/export` (`server/export/notes.ts`): the caller's **own, live** documents of that
  workspace (pages and meeting notes, any visibility) as `# Title` + `content_md`, one `.md` each, flat.
  Member check first (`requireMember` → 404, same as an unknown workspace); each row must be
  `ownerId === caller` **and** pass `canReadDocument`, checked on the list and again on the rows as read.
  No new rule was added to `permissions.ts` (another branch is editing it) — a named `canExportDocument`
  would be the tidier form.
- **Trash is not exported** (decided): it is what the owner threw away; restore first to take it along.
  Also not exported: transcripts, audio, other people's notes even when readable, folder structure.
- Bounded: 2000 notes (`MAX_EXPORT_DOCUMENTS`; beyond it the archive carries a file saying it is
  incomplete, plus an `x-oat-export-truncated` header), read 20 at a time while the response streams
  (nothing is read before the client pulls). **No rate limit** on the route — like the other GETs.
- Zip: own small writer (`server/export/zip.ts`, deflate, UTF-8 names, no ZIP64, no new dependency), read
  back in tests by `read-zip.ts` and, where installed, the system `unzip`; checked by hand with Python
  `zipfile` and macOS `ditto`. File names (`names.ts`): separators, control/invisible characters and
  reserved punctuation become spaces, no leading dot, no trailing dot/space, ≤ 80 characters, Windows
  device names prefixed, duplicates numbered case-insensitively; the writer refuses unsafe names as well.
- After leaving nothing is readable: unchanged rule ("doc owner" requires membership); asserted in the int
  test and the e2e (documents, list, export, page).

**Tests**
- Unit: `@oat/core` `sections.test.ts`; web `navigation.test.ts`, `export/zip.test.ts`; desktop
  `meeting-list.test.tsx`, `workspace-switcher.test.tsx`, `meeting-notes.test.ts`.
- Int: `export/notes.int.test.ts` (deny cases carry `denies('GET /api/workspaces/[id]/export')`).
- Web e2e: new `private-shared.spec.ts` (7 tests; sidebar and leave dialog scanned with axe, any impact,
  light and dark). Desktop e2e: `workspaces.spec.ts` (new test + assertions; sidebar axe light/dark).
- Screenshots (1440×900): `sidebar-empty-*`, `sidebar-private-shared-*`, `leave-dialog-export-*`,
  `workspace-menu-{one-workspace,two-workspaces}-light`, `desktop-sidebar-private-shared-*`.

**Specs changed because step C changes what they cover**
- Web: `auth.spec`, `join.spec`, `workspaces.spec` ("exactly one workspace" was `workspace-option` count 1,
  now `data-switchable="false"` and count 0), `sharing.spec` (badge text), `calm-shell.spec` (menu label).
  `join.spec`'s helpers moved to `e2e/people-helpers.ts`, shared with the new spec.
- Desktop: `e2e/workspaces.spec.ts` only. Acceptance: `journey.spec.ts` line 446, the badge text
  ("Only you + link" → `/^Everyone in .+ \+ link$/`) — one line; that journey still fails earlier for the
  known reason, so this line is **not run**.

**Not done / to know**
- Desktop evidence has no screenshot of an empty Private/Shared pair (covered by unit and e2e assertions).
- Export is offered only in the leave dialog; a removed member gets no chance to export (D-36 says
  "before leaving").
- `canJoin` adds `getJoinChoices` to every shell load.

## Review

### Step A
Verdict: **changes** (2026-11-21, reviewer; diff `task/unified-workspaces...task/unified-workspaces-a` at 36cd434).
One regression to fix (1), one acceptance gap on the desktop (2); 3–7 are small or for the orchestrator to
decide. Everything else in the brief's checklist held up — see "Checked and fine".

Ran on this branch: `@oat/core` test (100 % coverage), `@oat/local-store` test, `@oat/auth` test + `test:int`
(83 passed), `@oat/db` `test:int` (56 passed, incl. the 0013 migration test), `@oat/desktop` test. I did not
re-run the full `pnpm run ci` or any e2e (verifier's job).

**Must fix**

1. `packages/auth/src/members.ts:250-252` (`deleteWorkspace`) — authorisation now uses a role read *before*
   the workspace lock. `lockedActorContext` loads the actor's memberships, then `lockWorkspace` waits for the
   mutex, then `assertCan('deleteWorkspace', own, …)` decides on the earlier read; the base branch decided on
   `contextOf(locked)`, i.e. rows read under the lock, which is what the module comment still promises.
   Scenario: U and O own workspace A (U also has B). O demotes U to member while U's delete is waiting on A's
   lock → the demotion commits, then U's delete succeeds as a non-owner.
   **Confirmed by running it**: a throwaway int test (hold `workspace` row `FOR UPDATE`, start
   `deleteWorkspace`, demote the actor in the holding transaction, commit) ended with `deleted` and
   `deleted_at` set; not committed. Fix direction: take the actor's role in this workspace from
   `locked.members` (or re-read the context after `lockWorkspace`) and keep the all-memberships read only for
   the last-workspace count; add the race as a regression test. Leaving (`removeMember`, line 217-220) uses
   the same early context but only for "is a member at all" — target and owner count come from the locked
   rows, so I found no wrong outcome there; worth building both the same way.

2. Desktop, user with **zero** workspaces — acceptance "with none, the user is asked to create one" is only met
   when a view-only workspace is present. `apps/desktop/src/main/workspaces.ts:36-38`
   (`noNoteWorkspaceMessage`) answers `CONNECT_ONCE_MESSAGE` whenever `store.workspaces()` is empty, and
   `workspaces-state.ts:87` sets `needsWorkspace` only when `active !== null`. A synced store is empty when
   the user was removed from their only workspace or its owner deleted it (`applyPull` →
   `#dropWorkspacesExcept`), both of which D-36 allows; nothing on the sync path calls `ensureFirstWorkspace`
   (only `shell.ts:104` and `server.ts:397/410`), so a desktop-only user stays that way. Result: every "Start
   notes"/record first waits the 10 s `awaitWorkspaces` timeout (`sync-service.ts:287`), then says "Oat
   needs to connect once… Check your connection", and the sidebar shows no hint. No recording is lost (refused
   before capture, `recording-service.ts:398`), but the user is told the wrong thing and never told to open
   the web. **Traced, not run.** Fix direction: tell "never pulled" from "pulled, no workspace" (the pull
   cursor / `STATE.workspaces` is set after a pull) and show the create-a-workspace wording + sidebar hint
   without the wait; or heal server-side on pull. Add a test for the empty-after-sync store.

**Should fix / decide**

3. `packages/auth/src/server.ts:348-357` — "last active workspace" is only recorded on `organization/set-active`.
   Accepting an invitation makes that workspace active in the session through Better Auth without passing
   that path, so: user in A accepts an invite to B, works in B, signs in on another device → starts in A
   (oldest), not B. Creating a workspace is fine (`actions/workspaces.ts:60` calls set-active). Traced, not
   run; suspicion as to how visible it is. Either remember on accept too or note it as intended.
4. Old-client compatibility was dropped (`packages/core/src/sync.ts`, `apps/web/src/server/sync/pull.ts:170`):
   the task's Design notes ask for one desktop version where `kind` stays optional; the step note says
   "skipped as agreed" but the agreement is not recorded anywhere I was given. A desktop build from `main`
   fails to parse every pull that carries a workspace row. Fine if no such build is in use — the orchestrator
   should confirm and amend the Design note, or the field goes back as optional-and-ignored.
5. `apps/web/src/components/app-shell/create-workspace-dialog.tsx:20,58` still says "Create a team
   workspace" (also `createTeamWorkspace` in `actions/workspaces.ts:49`). User-visible leftover of the two-kind
   model; the grep in the acceptance criterion doesn't catch "team". Confirmed by reading.
6. `apps/web/src/lib/workspace.ts:13-24` — "Only you" for `workspace`-visibility items now depends on the
   member count. In a workspace of one, a note the user set to workspace visibility reads "Only you" and
   becomes readable by whoever is invited next (and by auto-joiners once step B lands), with no change on the
   note. Before, a personal workspace could never gain members. Not a permission bug (rules unchanged);
   wording risk to settle in step B/C at the latest. Observation.
7. `apps/desktop/src/main/workspaces.ts:36-38, 91` — a workspace row with `role: null` is no longer creatable,
   and with only such rows the refusal says "You can only view the workspaces you're in", which is not what
   is known. Reachable only on a store that has rows but no roles yet (upgrade from a pre-3.9 store while
   offline). Low; traced.

**Resolutions (implementer, 2026-11-21)**

1. Fixed. `members.ts`: `lockActor` (user lock) → `lockWorkspace` → `lockedActorContext(tx, locked, actor)`,
   which takes the actor's role in this workspace from the locked rows and their other live memberships from
   a read made after both locks. Leave is built the same way. Regression tests in `members.int.test.ts`
   ("a change that commits while the action waits for the workspace lock"): demoted owner's delete is
   refused; a member removed meanwhile gets not-found; an owner who becomes the last owner meanwhile stays.
2. Fixed. `LocalStore.hasPulled()` (a pull has completed); `noNoteWorkspaceReason` = `unknown` | `none` |
   `view-only`; synced with no workspace → "You’re not in a workspace any more… Create a workspace in Oat on
   the web" after a 1.5 s re-check instead of the 10 s wait, still before any audio. The snapshot carries
   `synced`, and the sidebar hint says "You’re not in a workspace. Create one on the web to take notes."
   Unit tests for never-synced vs synced-and-none in `workspaces.test.ts`, `workspaces-state.test.ts`,
   `workspace-switcher.test.tsx`. The server does not heal on pull (the web shell and sign-in still do).
3. Fixed. The after-hook also records `organization/create` (unless `keepCurrentActiveOrganization`) and
   `organization/accept-invitation`. Int test "a workspace the user creates, or joins by accepting an
   invitation, is where they start next".
4. No code change; Design note amended (window dropped: no production database, no released desktop).
5. Fixed. Dialog reads "Create a workspace" (description no longer says "team"); the action is
   `createWorkspace` (authz registry updated). `create-team-button.tsx` was already deleted. Test comments
   that call a shared workspace a "team workspace" were left alone.
6. Deferred to step C; noted under Design notes → Step A.
7. Fixed (small): a row with `role: null` makes the reason `unknown` (connect message, no sidebar hint), not
   `view-only`. Tests next to 2.

**Checked and fine**

- Migration 0013: ids untouched, rename only where the name is still "Personal", slugs regenerated with 12
  random hex (≤ 53 chars, pass the app's slug rule, unique in the test), constraint/index/column/enum dropped
  in a valid order, journal idx 13 follows 12, change-log rows written for the renamed workspaces. The
  migration int test runs from a DB at the previous schema with data and passes.
- `user.last_active_workspace_id`: no FK by design; never used unchecked — `startingWorkspaceId` and
  `pickActiveWorkspace` only accept it when it is among the user's live memberships, so removal from it or a
  soft delete falls back to the oldest membership. Not client-settable (not a Better Auth field; `/update-user`
  accepts `name` only).
- `ensureFirstWorkspace`: check + insert under a per-user advisory lock; concurrent calls create one (int
  test). Pending-invite path excludes expired, answered, revoked invites and deleted workspaces (int test);
  revoked-by-authority invites are cancelled in `removeMember`/`changeMemberRole`, so they don't hold a
  newcomer back. Any admin can park a not-yet-registered address on their invite page until that person
  declines — inherent to "no workspace while an invite is pending"; step B's join screen replaces it.
- Last-workspace rule: in `permissions.ts` (`isLastWorkspace`, fails closed on a one-workspace context) with
  deny tests; enforced in `@oat/auth` for leave and delete under the user lock, with concurrency tests for two
  leaves and two deletes. Better Auth's own `leave` / `remove-member` / `delete` / `update-member-role` stay
  blocked (`BLOCKED_ORGANIZATION_PATHS`); there is no account-deletion path. Removing someone else from their
  only workspace is allowed and clears their session's active workspace; the web shell and the next sign-in
  give them a new one (desktop: see 2). A leave racing with someone else's removal/delete of the user's other
  workspace can still end at zero — same accepted outcome.
- Lock order is user → workspace everywhere; no cycle found.
- Local-store migration 5: in-place `DROP COLUMN`, tested from a version-4 file built by migrations 1–4 plus
  fixture rows (documents, outbox, cursor, search preserved). Pull scope not bumped, so no re-download.
- Record-target fallback: active if creatable, else first creatable by name, else refusal before any audio.
- Leftovers: the task's grep returns only migrations/snapshots, the two migration tests + fixture and
  calendar fixtures. Clean-room and D-11: nothing new touches `research/` or an external service. Tests were
  adapted rather than removed (auth int 83, members deny cases kept and extended).

### Step B
Verdict: **changes** (2026-11-21, reviewer; diff `a1329ce...task/unified-workspaces-b` at ecd4dd8).
One must-fix (1: removal doesn't hold against domain joining); 2–3 are decisions for the orchestrator/human;
4–7 are small. The join rules themselves, the entry points, the races and the migration held up — see
"Checked and fine".

Ran on this branch: `@oat/core` test (100 % coverage), `@oat/auth` test (70) + `test:int` (115), `@oat/db`
`test:int` (56), web `entrypoints.int.test.ts` (96) — all pass. Findings marked **confirmed by running** come
from a throwaway int test added to `joining.int.test.ts` and reverted (not committed). I did not run the full
`pnpm run ci` or the e2e (verifier's job).

**Must fix**

1. Removal / demotion does not close the door an admin opened — `packages/auth/src/members.ts:226-247`
   (`removeMember`), `:201-218` (`changeMemberRole`), `packages/core/src/permissions.ts:531-537`
   (`canAutoJoin`), `packages/auth/src/joining.ts:377-400`.
   Scenario: Eve (`eve@agency.io`) is an **admin** of Acme's `invite_only` workspace. She presses "Allow
   agency.io" and sets the policy to `auto_join` (both allowed to an admin). The owner removes her. The
   `workspace_domain` row and the policy stay; Eve calls `joinWorkspace` and is a `member` again at once, and
   so is any other verified `@agency.io` address (they are *offered* the workspace on `/join`). Same after a
   demotion to viewer: the domain she listed stays although she could no longer list it.
   **Confirmed by running**: after `removeMember` by the owner, settings were still
   `{ policy: 'auto_join', domains: ['<eve's domain>'] }`, Eve's `joinWorkspace` returned `{ joined: true }`
   with role `member`, a second person on her domain was offered `join` and joined.
   This contradicts D-36 ("a removed … member loses access to everything in that workspace") and the rule
   step A already applies to invitations (`revokeInvitesBeyondAuthority`: an invite stops counting when its
   sender loses the authority). It is also the general form of the rejoin the implementer flagged: any member
   removed from an `auto_join` workspace on a listed domain is back in one click; removed from a `request`
   workspace they may ask again and every owner/admin is mailed again (confirmed: three rounds, three
   requests, one mail each — bounded by an approval per round, so not a flood on its own).
   Smallest fix, no new table: (a) when someone is removed **by another person**, write a `join_request` row
   for them with status `declined` and `decided_by` = the remover (or settle their latest one that way), and
   give `canAutoJoin` the same `previous` argument `canRequestToJoin` has, refusing on `declined` — "a no
   stands until an owner/admin invites them" then covers removal for both policies; accepting an invitation
   already settles it. Leaving on one's own should not write it. (b) in `removeMember` and `changeMemberRole`
   (next to `revokeInvitesBeyondAuthority`), delete `workspace_domain` rows whose `added_by` is the target
   once they are no longer owner/admin — or keep a row only while some current owner/admin has that verified
   domain. Deny tests for both; the UI text "People who already joined stay" is unaffected.

**Should fix / decide**

2. A decline is not final once the policy changes — `packages/core/src/permissions.ts:531-537`, `:565-570`
   (`joinOption` tries `canAutoJoin` first, which ignores `previous`). Scenario: Sam asks, the owner declines;
   later an admin switches the workspace to `auto_join`; Sam is offered "Join" and gets in.
   **Confirmed by running.** Arguably what `auto_join` means, but the Design note says a no stands "until an
   owner/admin invites them". Fix 1(a) settles it either way; otherwise record it as intended.
3. An admin (not only an owner) can open the workspace to their whole domain — `permissions.ts:500-502`
   (`canEditJoinSettings` = `canManageMembers`). An admin can already invite individuals up to admin, so this
   is not an escalation of role, but it is an escalation of *reach*: one click admits every present and future
   address on a domain, silently (no mail to owners, nothing on the Members page says how someone got in).
   D-36 says "owner/admin", so this is as decided; flagging that with 1 unfixed it is what makes 1 serious.
   Cheap mitigations if wanted: mail owners when the policy or a domain changes; show "joined via domain".
   Traced.
4. Approve racing an accepted invitation — `packages/auth/src/joining.ts:534-539` vs Better Auth's
   `accept-invitation`, which does not take the workspace lock and inserts the membership without
   `ON CONFLICT`. If the approval commits between Better Auth's membership check and its insert, the accept
   fails on `membership_workspace_user_uq` (a 500 "Couldn't accept the invitation"); the person is a member
   with the approver's role, the invite stays `pending`. No duplicate membership and no wrong access (the
   unique index holds). **Suspicion, traced only**; narrow window, self-healing on retry. Note it or ignore.
5. `packages/auth/src/joining.ts:227,258` — the 40-row cap is applied before filtering. With more than 40
   non-`invite_only` workspaces on one domain, rows the person is a member of or was declined by use up the
   cap and later workspaces are never offered. Only reachable on a very large domain; traced.
6. Public mailbox list is by exact domain (`packages/core/src/email-domains.ts:13-159`) and, as its comment
   says, not exhaustive: e.g. `outlook.com.au`, `hotmail.co.jp`, `live.ca`, `yahoo.co.id`, `gmx.fr`, `mail.de`,
   `163.net` are missing. Scenario: an owner on `x@live.ca` allows `live.ca` with `auto_join`; every `live.ca`
   user is offered and can join **that owner's own** workspace. Only the lister's own workspace is exposed, so
   low; worth adding the obvious regional variants. Related and inherent (DNS verification is out of scope):
   anyone with one address at `bigcorp.com` can create "BigCorp", allow the domain with `auto_join`, and every
   later `@bigcorp.com` sign-up is shown it first on `/join`. Observation for the human, not a defect of B.
7. `packages/auth/src/joining.ts:136-138` — `pendingInvitesFor` returns nothing for an unverified user, so
   `ensureFirstWorkspace` now creates a workspace for an unverified invited newcomer where step A held them
   for the invite. Not reachable today (magic link and Google create verified users; password sign-up and
   `/verify-email` are disabled) and it fails closed. Keep in mind with the `/change-email` note. Traced.

**Checked and fine**

- Domain matching: only `emailVerified` rows match, in `matchingJoinDomain` and again in every server path
  (the person is always `lockUser`'s row; no action takes an email or a domain to match or add —
  `allowMyDomain(workspaceId)` has no domain argument, `removeAllowedDomain` only keys a delete in a
  workspace the caller manages). Extraction: after the last `@` (`a@b@acme.com` → `acme.com`, which is that
  domain's mailbox), trimmed, lower-cased, trailing dot dropped; exact match, so `evil.acme.com` ≠ `acme.com`
  both ways; plus-addressing irrelevant (domain only); non-ASCII domains fail the hostname pattern and match
  nothing (fail closed), punycode compares literally. Public list is consulted on the normalised domain at
  match time as well as at add time, so a row inserted behind the rules still never matches (int test). Case
  can't bypass it; the DB check keeps stored domains lower-case/trimmed. Email can't change after
  verification: `/change-email`, `/verify-email`, `/sign-up/email` are disabled and `/update-user` takes
  `name` only.
- Policy enforcement: `joinWorkspace` → `autoJoin` only, always role `member` (hard-coded);
  `requestToJoin` → `request` only; `invite_only` is filtered in SQL and again by `joinOption`; a deleted
  workspace is `NotFound` in `lockJoinable`/`lockWorkspace`; approve role ≤ decider's role, decided on rows
  read under the workspace lock; `join_policy` is not a Better Auth organization field and
  `beforeUpdateOrganization` refuses it. Non-members get the same `NotFound` for "not open", unknown and
  deleted, and the actions map unknown request / foreign workspace to one message, so ids can't be probed.
  Web deny cases for all seven actions are in `entrypoints.int.test.ts`.
- Leaks: a non-member sees only name, logo and member count of `request`/`auto_join` workspaces on their own
  verified domain — nothing for `invite_only`, no member or admin addresses. Join settings and requests are
  loaded for any member server-side but only returned to owners/admins (`buildWorkspaceSettings`).
- Races: locks are user → workspace row everywhere, no cycle; `join_request_one_pending_uq` (partial unique)
  and `membership_workspace_user_uq` are the database backstops; the existing concurrency tests (8 joins,
  8 requests, 2×approve + 2×decline, join vs delete) pass. A request made while the policy flips is
  serialised by the workspace row lock. Pending requests stay decidable after a flip to `invite_only` — a
  deliberate, documented choice I agree with (the decider grants it, like an invite).
- Emails: built from rows read in the transaction; names, addresses and workspace names are flattened,
  capped, made unlinkable and HTML-escaped (`emailSafeText`/`unlinkable`/`escapeHtml`, unit tests); links are
  fixed paths on `baseURL`; one mail per created request, none on re-ask; sent after commit through the
  existing SMTP mailer (Mailpit in dev, D-11), failures logged only.
- `/join`: invitations are listed only for the session user's own verified address and the accept/decline
  actions re-check recipient and verification, so an invite for another address is neither shown nor
  accepted. No loop: the shell and the page use the same `getJoinChoices`; with no choices the page creates
  the workspace; "Create my own workspace" is always there; a declined requester gets their own on the next
  visit. Desktop-only users with choices stay workspace-less until they open the web (documented).
- Migration `0014_join_policy`: journal idx 14 after 13, additive, `join_policy` default `invite_only` NOT
  NULL, FKs cascade on workspace/user, checks for decided-at/role consistency, indexes on the lookups.
- Scope: `members-panel.tsx` `ROW` border change is a one-class fix that also affects the members list
  (fine, noted by the implementer); exporting `lockWorkspace`/`contextOf`/`liveMemberships`/`Tx` and moving
  `ensureFirstWorkspace` to `joining.ts` are needed by the step. New UI uses `@oat/ui` components and token
  classes only (no raw colours or inline styles). Clean-room: nothing touches `research/`.
- Acceptance criteria for step B are met as written; 1 is a gap against D-36's removal rule rather than a
  listed criterion.

**Resolutions (implementer, 2026-11-21)**

1. Fixed, both parts. (a) `members.ts` `recordRemoval`: `removeMember` by another person declines the
   target's pending request and writes a `declined` `join_request` (`decided_by` = remover), not when
   leaving. `@oat/core` `canAutoJoin` now takes `previous` like `canRequestToJoin` and refuses `declined`;
   `joinOption` passes it, so the workspace is not offered either. An accepted invitation
   (`recordAdmittedByInvitation`, from `afterAcceptInvitation`) writes a fresh `approved` row, so the
   invitation is the way back and the "no" stops standing afterwards. (b) `dropDomainsBeyondAuthority` in
   `changeMemberRole` and `removeMember` (removed or leaving): domains the target added go once they are
   not owner/admin, unless another current owner/admin's verified email is on that domain (then the row is
   re-attributed to them). Tests: core deny cases (`canAutoJoin` / `joinOption` with `declined`);
   `joining.int.test.ts` "removal and lost authority close the door" (removed admin and their colleague are
   refused and not offered; removed member stays out while the domain is still listed, others still join; a
   waiting request is declined; invitation works after removal; leaving is not a "no"; demotion and leaving
   drop the domain; shared-domain row is kept); web `entrypoints.int.test.ts` `removeMember: someone removed
   can’t come back through the domain, only by invitation`.
2. Fixed by 1(a). Test: `joining.int.test.ts` "a declined requester is not let in when the policy later
   becomes auto_join" (+ the core `joinOption` case, which used to expect `join`).
3. No code change (decided): an admin may open the workspace to their domain, as D-36 says; the orchestrator
   raises it with the human.
4. Fixed in the web action: when Better Auth's accept fails, `acceptInvite` asks `@oat/auth`
   `inviteAlreadyHonoured` — invited verified address, already a member of that live workspace → the
   invitation is marked accepted, the workspace made active, and the action ends as a normal accept (no
   500). The other loser (approval after the accept) was already a no-op (`ON CONFLICT DO NOTHING`).
   Better Auth's accept does not check for an existing membership at all, so the state the race loser finds
   is reproduced in sequence (approve, then accept) in `joining.int.test.ts` "approve and an accepted
   invitation at once" and in `entrypoints.int.test.ts` (`acceptInvite: … still succeeds`). The true
   interleaving (approval committing between Better Auth's two statements) **can't be forced
   deterministically** from a test; not attempted.
5. Fixed. `joinableWorkspacesFor` reads every candidate (no SQL limit), applies `joinOption`, stops at 20,
   and only then counts members for those 20. Test: "many workspaces on one domain" (45 workspaces, member
   of the first 41 → offered the last 4; a newcomer → the first 20).
6. Fixed by rule: `PUBLIC_MAILBOX_FAMILIES` + `isPublicMailboxFamily` (see Design notes → Rules); `mail.de`,
   `163.net`, `126.net` added to the exact list. Tests: `live.ca`, `outlook.com.au`, `hotmail.co.jp`,
   `yahoo.co.id`, `gmx.fr`, … are public; `liveperson.com`, `outlookgroup.io`, `team.outlook.com`,
   `live.acme.com`, … are not.
6b. No code change (decided): lookalike workspaces are inherent without DNS verification (out of scope);
   the orchestrator raises it with the human.
7. No code change (decided): not reachable today; one line added to Design notes → Step B.

## Evidence

### Step A
Verifier, 2026-11-21, branch `task/unified-workspaces-a` at a1329ce. Verdict: **pass for Step A** — every
Step A criterion holds and no failure is caused by this branch — **but the gate is not green**: `e2e` and
`acceptance` are red here exactly as on `main` (d3b92e2), see "Baseline". Steps B/C not checked.

**1. `pnpm install && pnpm run ci` (full)** — install: "Already up to date".
```
step             status     time  note
format           pass       4.8s
actionlint       pass       0.2s
typecheck        pass       0.5s
lint             pass       0.8s
test             pass       0.2s
stack            pass       0.2s
migrate          pass       1.8s
swift:release    pass       0.5s
test:int         pass     179.3s
e2e              FAIL     448.9s  failing package(s): @oat/desktop, @oat/web
acceptance       FAIL      35.1s  pnpm --filter @oat/acceptance run acceptance exited with 1
swift:build      pass       0.5s
swift:test       pass       4.1s
swift:synthetic  pass       2.2s
total                     679.1s
ci: FAILED (e2e, acceptance)
```
(typecheck/lint/test were turbo cache hits; the Step A packages were re-run uncached below.)
- e2e `@oat/desktop`: 8 passed, 10 failed, 10 did not run. `workspaces.spec.ts` 4/4 and `desktop.spec.ts` 4/4 pass.
- e2e `@oat/web`: 76 passed, 17 skipped, 1 failed — `typography.spec.ts:13` (dark): "browser console errors",
  4× `Failed to load resource: … 429 (Too Many Requests)`. `notion.spec.ts` passed in this run.
- e2e `@oat/editor`: 16 passed, 2 skipped.
- acceptance: 1 failed — `journey.spec.ts:159`, step "desktop: cold start, sign in through the browser",
  `getByTestId('meeting-start')` not visible (line 246).

**2. Step A verification commands** (run directly, not through turbo)
```
pnpm --filter @oat/core test permissions      320 passed; coverage 100 % statements/branches/functions/lines
pnpm --filter @oat/auth test                  10 files, 64 passed
pnpm --filter @oat/auth test:int              4 files, 86 passed
pnpm --filter @oat/local-store test           8 files, 83 passed
pnpm --filter @oat/db test:int                7 files passed, 1 skipped; 56 passed, 1 skipped
pnpm --filter @oat/desktop test workspaces    3 files, 30 passed
web   playwright workspaces/auth/calm-auth/sharing .spec.ts   17 passed (28.2s)
desktop playwright e2e/workspaces.spec.ts                      4 passed (23.2s)
web   playwright e2e/typography.spec.ts (alone, re-run)        3 passed (light + dark)
web   playwright notion.spec.ts + documents.spec.ts            9 passed
```

**Acceptance criteria, Step A**
1. No `kind`/"personal" left — **pass**. `git grep -Il -iE "personal|WorkspaceKind|kind === 'team'" -- apps packages`
   (tracked files; a plain `grep -r` also walks `.next*` build output) returns only: `packages/db/drizzle/*`
   (0001, 0003, 0013 + snapshots/journal), `packages/db/src/unified-workspaces-migration.int.test.ts`,
   `packages/local-store/src/{migrations.ts (migration 1), migration-5.test.ts, fixtures/v4-two-kinds.sql}` and
   `packages/calendar/src/google/source.test.ts` (a Google calendar titled "Personal"). Outside apps/packages:
   calendar fixtures, `tools/mocks` gcal test, READMEs. `schema/workspace.ts`, `enums.ts`, `core/sync.ts`,
   `core/types.ts` carry no workspace kind. Not a special case, but still named after the old model:
   test-harness helper `teamWorkspace`, option `maxTeamWorkspaces` / `AUTH_MAX_TEAM_WORKSPACES`, and "team
   workspace" in test comments and `e2e/acceptance/journey.spec.ts`.
2. Existing user keeps documents under the same workspace id; renamed; can invite/rename — **pass**. Read
   `0013_unified_workspaces.sql` (updates name/slug only, then drops constraint, index, column, enum; ids
   untouched) and ran `unified-workspaces-migration.int.test.ts` (5 tests: ids + documents kept, rename with
   fallback, slugs, change log, drops) inside `@oat/db test:int`; CI `migrate` passes. Invite + rename + slug
   change of a first workspace: `auth.int.test.ts` "a first workspace is an ordinary one…" (passed). The
   invite/rename test uses a freshly created first workspace, not a migrated row; after the migration the two
   are indistinguishable in the schema.
3. New user lands in an auto-created workspace as owner; concurrent sign-up creates one — **pass**.
   `auth.int.test.ts` "concurrent calls for a user without one create exactly one, as owner" (8 parallel
   `ensureFirstWorkspace`, one id, one `created`, role owner); web e2e `auth.spec.ts:68` "signs up, lands on the
   requested page in a workspace of their own" and `:137` "signing in again keeps one workspace".
4. Leaving/deleting the only workspace refused; works with a second — **pass**. `permissions.ts:410-429`
   (`isLastWorkspace` in `canRemoveMember`/`canDeleteWorkspace`); deny cases in `permissions.test.ts:748-857`;
   `members.int.test.ts` "nobody leaves their last workspace; with a second one they can", "the last workspace
   can’t be deleted; with a second one it can"; `entrypoints.int.test.ts:235`; web e2e `workspaces.spec.ts:210`.
5. Desktop record target — **pass**. Desktop e2e `workspaces.spec.ts:221` (viewer → first workspace I can add
   to) and `:285` (view-only everywhere: hint, "Create a workspace of your own in Oat on the web, then try
   again.", recorder stays idle, meeting count unchanged, records again once a role returns); unit
   `workspaces.test.ts` "in no workspace at all" / "view-only everywhere" (30 passed). The zero-workspace case
   (review finding 2) is covered by unit tests only, not by an e2e.
6. Desktop upgrade without re-download or loss — **pass**. `migration-5.test.ts` (4 tests) upgrades the
   version-4 fixture `v4-two-kinds.sql` with a `personal` row: rows, outbox, cursor, search kept; reopen no-op.

**3. Baseline: `main` at d3b92e2** — throwaway worktree in the session scratch directory (`git worktree add
--detach <scratch>/main-base d3b92e2`, `pnpm install`), removed afterwards. Same machine, same stack, run right
after the branch runs. The ten failing desktop spec files and `journey.spec.ts` line 246 are byte-identical on
both sides except `apps/desktop/e2e/workspaces.spec.ts` (rewritten on the branch) and a 2-line change in
`journey.spec.ts`.

`pnpm --filter @oat/desktop run e2e` on main: **4 passed, 11 failed, 12 did not run**. The extracted
(test, error, locator, failing line) list of the branch run and the main run was compared with `diff`: the
ten entries below are identical; main has one more (`workspaces.spec.ts`).

| # | spec (desktop) | error on branch = error on main | class |
|---|---|---|---|
| 1 | `a11y.spec.ts:156` | `getByTestId('meeting-start')` not visible (line 203) | same failure on main |
| 2 | `auto-stop.spec.ts:173` | `transcript-panel` › `transcript-segment` nth(2) not visible (190) | same failure on main |
| 3 | `backfill.spec.ts:133` | `transcript-notice` first() not visible (155) | same failure on main |
| 4 | `calendar-notes.spec.ts:190` | `participant-chip` count: expected 2, received 0 (229) | same failure on main |
| 5 | `meeting.spec.ts:94` | `meeting-start` not visible (102) | same failure on main |
| 6 | `onboarding.spec.ts:74` | `meeting-start` not visible (158) | same failure on main |
| 7 | `playback.spec.ts:132` | `playback` `data-state` "paused": element not found (159) | same failure on main |
| 8 | `recording.spec.ts:188` | `transcript-empty` "No transcript yet": element not found (200) | same failure on main |
| 9 | `storage.spec.ts:133` | `transcript-segment[data-final=true]` nth(2) not visible (159) | same failure on main |
| 10 | `sync.spec.ts:51` | `sync-status` expected "All changes synced", received "" (58) | same failure on main |
| — | `workspaces.spec.ts` | main: `:152` fails (`transcript-panel` segment not visible, line 196), 3 not run; branch: 4/4 pass | fails on main, **fixed** by this branch |
| 11 | acceptance `journey.spec.ts:159` | `meeting-start` not visible (246), step "desktop: cold start, sign in through the browser" | same failure on main |
| 12 | web `typography.spec.ts:13` (dark) | branch full run: console errors, 4× HTTP 429. Alone on branch: pass. Main: pass with `notion.spec.ts` and in a full `@oat/web` e2e run (77 passed, 17 skipped, 0 failed) | flaky (passes alone on both) |
| 13 | web `notion.spec.ts:35` | did **not** fail on the branch in this verification (full run and with `documents.spec.ts`: pass). On main: passes next to `typography.spec.ts` and in the full run; fails once next to `documents.spec.ts` (`scrollWidth` 1178 > 390, line 202) | flaky; seen failing on main only |

Apparent cause of 1–11: the specs wait for elements the calm shell no longer shows at that point
(`meeting-start`, the transcript panel/segments/notice/empty state, `sync-status` text; `participant-chip` and
`playback` test ids are not in `apps/desktop/src` at all, on either side). The branch's renderer changes are
limited to the workspace switcher/state, the settings view and one line each in `upcoming-list.tsx` and
`main-window.tsx`. The claim "fails identically on `main`" is confirmed for desktop e2e and acceptance.
Not confirmed as stated: `typography` (dark) did not fail on main in my runs — it is a load/rate-limit flake
(429s), not a deterministic main failure; and `notion.spec.ts` "fails whenever it runs next to other specs" did
not hold on the branch (passed next to `documents.spec.ts`), though it did fail that way on main.

**Failures caused by this branch:** none found.
**Could not run / not done:** nothing skipped. Notes: the 1440×900 screenshots in *Verification* are for B/C
screens; no screenshot exists under `docs/tasks/evidence/unified-workspaces/` after these runs (the desktop
spec's `evidence(…, 'desktop-create-workspace-hint')` call left no file there). Each comparison run was made once per
side (plus the single re-run of `typography`), so the flaky classification rests on few samples.

### Step B — implementer's full `pnpm run ci` (2026-11-21, `task/unified-workspaces-b`)

```
step             status     time  note
format           pass       5.1s
actionlint       pass       0.2s
typecheck        pass       0.4s
lint             pass       0.7s
test             pass       0.2s
stack            pass       0.2s
migrate          pass       1.8s
swift:release    pass       9.3s
test:int         pass     196.2s
e2e              FAIL     611.1s  failing package(s): @oat/desktop
acceptance       FAIL      54.4s  pnpm --filter @oat/acceptance run acceptance exited with 1
swift:build      pass       6.5s
swift:test       pass       8.9s
swift:synthetic  pass       2.4s
total                     897.5s
```

Web e2e: 81 passed, 0 failed (incl. the 4 `join.spec.ts` tests, `workspaces.spec.ts`, and this time also
`notion.spec.ts` and `typography.spec.ts`). Desktop e2e: 8 passed / 10 failed / 10 not run — the same specs as
on step A and `main` (stale selectors; `workspaces.spec.ts` 4/4 pass). Acceptance fails at
`getByTestId('meeting-start')` in the desktop cold-start step, before any workspace step — the known failure.

### Step B — verifier (2026-11-21, `task/unified-workspaces-b` at 68e271b)
Verdict: **pass**, with one intermittent web e2e failure outside the known baseline (a test race, below).

**Full `pnpm install && pnpm run ci`** (install exit 0; ci exit 1)

```
step             status     time  note
format           pass       5.6s
actionlint       pass       0.3s
typecheck        pass       0.5s
lint             pass       1.0s
test             pass       0.2s
stack            pass       0.3s
migrate          pass       1.9s
swift:release    pass       0.6s
test:int         pass     206.8s
e2e              FAIL     512.5s  failing package(s): @oat/desktop, @oat/web
acceptance       FAIL      51.8s  pnpm --filter @oat/acceptance run acceptance exited with 1
swift:build      pass       0.7s
swift:test       pass       4.2s
swift:synthetic  pass       2.2s
total                     788.6s
```

- `test:int`: `@oat/auth` 126 passed, `@oat/web` 304 passed (19 files), `@oat/db` 56 passed / 1 skipped.
- Desktop e2e: 8 passed / 10 failed / 10 did not run. Failing set compared one by one with the baseline —
  `a11y:156`, `auto-stop:173`, `backfill:133`, `calendar-notes:190`, `meeting:94`, `onboarding:74`,
  `playback:132`, `recording:188`, `storage:133`, `sync:51` — identical, nothing extra.
- Acceptance: `journey.spec.ts:246` `getByTestId('meeting-start')` not visible — the baseline failure.
- Web e2e: 80 passed / 1 failed / 17 skipped. `join.spec.ts` 4/4, `notion.spec.ts` and `typography.spec.ts`
  (light and dark) passed. The one failure is **not on the baseline list**:
  `e2e/auth.spec.ts:152` "Google (mock issuer) › signs in through the provider page and lands on /home" —
  `getByRole('menu')` never appears after clicking the workspace switcher (line 160).
  - Re-run alone (`playwright test e2e/auth.spec.ts`): 9/9 pass.
  - Intermittent, and only seen when `join.spec.ts` is in the same run: with the four Verification specs
    **plus** `join.spec.ts` it failed 2 of 4 runs on this branch; the four specs without `join.spec.ts`
    passed 3 of 3 here and 3 of 3 on the step A checkout (0fb193f). Machine load average was about 16.
  - Cause as far as I traced it (not proven): the page reaches `/home` through the provider redirect, which
    is none of the navigations the `page` fixture waits for hydration on (`goto`, `waitForURL`, …), so the
    switcher can be clicked before it is hydrated. `auth.spec.ts`, `fixtures.ts` and the app shell are
    unchanged by step B; `join.spec.ts` adds several browser contexts to the same `next dev`. A test race
    this step makes more likely to show, not a product defect — but it will make full CI red some of the
    time until line 157 waits for hydration.

**Step B commands**

```
pnpm --filter @oat/core test permissions      2 files, 357 passed (coverage 100 %)
pnpm --filter @oat/auth test                  11 files, 70 passed
pnpm --filter @oat/local-store test           8 files, 83 passed
pnpm --filter @oat/auth run test:int          5 files, 126 passed
playwright workspaces + auth + calm-auth + sharing + join   21 passed (2 of 4 runs; the other 2: 20 passed,
                                                            auth.spec.ts:152 failed, see above)
```

(`pnpm --filter @oat/core test email-domains` runs 9/9 but exits 1 on the 100 % coverage threshold, as any
single-file run of that package does; the file passes in the full `test` step.)

**Acceptance criteria (Step B)**

1. Three policies — met. e2e `join.spec.ts:158` (invite_only: stranger lands in "My workspace", `/join`
   sends them Home, workspace not in the switcher), `:205` light + dark (request → "Request access"), `:312`
   (auto_join → role shown as Member). Integration: `joining.int.test.ts` "invite_only: never shown; request:
   "request"; auto_join: "join"" and "joins as member, once, however often and however concurrently". Ran.
2. Unverified / public mailbox / not the admin's own domain — met. `permissions.join.test.ts` `canAddDomain`
   "denies a domain other than their own", "denies an unverified email", "denies a public mailbox domain,
   even the actor’s own"; `matchingJoinDomain` "never matches an unverified address / a public mailbox
   domain". Ran (357 passed).
3. Approve / decline — met. `joining.int.test.ts` "approve creates the membership with the chosen role",
   "decline creates no membership, and the person can’t ask again", "one pending request per person per
   workspace, however concurrently", "a request mails every owner and admin; a decision mails the
   requester"; e2e `:205` approves as Viewer, declines the second, and reads both decision mails in Mailpit.
4. Owner/admin only — met. `joining.int.test.ts` "only owners and admins change the policy or the domains",
   "only owners and admins decide, and nobody approves above their own role"; `entrypoints.int.test.ts`
   `setJoinPolicy, allowMyDomain, removeAllowedDomain…` and `approveJoinRequest and declineJoinRequest…`;
   seeing: `workspace-settings.test.ts` "member and viewer: no join settings, no requests, nothing to approve
   with"; e2e `:312` (a member's settings page has no `join-settings`).

**Review fixes as behaviours** (all in `packages/auth/src/joining.int.test.ts` unless named; all ran green)

- (a) removed by an admin: "a removed member stays out although the domain is still listed; others on it
  still get in" (join and request both `NotFoundError`), "an invitation still works after a removal, and is
  the way back"; web: `entrypoints.int.test.ts` "removeMember: someone removed can’t come back through the
  domain, only by invitation". Would fail without `recordRemoval` / the `declined` check in `canAutoJoin`.
- (b) leaving on one's own: "leaving on one’s own is not a "no"" (no `join_request` row, offered `join`).
- (c) lister loses authority: "a removed admin can’t rejoin through the domain they opened, and nobody else
  can either" (removed), "a demoted admin’s domain goes; so does one whose lister leaves" (demoted, leaves).
- (d) "a declined requester is not let in when the policy later becomes auto_join".
- (e) `email-domains.test.ts` "covers the big providers’ country domains by rule" (`live.ca`,
  `outlook.com.au` public) and "a company domain that merely contains such a name is not public"
  (`liveperson.com`). **Gap:** these assert `isPublicMailboxDomain` only; no test puts a family domain
  through `canAddDomain` / `addOwnDomain` (those tests use `gmail.com`, `outlook.com`, …). The unit test
  does fail without the fix, and `canAddDomain` calls that function, so the behaviour is covered
  indirectly. Checked directly with a throwaway script against `permissions.ts` (not committed):
  `live.ca` and `outlook.com.au` → `canAddDomain` false, `matchingJoinDomain` null; `liveperson.com` →
  true / matches.
- (f) "filters first, then caps: workspaces the person can’t act on don’t use up the list" (45 workspaces,
  member of the first 41 → offered the last 4; a newcomer → the first 20). Fails with a cap before the filter.

**Screenshots** (`docs/tasks/evidence/unified-workspaces/`, all 1440×900, all opened)

Present: `join-screen-match-{light,dark}`, `join-screen-requested-{light,dark}`, `join-screen-auto-join-light`,
`join-no-match-home-{light,dark}`, `join-settings-{light,dark}`, `join-requests-{light,dark}`,
`join-request-email-{light,dark}`. Nothing overflows, text is readable in both themes, rows and buttons
line up. Notes, none blocking:
- "No match" is shown as the Home of a requester who was declined (workspace of their own, switcher open),
  not of a newcomer whose domain matches nothing; both end on the same screen.
- Join screen: the signed-in address wraps at the hyphen inside the domain ("…@co-" / "e15a46cf.test").
- `join-settings-*`: the "Allowed email domains" row sits at the bottom edge of the 900 px viewport; the
  "Allow <domain>" button state is not in any screenshot (the domain is already listed).
- `join-request-email-dark` is the same light email as the light one (the email has no dark variant).
- These were taken at 0ae76df, before the review fixes; the fixes did not touch these screens, and I did not
  regenerate them.

**Could not run / not done:** `main` was not re-run (baseline taken as given). The approve-vs-accept
interleaving (review 4) has only the sequential test, as the implementer noted.

### Step C — implementer's full `pnpm run ci` (2026-11-21, `task/unified-workspaces-c`)

```
step             status     time  note
format           pass       8.9s
actionlint       pass       0.7s
typecheck        pass      20.1s
lint             pass       4.8s
test             FAIL      16.3s  pnpm run test --concurrency=7 exited with 1
stack            pass       0.2s
migrate          pass       2.4s
swift:release    pass      13.2s
test:int         pass     182.0s
e2e              FAIL     694.6s  failing package(s): @oat/desktop
acceptance       FAIL      50.9s  pnpm --filter @oat/acceptance run acceptance exited with 1
swift:build      pass       6.5s
swift:test       pass       8.7s
swift:synthetic  pass       2.4s
total                    1011.8s
```

- `test`: one failure, `@oat/desktop` `src/main/recording-service.test.ts` "fixture → live two-source
  transcript (interim → final)…" (line 173: no interim segment was seen) — a file this step does not touch,
  run next to the rest of the gate. Re-run alone three times: 24/24 each; `pnpm run ci --only test`
  afterwards: `pass`. Recorded as a timing flake under load, not fixed here.
- Web e2e: 87 passed, 0 failed (incl. the 7 `private-shared.spec.ts` tests and the specs touched above).
- Desktop e2e: 9 passed / 10 failed / 10 not run — the same ten stale specs as on `main` and steps A/B;
  `workspaces.spec.ts` 5/5 pass (incl. the new Private / Shared test).
- Acceptance: the known failure, before any step this branch changes.
- Axe criterion: the sidebar (web and desktop) is this step's; the join screen, join settings and requests
  list are step B's `join.spec.ts`, which passed in this run.

### Step C — after merging step B's review fixes (2026-11-21, merge `0093ade` of `task/unified-workspaces` at 35ca216)

- Conflict: this file only (both sides appended to *Evidence*); kept both, step B's verifier section first.
  Code merged cleanly; `join.spec.ts` was not changed on the other side, so `people-helpers.ts` stands.
- Step C on top of it: `getJoinChoices` (shell `canJoin`, `/join` for members) now skips a removed or
  declined person — asserted in `private-shared.spec.ts` (removed from an `auto_join` workspace whose domain
  is still listed: no "Join a workspace", `/join` goes Home). Leaving on one's own writes no "declined"
  record, so the leave + export flow is unchanged (spec passes).
- `auth.spec.ts` Google sign-in: `waitForURL` instead of the URL assertion, so the spec waits for hydration
  (`html[data-hydrated]`) before clicking the menu. No retries, no timeouts changed.
- Join screen: the signed-in address sits on its own line and truncates instead of breaking mid-domain
  (`join-screen-*` screenshots retaken).
