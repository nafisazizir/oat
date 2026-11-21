# UI redesign PR 5 — calm auth, setup and dialogs

status: done
milestone: M9 · deps: ui-calm-note-surfaces · branch: devin/1795229369-calm-auth-dialogs

## Goal
Finish the calm UI series with narrow unboxed auth/setup and quiet consistent dialogs on web and
desktop. Keep Inter, Geist Mono, ziiz ramps/materials, Oat identity and all behavior/accessibility.

## Context and scope
D-33; research/granola/ui-design.md (layout descriptions only). Passwordless auth has sign-in,
first-sign-in account creation and email-link verification, not separate signup/password-reset routes.
Web workspace setup is create/invite, not a separate onboarding wizard. No new auth or permission APIs.
Keep desktop handoff security warning, account identity, permission guidance, test recording, skip,
back/reopen flows, testids, keyboard focus, destructive confirmations and async error states.

## Acceptance criteria
- [x] Web and native auth have one ~360px column, small Oat mark, no card, one primary action.
- [x] Verification/invitation/error states use the same hierarchy with concise copy.
- [x] Desktop setup is one step per screen, quiet step navigation, no boxed panels, one primary action.
- [x] Create/invite/share/search/confirm dialogs have consistent plain headers and ghost cancels;
      destructive styling only for destructive confirms. Immediate-save sharing keeps Done, not a
      misleading cancel/undo action.
- [x] Required behavior/accessibility checks, desktop tests and renderer build pass.
- [x] 1440×900 light/dark screenshots in ~/shots/pr5/ are visually reviewed.

## Design notes
Plain canvas → small mark → plain Inter title → form/body → primary action → muted secondary actions.
Shared auth primitives remove card chrome without changing semantics; dialog materials remain valid
surfaces (not control shadows). Setup navigation stays reachable and skips stay optional. Keep safety
copy even where it needs more than one short line.

## Verification
`pnpm run ci --fast`; web auth/workspaces/sharing/a11y/typography/search relevant Playwright specs;
desktop unit tests; `pnpm --filter @oat/desktop build`; focused auth/setup/dialog interaction and axe
checks with 1440×900 light/dark screenshots. Linux native screenshots use a simulated bridge, not real
macOS permission prompts or audio.

## Review
- Shared auth layout replaces boxed cards without changing the auth/session/redirect machinery.
  Magic-link sent state now has one h1, not an extra heading below the form title. Keep Google OAuth,
  passwordless signup, desktop handoff safety copy and dev-only fallback. See D-35.
- Preserve permission requests, System Settings, optional skip/back, heading focus, setup reopening,
  calendar choices and test recording. Loading and bridge-error regressions are included. Calendar
  permission/provider combinations are tested for exactly one primary action.
- Visual review caught squeezed calendar labels at 360px; controls now stack below the full-width
  labels. Re-rendered both themes and reviewed the corrected screenshots.
- Axe caught a decorative command separator exposed inside a listbox. Hide that separator from AT;
  a new empty-query palette regression checks the actual dialog with axe and Escape dismissal.
- Share options are borderless; Done remains an affirmative completion action because changes save
  immediately. Confirmation cancels are ghost; only destructive confirmations are destructive.

## Evidence
Base: fresh origin/main `015561c`; branch `devin/1795229369-calm-auth-dialogs`.

Final `pnpm run ci --fast` (`~/shots/pr5/ci-fast-release.log`):
```text
step        status     time  note
format      pass      10.9s
actionlint  pass       0.3s
typecheck   pass       9.1s
lint        pass       5.2s
test        pass      12.9s
total                 38.4s

ci: ok
```
Desktop tests in that gate:
```text
Test Files  55 passed (55)
Tests       425 passed (425)
```
Final renderer `pnpm --filter @oat/desktop build` (`renderer-build-final.log`):
```text
✓ built in 745ms
```
Existing >500kB chunk advisory only. Earlier runs caught test-only typing issues; corrected the bridge
error's constructor and lowercase code. An editor property-test timeout under concurrent browser load
did not recur in the isolated final gates; no editor tests/timeouts were changed.

