# UI foundation — ziiz and oat palette

status: done
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
- Computed palette: light background `oklch(0.982 0.002 84)`, dark background `oklch(0.198 0.0072 76)`, brand probe `oklch(0.48 0.0686 62)`, body font `Inter Variable`. Gallery menu opens with pointer input; no page errors. The existing theme initializer emits React's client-side script-tag warning.
- Persistent command logs: `/home/ubuntu/oat-foundation-ci-fast.log`, `/home/ubuntu/oat-foundation-ci-full.log`, `/home/ubuntu/oat-foundation-e2e.log`, `/home/ubuntu/oat-foundation-{web,desktop,gallery}-build.log`, `/home/ubuntu/oat-foundation-shots.log`.
