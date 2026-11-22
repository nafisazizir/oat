# C1 — Native settings parity
status: review
milestone: M9 · deps: API and Graphite foundations · branch: devin/1795304453-settings-parity

## Goal
Use one settings UI in web and desktop; editing settings must not require opening the web app.

## Context
D-28 (desktop local notes), D-33 (type), D-37 (Graphite), D-38 (REST client and desktop transport).

## Scope
Account, preferences, integrations and workspace settings; retain desktop-only hardware panels.
Provider consent can use the system browser; a ZIP export uses a file-specific desktop bridge.

## Acceptance criteria
- [x] The five web settings URLs remain directly navigable and show the same panels as desktop.
- [x] Desktop supports native settings navigation, Back/Escape, provider consent and ZIP export.
- [x] Shared settings load and save through the typed client and retain the model's permission rules.
- [x] Graphite/ziiz settings pass the settings accessibility sweep and have light/dark evidence.

## Verification
`pnpm run ci --fast`, web settings, calendar, Notion, pipeline and workspace Playwright specs,
and a built desktop renderer capture with a stubbed bridge on Linux.

## Design notes
Search and grouped links at left; compact labeled rows and value controls at right. Platform adapters
own navigation, consent and file saves; shared components own queries, controls and feedback.

`@oat/settings-ui` exports shared sections, navigation, panels and theme controls. Desktop's main
process implements `settings:connect` and `settings:export-notes`; the latter streams the workspace's
own-note export to a user-selected file, not through the renderer text proxy. Provider consent opens a
single-use browser URL and the shared Integrations panel reloads when the app comes back into focus.
No new decision entry.

## Review
Independent review pending.

## Evidence
- `pnpm run ci --fast`: `ci: ok` (format, actionlint, typecheck, lint and unit tests).
- Web Playwright: `9 passed` (settings with axe light/dark, Google Calendar, Notion, pipeline and workspaces).
- Adjacent web Playwright: `7 passed` (calm shell light/dark and desktop sign-in).
- Web authorization integration: `Tests 130 passed (130)`.
- Shared settings unit tests: `Tests 12 passed (12)`; desktop: `Tests 495 passed (495)`.
- Built desktop renderer and captured with a stub bridge: all eight panels in light and dark. Web:
  all five panels in light and dark. PNGs: `/home/ubuntu/screens/settings/`.
- Mock Notion and Google Calendar completed the desktop browser handoff without browser login,
  returned connected status to the bearer-authenticated API, and rejected replaying each launch ticket.
- Actual macOS Electron e2e was not run on this Linux host.