Web Playwright (prefix commands with `DATABASE_URL=postgres://oat:oat@localhost:54329/oat`; run from
the repo root with `pnpm --filter @oat/web exec playwright test`):
- Auth, workspaces, sharing, a11y, calm-auth, search and extra typography specs (`web-e2e-first.log`):
  **20 passed (1.8m), 1 skipped, 2 failed**. Both failures are the extra typography spec expecting
  weight 450 on the sr-only Home h1, which inherits 400. Home, typography spec and shared styles are
  unchanged from origin/main; main already has `<h1 className="sr-only">Home</h1>`. This unrelated
  mismatch was initially left untouched; the follow-up below corrects the stale spec. Required
  auth/workspace/sharing/a11y cases passed.
- Desktop-sign-in, templates and enhance-versions (`web-e2e-additional.log`):
  **8 passed (1.3m), 1 skipped**.
- After final sharing/palette edits, sharing and search with
  `OAT_NEXT_DIST_DIR=.next-pr5-e2e E2E_PORT=3105` (`web-e2e-visual-fixes.log`):
  **7 passed (51.7s), 1 skipped**, including the new palette axe regression. Skips are existing
  evidence-only cases. Existing Next development script-tag warnings remain; assertions were not
  suppressed.

### Screenshots
Personally reviewed 36 PNGs at 1440×900 under `/home/ubuntu/shots/pr5/`, including enlarged individual
states and all four `review-{web,desktop}-{light,dark}.jpg` sheets. Each prefix below has `-light.png`
and `-dark.png`:
- Web: `web-sign-in`, `web-check-email`, `web-verify`, `web-auth-error`, `web-create-workspace`,
  `web-invite`, `web-join-workspace`, `web-delete-confirm`, `web-share`, `web-command`.
- Desktop: `desktop-sign-in`, `desktop-signing-in`, `desktop-setup-microphone`,
  `desktop-setup-system-audio`, `desktop-setup-calendar`, `desktop-setup-test`,
  `desktop-setup-blocked`, `desktop-search-empty`.

All captured states have axe **0 violations** (WCAG 2 A/AA, 2.1 AA, 2.2 AA). Runtime checks exercise auth
keyboard order, button focus halo/ringless fields; desktop simulated sign-in/cancel, permission allow,
skip/back, step heading focus, test start/stop and setup completion. Evidence scripts and logs:
`capture.mjs`, `visual-capture.log`, `visual-capture-final.log`, `calendar-visual-fix.log`,
`review-sheets.mjs` in that directory. Python Pillow is not installed in the VM; review sheets use
Next's existing Sharp dependency instead, without changing project dependencies.

### Limitations
Desktop screenshots exercise the built renderer with a simulated bridge on Linux, not native
Electron, macOS permission prompts, real browser launch or real microphone/system-audio capture.
Google/calendar providers and email delivery use local/mocked services, not real integrations.
No separate signup/reset routes or web onboarding wizard were invented. Browser desktop-handoff
behavior is covered by e2e, not a separate screenshot.

## Follow-up — visible Home typography coverage
The display-weight assertion was wrong for Home's sr-only h1 after PR4 removed the visible page
heading. Keep that accessibility heading unstyled; do not add display weight just to satisfy a test.
The spec now seeds a note and checks its visible Home row title for Inter at body weight 400. Visible
document/meeting/settings/not-found titles still require Inter at heading weight 450, with explicit
visibility assertions; editor body and Geist Mono checks remain intact. No product UI changed.

```sh
DATABASE_URL=postgres://oat:oat@localhost:54329/oat OAT_NEXT_DIST_DIR=.next-pr5-e2e E2E_PORT=3105 pnpm --filter @oat/web exec playwright test e2e/typography.spec.ts
```
```text
3 passed (56.9s)
```
Includes setup and both themes. Log: `~/shots/pr5/typography-fix.log`.
Follow-up gate: `pnpm run ci --fast`; log: `~/shots/pr5/ci-fast-typography-fix.log`.
