# Phase 3a — Graphite visual hill-climb, round 1

status: done
milestone: M9 · branch: devin/1795313870-phase3a-visual-hillclimb

## Goal

Make web and desktop renderer feel like one polished Oat application using the ziiz Graphite theme and
the ziiz Claude showcase's sidebar, composer, settings and compact controls.

## Scope

In: presentational shared UI, shell chrome, metadata, assistant, settings, home and menus.
Out: functional parity refactors, native macOS behavior, production systems, feature removal.

## Acceptance criteria

- [x] Shared sidebar header, New note/Search/Home/Tasks/Assistant ordering, compact sections and account footer.
- [x] Shared 48px top bar; new-note action in the sidebar on both hosts; meeting actions use small controls.
- [x] Metadata uses consistent secondary surfaces and heights; inactive expanded folders are not highlighted.
- [x] Assistant has a multiline secondary composer, bottom toolbar, secondary suggestions and conversation empty state.
- [x] Settings use divided rows, consistent control columns, compact grouped navigation and secondary fields.
- [x] Home empty states, Coming up surface, palette density and share-link control reviewed against reference.
- [x] Desktop rebuilt; light/dark round-one screenshots inspected.
- [x] `pnpm run ci --fast` passes; evidence below.

## Design notes

Reference: `/home/ubuntu/repos/ziiz/apps/www/components/claude-ai/` (sidebar, shell, page-header, settings-dialog,
home, composer). Existing ziiz control sources already provide secondary inputs, default radii and Graphite
ramps; reuse them rather than introduce a second component family. The sidebar uses the showcase's
293px width, 32px navigation rows and toggle/workspace header. Templates, trash and settings remain
identical utility navigation; the footer contains one account row and the theme control. Desktop sync
status moves into the account menu in neutral ramp ink, retaining offline/error information.

The expanded-folder highlight came from the sidebar primitive treating the tree disclosure's
`aria-expanded=true` as an open action-menu state. Only actual popup-open actions should hold that
background. Disclosure state continues to control the child rows, not the parent selection styling.

Composer retains existing transport, submission, cancellation and suggestion behavior. The toolbar
adds a working clear-draft action rather than fake attachment or microphone controls that Oat cannot use.
Greeting already uses the showcase's heading-32 role. Existing settings inputs are secondary by default.

Web retains its existing create-permission guard; desktop retains its recording/pending guards and
real Command-N shortcut. Web does not advertise Command-N, which it did not previously implement.
Settings section headings use the reference's heading-16 role. Desktop note skeletons reserve the
same 16px section heading, 8px heading gap and contiguous 44px rows as the populated list.

## Verification

1. `cd apps/desktop && pnpm exec electron-vite build`
2. `bash /home/ubuntu/shots/run.sh /home/ubuntu/shots/r1`
3. Inspect web/desktop light/dark sidebar, meeting, settings, assistant and dialogs.
4. `pnpm run ci --fast` (format, actionlint, typecheck, lint, unit tests).

## Review

Implementation diff self-reviewed against the six requested surfaces. Screenshot review caught the
sidebar width being applied to the fixed sidebar but not the layout provider; both hosts now use
ShellSidebarProvider to reserve the full 293px. Review also corrected loading-row spacing and preserved
the web create-permission guard. Desktop portal assertions now await the opened account menu.
Native Electron/macOS behavior is outside this Chromium renderer pass. Functional parity audit is owned
by another session. No functional refactors or feature removals.

## Evidence

Baseline: `/home/ubuntu/shots/before/{web,desktop}/{light,dark}/`.
Reference: `/home/ubuntu/shots/ref/{light,dark}/`.
Reusable capture harness remains outside the repository under `/home/ubuntu/shots/`.
Round one: `/home/ubuntu/shots/r1/{web,desktop}/{light,dark}/`.

- Desktop build: `pnpm exec electron-vite build` succeeded (`✓ built in 850ms` for the renderer);
  existing large-chunk warning remains. Log: `/home/ubuntu/shots/r1-build-final.log`.
- Exact capture command: `bash /home/ubuntu/shots/run.sh /home/ubuntu/shots/r1`.
  Capture results: `RESULT 122 screenshots; 0 failed surfaces` and
  `RESULT 80 captures; 0 failures` (includes supplemental/reference captures and repeated surfaces).
  Log: `/home/ubuntu/shots/r1-capture-final.log`.
- Inspected light/dark web and desktop sidebar/home, assistant, settings, meeting, share dialog,
  account menu and command palette. Representative evidence:
  `web/light/meeting.png`, `web/dark/assistant.png`, `web/light/settings-profile.png`,
  `web/light/share-dialog.png`, `web/dark/command-palette.png`,
  `desktop/light/home.png`, `desktop/dark/assistant.png`,
  `desktop/light/settings-profile.png`, `desktop/light/workspace-menu.png`.
- Focused desktop shell tests: `Test Files  1 passed (1)` / `Tests  24 passed (24)`.
- `pnpm run ci --fast`: format, actionlint, typecheck, lint, test all pass; `ci: ok`.
  All 24 package test tasks successful. Log: `/home/ubuntu/shots/r1-ci-passing.log`.

Servers remain running at ports 3000 (web), 3001 (built renderer), 3002 (ziiz reference).
Screenshot harness, fixtures and session data remain outside the repository. Desktop bridge is stubbed;
native recording, permissions, playback and OS integration are not verified by these screenshots.
