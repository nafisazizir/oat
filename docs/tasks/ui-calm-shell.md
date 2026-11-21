# UI redesign PR 2 — calm shell

status: done
milestone: M9 · deps: ui-type-geist-mono · branch: devin/1795224212-calm-shell

## Goal
Quiet web and desktop chrome following the clean-room Shell research in
`research/granola/ui-design.md`. No page/editor redesign or recording changes.

## Scope and design
Web: borderless sticky header with sidebar toggle, outlined New note pill and a contextual
`TopBarActions` portal target for future page actions. Sidebar starts with Search/⌘K then main nav;
existing trees stay. Footer has Templates, Trash/count dot, Settings and Theme icon controls, stacked
when collapsed; workspace and account actions share one bottom menu.

Desktop: preserve app drag regions, Mac traffic-light insets and toolbar portal. Move the existing
New meeting note behavior into the main header. Search pill and existing Upcoming/meetings remain;
footer has Settings and tooltip sync status, then combined workspace/account actions. Workspace loading
does not hide account actions. Keep existing errors, recording disabled/pending and keyboard behavior.

## Acceptance criteria
- [x] Header has no breadcrumbs, search/theme controls or hairline; new-note controls retain behavior.
- [x] Footer controls are labelled, at least 24px, and work expanded/collapsed in both themes.
- [x] Workspace selection, account actions, trash, templates, settings and search still work.
- [x] Fast CI, relevant web e2e and desktop shell unit tests pass.
- [x] 1440×900 light/dark screenshots for web Home/document, desktop home/meeting, collapsed sidebars.

## Verification
`pnpm run ci --fast`; web Playwright smoke/auth/documents/workspaces/templates/tasks/a11y specs;
desktop `shell.test.tsx` (included in CI); desktop renderer build. Evidence under
`/home/ubuntu/shots/pr2/`. Native Electron/audio is not exercised by the simulated screenshot bridge.

## Review and evidence
Based on updated PR 1 commit **48b4708**: all headings stay Inter; no Settings page redesign.
The combined bottom menu labels Workspaces and Account separately. Origin/main does not yet contain
48b4708 (fetched at verification); rebase onto main once PR 1 merges.

- Fast CI: **ci: ok**, 34.6s (format 12.4s, actionlint 0.3s, typecheck 7.4s, lint 8.9s, test 5.6s).
  Log: `/home/ubuntu/shots/pr2/ci-fast-verified.log`.
- Web Playwright smoke/auth/documents/workspaces/templates/tasks/search/a11y/calm-shell:
  **39 passed (2.3m), 2 skipped** (existing screenshot-only search/template cases).
  Log: `/home/ubuntu/shots/pr2/e2e-verified.log`. Includes workspace settings, trash/restore/delete,
  command palette, routes, theme, collapsed sidebar and light/dark axe scans.
- Final calm-shell rerun after removing a TypeScript-invalid tooltip prop:
  **3 passed (31.5s)** including auth setup. Log: `/home/ubuntu/shots/pr2/calm-shell-final.log`.
- Desktop shell unit: **1 file passed, 10 tests passed (3.73s)**. Includes pending/error/shortcut,
  account error, loading-workspace account access and header/footer placement.
  Log: `/home/ubuntu/shots/pr2/desktop-shell-final.log`.
- Desktop build: **built in 646ms** (renderer); existing >500kB chunk advisory.
  Log: `/home/ubuntu/shots/pr2/desktop-build-inter.log`.
- Built desktop renderer with simulated bridge: both themes, expanded/collapsed,
  **axe 0 violations**, targets >=24px, Tab order/focus halo, borderless header/drag region.
  Log/script: `/home/ubuntu/shots/pr2/desktop-shell-a11y-final.log` and `desktop-shell-a11y.mjs`.
- Final screenshots (1440×900), visually reviewed in both themes:
  `/home/ubuntu/shots/pr2/{web-home,web-document,web-collapsed,desktop-home,desktop-meeting,desktop-collapsed}-{light,dark}.png`.
  Also `{web,desktop}-workspace-account-{light,dark}.png` show distinct menu sections.
  Capture script/log: `/home/ubuntu/shots/pr2/capture.mjs`, `capture-final.log`.
- Review: no stock palette, raw type overrides, control shadows or dark color overrides added;
  native link semantics preserved on icon links; removed only obsolete breadcrumb tests, retained tree
  helper coverage. Initial checks caught/fixed stale user/trash selectors, link-role composition and an
  unsupported tooltip prop; no CI/build/test timeouts changed.
- Limitations: renderer screenshots/axe use a simulated bridge on Linux, not native Electron, audio,
  macOS traffic lights or drag behavior. Mac padding and toolbar portal retained in source.
  No PR opened.
