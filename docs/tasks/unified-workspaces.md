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
- [ ] No `kind` column, enum, type or "personal" special case remains (`grep` above returns only migrations,
      this file and docs).
- [ ] A user who existed before the migration keeps every document under the same workspace id; their former
      personal workspace is listed under its new name and can now invite members and be renamed.
- [ ] A brand-new user with no invite lands in an auto-created workspace as `owner`; signing up twice
      concurrently creates exactly one.
- [ ] Leaving or deleting your only workspace is refused (rule in `permissions.ts`, with deny tests); it works
      once you belong to a second one.
- [ ] Desktop: with a view-only workspace active, a new recording lands in a workspace where I can create; with
      none, the user is asked to create one and no recording is lost.
- [ ] Desktop upgrades an existing local store without re-download or data loss (migration test from a
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
- Order matters for sync: ship the server accepting clients that still send/expect `kind` for one desktop
  version (DTO field optional, ignored), then remove.

## Review

## Evidence
