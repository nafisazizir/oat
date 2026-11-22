# Phase 3a — Graphite visual hill-climb, round 2

status: done
milestone: M9 · branch: devin/1795313870-phase3a-visual-hillclimb

## Goal

Resolve round-one screenshot feedback across both apps without changing their functional contracts.

## Context

Follow-up to [round one](phase3a-visual-hillclimb.md). Reference: ziiz Claude showcase sidebar,
account menu, composer and settings. Retain existing workspace, recording, sharing and account actions.

## Scope

Shared presentation and host chrome only; no functional parity refactor, native OS verification or push.

## Acceptance criteria

- [x] Primary/tree icon and label columns align; section labels align to text; row actions are quiet.
- [x] Templates and Trash are full navigation rows; Settings is reachable in both shared menus.
- [x] Menus have a single truncated identity header, 256px width and compact grouped actions.
- [x] Desktop meeting actions use the shell toolbar, trash is in a menu, bottom controls align, bubbles are gray.
- [x] Home shares heading/container geometry; Coming up has one border, not nested cards.
- [x] Settings has reduced top space, no short vertical rule, and standard secondary Save controls.
- [x] Assistant empty history is inline without a card; related surfaces checked for the same issues.
- [x] Rebuilt desktop, round-two light/dark screenshots inspected, fast CI passes.

## Design notes

One 8px sidebar outer inset plus 8px row inset; 16px icons plus 8px gap place text at 40px.
Section labels use that same text column. Hierarchical children retain intentional depth indentation.
Header workspace trigger retains `workspace-switcher` and its workspace name/icon for existing E2E;
footer identity uses `account-switcher`. Both open equivalent grouped menus, with desktop-only utilities
retained. `open-trash`, Trash count/accessibility label and Templates link remain directly reachable.

Meeting share/menu actions portal into the existing toolbar. Recording controls remain functional;
the explanatory recording hint remains screen-reader text and a hover title, rather than a second row.
The desktop group retains its real recording/Transcript actions. Desktop MeetingView has no existing
contextual assistant action; adding that behavior belongs to the separate functional parity work,
rather than adding a nonfunctional Ask button in this presentation pass.
Home uses shared HomeLayout; note rows remain 44px and date section headings retain the same type role.

## Verification

- `pnpm --filter @oat/desktop exec electron-vite build`
- `bash /home/ubuntu/shots/run.sh /home/ubuntu/shots/r2`
- `pnpm run ci --fast`
- Focused existing web settings navigation and folder/trash E2E on isolated port/dist directory.

## Review

Checked `apps/web/e2e` workspace, settings, documents, join and authentication selectors. No E2E
expectations weakened or changed. Added assertions for gray transcript bubbles, unbordered empty
history, menu-based Settings and meeting Share in the shell header. Final diff self-review completed;
no functional refactors or E2E assertion changes. Native Electron/macOS remains unverified.

## Evidence

Logs and screenshots stay outside the repository under `/home/ubuntu/shots/`.

- Fast CI: `pnpm run ci --fast`, log `/home/ubuntu/shots/r2-ci-passing.log`:

  ```text
  format      pass      12.2s
  actionlint  pass       0.3s
  typecheck   pass       9.4s
  lint        pass       7.0s
  test        pass      13.3s
  total                 42.2s

  ci: ok
  ```

- Existing settings E2E with light/dark axe passed in `/home/ubuntu/shots/r2-e2e.log`.
  That first focused run had one folder save-status timeout; the trace showed its PATCH returned 200,
  but did not establish why the transient status was missed. The unchanged folder/trash test reran
  successfully, `2 passed (57.9s)` including auth setup, in `/home/ubuntu/shots/r2-e2e-folders.log`.
  No functional assertions or E2E files were changed. Isolated command prefix:
  `DATABASE_URL=postgres://oat:oat@localhost:54329/oat OAT_NEXT_DIST_DIR=.next-r2-e2e E2E_PORT=3104 E2E_WORKERS=1`.
- Final renderer build succeeded: `✓ built in 800ms`, with the existing large-chunk warning.
  Log: `/home/ubuntu/shots/r2-build-final.log`.
- Exact capture command: `bash /home/ubuntu/shots/run.sh /home/ubuntu/shots/r2`.
  Log `/home/ubuntu/shots/r2-capture-final.log` reports `RESULT 125 screenshots; 1 failed surfaces`
  and `RESULT 82 captures; 0 failures` (includes repeated and reference captures).
  The one failure was the light web account-menu screenshot: the scratch harness matched both the
  exiting workspace menu and newly opened account menu during animation. Added a wait for the old
  menu to unmount; independently re-captured both web account menus and exercised Settings:

  ```text
  PASS web light account menu and Settings navigation
  PASS web dark account menu and Settings navigation
  RESULT 2 captures; 0 failures
  ROUND 2: 120 screenshots; invalid dimensions: 0
  ```

  Recovery log: `/home/ubuntu/shots/r2-account-recheck.log`. No product change was needed.
- Visually inspected light/dark home/sidebar columns, menus, meeting header/transcript/bottom bar,
  settings and assistant, plus tasks/templates/search/trash/share/sign-in/not-found/public share.
  Representative screenshots under `/home/ubuntu/shots/r2/`:
  `web/light/home.png`, `web/dark/account-menu.png`, `desktop/light/account-menu.png`,
  `desktop/dark/meeting-transcript.png`, `desktop/light/home.png`,
  `web/light/settings-profile.png`, `desktop/dark/settings-profile.png`,
  `web/dark/assistant.png`, `desktop/light/assistant.png`.

Servers remain running on 3000/3001/3002. Screenshot scripts, fixture sessions, logs and images stay
outside the committed diff. Desktop captures use a stubbed Chromium bridge, not native Electron.
