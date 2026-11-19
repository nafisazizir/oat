# UI foundation — ziiz and oat palette

status: in_progress (PR 3 CI remediation)
branch: devin/1795115262-ziiz-foundation

## Goal

Replace the shared UI foundation with ziiz 0.1.1 and the supplied oat palette, without app-level restyling.

## Scope

Shared theme, self-hosted Inter and JetBrains Mono, registry components and hooks, mechanical Base UI consumer migrations, token and component tests. Excludes chart and carousel, app redesign, deployments and PR creation.

## Acceptance criteria

- [x] ziiz theme precedes the oat palette; the legacy shadcn bridge follows it.
- [x] All ziiz UI components except chart and carousel are available by package subpath.
- [x] Consumers compile and tests use the ziiz ramp vocabulary.
- [x] Fast CI, web build, desktop build and gallery build pass.
- [x] Light and dark palette screenshots captured.

## Verification

`pnpm run ci --fast`, `pnpm --filter @oat/web build`, `pnpm --filter @oat/desktop build`, `pnpm --filter @oat/ui gallery:build`. Full CI is attempted where Docker is available. Browser screenshots validate the final light and dark cascade.

## Design notes

- Registry source: local ziiz checkout, `apps/www/components/ui`, excluding chart/carousel; imports rewritten to relative package paths.
- Newsreader remains self-hosted because `packages/editor/src/styles.css` uses the serif in blockquotes. Instrument Sans removed.
- Legacy app-specific colours and editor sizing variables stay as compatibility mappings in styles.css until phase 2; the palette itself contains only the supplied ds variables.
- Base UI composition uses render, menu activation uses onClick, Select callbacks guard nullable values, ToggleGroup uses array values, and popup focus restoration uses finalFocus.
- The sidebar retains Oat's typing-safe Cmd/Ctrl+B behavior. Anchor-rendered buttons retain link semantics.
- Native select options use ramp utilities instead of the registry's arbitrary system-colour values. Popup sizing uses Base UI's anchor-width variable.

## Review

Diff reviewed against the requested foundation scope. All 61 registry files are present (63 upstream minus chart/carousel). After import/format normalization, only native-select (ramp vocabulary), pagination (link semantics) and sidebar (typing-safe shortcut) differ from upstream. No independent reviewer/verifier was run.

## Evidence

- Final `pnpm run ci --fast`:

  ```text
  step        status     time  note
  format      pass      10.3s
  actionlint  pass       0.2s
  typecheck   pass       7.5s
  lint        pass       7.4s
  test        pass      13.6s
  total                 39.0s

  ci: ok
  ```

- Web production build: `✓ Compiled successfully in 1964ms`; desktop renderer build: `✓ built in 861ms`; gallery build: `✓ built in 2.34s`.
- UI tests: `Test Files 3 passed (3)`, `Tests 82 passed (82)`. Fast CI reruns the package tests, typecheck, lint, format and actionlint.
- Full CI attempted: stack, migration and integration tests passed. Initial stale typecheck/test failures were fixed and superseded by the fast gate. Playwright Chromium was missing and installed locally; the editor browser suite then reported `16 passed (9.2s)`, `2 skipped`. Desktop browser tests report `27 skipped` on Linux.
- Web browser tests remain environment-blocked before the app starts: `PostgresError: could not open extension control file "/usr/share/postgresql/14/extension/vector.control": No such file or directory`. No database/schema or shared-service changes made to work around this. Full CI is not green.
- Screenshots visually reviewed: `/tmp/oat-shots/foundation-light.png`, `/tmp/oat-shots/foundation-dark.png`, `/tmp/oat-shots/foundation-palette-light.png`, `/tmp/oat-shots/foundation-palette-dark.png`.

## PR 3 CI remediation

- Text roles use readable ramp steps in both themes; Tabs activates on focus by default with an explicit opt-out. Review commits: `09fcd1d`, `0ec9b45`.
- With human approval, light gray-900 now lowers only L to 0.536 (same C/h), meeting AA on background-100, background-200 and gray-100. Gray-alpha-900 has no text consumers outside the palette. Contrast regression tests cover both themes.
- Sidebar actions have 24px boxes with compensating margins to retain icon placement. Select icons use explicit children rather than inheriting Base UI's default triangle text. Search checks aria-selected rather than Radix data-state.
- Tooltip Popup needed an explicit tooltip role. Sheet focus was not escaping: Base UI briefly focuses its sibling guard, then redirects on the next animation frame. The browser test now polls for redirected focus and checks both Tab directions, then tooltip visibility, Escape and return focus. No hand-written focus trap was added.
- DB pagination reproduced against main `61f1a2f` with controlled transaction horizons: the old readiness predicate returned true while the remaining page contained only `document, document`; releasing the held transaction made `folder` appear. Pending workspace rows made the count-based wait succeed prematurely. The test now settles its workspace boundary and waits for the specific inserted folder.
- Main's passing Linux job `135807577129` itself reports the identical enhance heading assertion as **1 flaky**. Main local enhance check passed once and three concurrent repeats passed; branch targeted suite also passed. The SSE service skips previews for finished runs; the E2E now warms that cold route before starting generation, retaining the heading and reload assertions. Cold compilation as the actual CI trigger remains unverified.
- Repository environment issue resolved for local checks: load the checkout's `.env` (compose Postgres on 54329), not the inherited system Postgres URL that lacks pgvector. No database/schema/configuration changes were needed.
- Local checks before the final enhance-only test edit: UI 90 passed; DB integration 51 passed, 1 skipped; targeted web E2E 15 passed, 1 skipped (assistant, both-theme axe, search, workspaces, enhance); fast CI format/actionlint/typecheck/lint/test all pass (`ci: ok`, 56.0s). The final enhance edit also passes web lint and its browser suite (`4 passed (44.5s)`). PR checks are pending.
- Computed palette: light background `oklch(0.982 0.002 84)`, dark background `oklch(0.198 0.0072 76)`, brand probe `oklch(0.48 0.0686 62)`, body font `Inter Variable`. Gallery menu opens with pointer input; no page errors. The existing theme initializer emits React's client-side script-tag warning.
- Persistent command logs: `/home/ubuntu/oat-foundation-ci-fast.log`, `/home/ubuntu/oat-foundation-ci-full.log`, `/home/ubuntu/oat-foundation-e2e.log`, `/home/ubuntu/oat-foundation-{web,desktop,gallery}-build.log`, `/home/ubuntu/oat-foundation-shots.log`.
