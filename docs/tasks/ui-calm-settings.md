# UI redesign PR 3 — calm settings

status: done
milestone: M9 · deps: ui-calm-shell · branch: devin/1795225960-calm-settings

## Goal
One quiet settings surface across web and desktop, with Account and Workspace navigation and an
approximately 640px content column. Inter headings and ziiz roles/ramps. Keep all existing behavior.

## Scope
Shared settings layout/navigation styles; web Preferences, Profile, Integrations, workspace General
and Members; native desktop Setup, Recording and Storage. Remove nested settings headers, tabs and
boxed lists/cards. Keep confirmations, permission gating, loading/errors, local audio retention and
integration behavior. No new billing/account deletion features or APIs where none exist.

## Acceptance
- [x] Narrow grouped navigation, one plain title per section, quiet rows and bottom danger actions.
- [x] Workspace/account selection clearly distinguished and settings links go to specific sections.
- [x] Web settings/workspaces/integrations/a11y e2e and desktop settings unit tests pass.
- [x] Fast CI passes locally; refreshed PR 2 also includes the main/PR CI fast-gate split (D-34).
- [x] Light/dark 1440×900 screenshots of all web settings sections and desktop settings in ~/shots/pr3/.

## Verification
PR 2 rebase confirmed at f8f60da: `pnpm run ci --fast` **ci: ok** (13.5s), log
`/home/ubuntu/shots/pr2/ci-fast-rebased.log`.

PR 3 local evidence under `/home/ubuntu/shots/pr3/`:
- `ci-fast-gate.log`: **ci: ok** (33.5s), all six steps green. Initial new unit assertion exposed a
  missing accessible-name space on browser buttons; explicit names fixed it.
- Rebased onto refreshed PR 2 `f6be005` with both LOG entries retained (not yet merged to main).
  Visual review caught the native sticky-nav offset drifting on the taller Storage panel; made
  that offset renderer-specific. `ci-fast-final-visual.log`: **ci: ok** (47.8s), including all 26 focused
  desktop settings/shell/URL unit tests. `capture-desktop-final.log`: six refreshed PNGs and axe scans,
  **0 violations**, with the native navigation alignment rechecked in both themes.
- `e2e.log`: settings, workspaces, calendar, Notion, pipeline, smoke, typography, a11y and
  enhance-versions: **24 passed, 2 failed**. A11y light hit a transient Next router-init error during
  concurrent source/HMR changes; enhance-versions still expected the account name in the sidebar.
  Updated that selector to the account section of the combined menu. No console-error suppression.
- `e2e-final.log`: focused rerun of enhance-versions and light/dark a11y: **4 passed (1.3m)** including
  auth setup. Every requested spec is green across these runs.
- `desktop-settings-tests.log`: settings-view, storage-format, shell and configured URL mapping:
  **4 files, 26 tests passed**. Normal, loading, empty, mutation, navigation, Escape/Back, and error
  states covered; hidden native sections stay mounted to retain pending/unsaved controls.
- `desktop-build.log`: built renderer **passed**, existing chunk-size advisory only.
- `capture-final.log`: built renderer axe **0 violations** in Preferences, Recording and Storage in
  both themes. `retake.log` settles workspace refresh before Preferences capture and moves the pointer
  off navigation for Storage. Twenty section/menu PNGs are 1440×900, reviewed in light/dark.

Screenshots (each `-light.png` / `-dark.png`): `web-preferences`, `web-profile`, `web-integrations`,
`web-workspace-personal`, `web-workspace-general`, `web-workspace-members`, `web-workspace-account`,
`desktop-settings-preferences`, `desktop-settings-recording`, `desktop-settings-storage`.

Desktop Profile/Integrations and workspace General/Members remain web-managed, with explicit browser
link affordances and a typed, allowlisted main-process URL resolver using configured `webUrl`. Browser
links use its signed-in account/active workspace, not an automatic desktop/browser session switch.
Desktop Preferences contains existing device permissions/setup; appearance still follows the OS.
No new billing, account-deletion or native workspace editing APIs were introduced. Web integrations
retain user Calendar plus workspace-scoped Notion/after-meeting settings, with scope named in content.
Native Electron/browser launch, macOS permissions/audio and desktop e2e were not verified on Linux;
screenshots and axe checks use a simulated bridge. PR 3 is based on refreshed PR 2 until that PR merges.
