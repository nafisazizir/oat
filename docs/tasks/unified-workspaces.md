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
- [ ] `invite_only` workspace is never shown to a matching-domain stranger; `request` shows "Request access";
      `auto_join` joins as `member` — each covered by an e2e and an integration test.
- [ ] Unverified email, public mailbox domain, or a domain other than the admin's own: denied (unit deny tests).
- [ ] Approve creates the membership with the chosen role; decline does not; both notify the requester; a
      declined user can't spam (one pending request per user per workspace).
- [ ] Only owner/admin can see or decide requests and edit policy/domains.
Step C
- [ ] Sidebar shows Private and Shared sections on web and desktop; a note moves between them when its
      visibility changes, without reload; another member never sees my Private items (e2e with two users).
- [ ] Switcher is absent with one workspace and present with two.
- [ ] Export downloads a zip containing only my documents; after leaving, I can no longer read any of them.
- [ ] axe: 0 violations on the join screen, join settings, requests list and sidebar, light and dark.

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

## Evidence
