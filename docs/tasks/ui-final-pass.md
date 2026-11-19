# Ziiz final pass
status: done
branch: devin/1795126593-ziiz-final-pass

## Goal
Finish Home, Sonner and the shared UI gallery, then remove the shadcn bridge repo-wide after merging the document/meeting migration.

## Part 1 scope
Home and its loading state; Sonner; gallery; eligible UI Lucide dependency and lockfile. No changes to document routes, document/meeting/pipeline components, shared page components, editor or meeting-ui. Keep the bridge and catalog entry.

## Design notes
- Home uses Item links and an Empty call to action. Keep dates; drop redundant sharing metadata and sidebar instructions. Loading mirrors the header, streamed calendar and 5/4 recent-document rows.
- Gallery shows eleven ramps, all 31 roles and four floating materials. In-page specimens stay flat. Inter and JetBrains Mono replace stale font guidance.
- Upstream Sonner still uses shadcn slots; upstream Toast uses material-modal, background-100, gray-1000 and a transparent border. Apply that material with importance to beat Sonner's unlayered default shadow/radius.
- Keep the web Lucide dependency: excluded PR #5 files still import it. Remove only the UI dev dependency. Leave editor/catalog alone.

## Part 1 acceptance criteria
- [x] Home renders empty and populated states, links documents and propagates loader errors.
- [x] Gallery and Sonner no longer use shadcn color aliases or Lucide imports.
- [x] Gallery demonstrates all requested ramps and type roles.
- [x] Fast CI and gallery build pass; excluded paths and bridge are unchanged.

## Part 1 verification
- `pnpm run ci --fast`
- `pnpm --filter @oat/ui gallery:build` (existing equivalent of build:gallery)
- Render the gallery in light/dark, including the floating toast; Home itself remains visually unverified.

## Evidence
- Fast CI: format, actionlint, typecheck, lint and tests passed (`ci: ok`). The first attempt exposed stale workspace dependency links after updating main; an offline frozen install restored the already-declared Tabler dependencies without manifest changes.
- New tests: Home 3; gallery 2; Sonner 1, all passing.
- `pnpm --filter @oat/ui gallery:build`: `✓ built in 717ms`. Vite retains its non-blocking large-chunk warning.
- Gallery light/dark and floating toast visually checked. Toast uses background-100, a transparent border and the modal shadow in both themes. Type samples compute to 72px and 13px for Heading 72 and Copy 13 Mono.
- Screenshots: `/home/ubuntu/oat-final-pass-ramps-light.png`, `/home/ubuntu/oat-final-pass-ramps-dark.png`, `/home/ubuntu/oat-final-pass-toast-light.png`, `/home/ubuntu/oat-final-pass-toast-dark.png`.
- Home is covered by server-render tests, not a visual check. Full integration/E2E and an independent review were not run in this part.

## Part 2 — remove the bridge after PR #5

- Merged origin/main (PR #5, c697c97), retaining both LOG histories. The merged editor stylesheet, meeting-ui, document routes and registry already use ramps; the remaining runtime bridge consumers were in the editor playground.
- Migrate playground colors/type roles and merge-utility fixtures. Remove the bridge import and unused destructive slot definitions/mapping. Keep the remaining domain tokens, which do not come from the bridge.
- Remove the last web Lucide dependency and catalog entry; editor and meeting-ui already dropped theirs in PR #5. Regenerate the lockfile and refresh workspace links offline.
- Add a repository-wide source guard covering app/package src, registry, gallery and playground. It rejects all 31 exact bridge aliases (including variable/shorthand/color-namespace forms), raw typography outside registry, and Lucide source/manifests/catalog. Tests cover every alias and distinguish ramp/layout names.
- Add opt-in, targeted Home/document/settings light/dark screenshot coverage (`foundation-surfaces.spec.ts`).

### Part 2 verification
- `pnpm run ci --fast`
- `pnpm --filter @oat/web build`
- `pnpm --filter @oat/desktop build`
- `pnpm --filter @oat/ui gallery:build`
- Scan emitted web, desktop renderer and gallery CSS for exact bridge-variable references.
- Web Playwright a11y, smoke and foundation-surfaces specs against the healthy local compose stack. Use `env -u DATABASE_URL` so the VM's unrelated shell URL cannot override the local test harness.
- Eyeball all six screenshots for missing surfaces/typography after bridge removal.

### Part 2 evidence

- Merge commit `739bacf` incorporates PR #5 (`c697c97`); the only conflict was LOG.md, resolved by retaining both entries.
- Source re-audit: no runtime bridge aliases, remaining Lucide imports/dependencies/catalog/lock entries, or targeted raw typography outside registry components. Editor CSS and meeting-ui were already migrated by PR #5. Negative assertions/test fixtures are excluded from the source guard; generated output is checked separately.
- Fast CI passed all five gates, including the new 14-case source-vocabulary suite:

```text
step        status     time  note
format      pass      10.4s
actionlint  pass       0.3s
typecheck   pass      16.2s
lint        pass       4.7s
test        pass      24.8s
total                 56.4s

ci: ok
```

- Web production build: `✓ Compiled successfully in 5.9s`; TypeScript finished in 17.2s; all 42 static pages generated. Desktop main/preload/renderer builds completed (362ms/43ms/952ms); gallery build completed in 937ms. Desktop/gallery retain their non-blocking large-chunk warning.
- Emitted CSS audit (all production CSS files in `.next/static`, `out/renderer`, and `gallery/dist`):

```text
web: 1 built CSS files; 0 bridge-variable references
desktop: 1 built CSS files; 0 bridge-variable references
gallery: 1 built CSS files; 0 bridge-variable references
```

- Each artifact also has zero references to removed local destructive slots and zero missing `--ds-*` ramp definitions.
- Healthy compose stack already available (including pgvector); no image pulls/replacements needed. Ran `env -u DATABASE_URL -u OAT_DATABASE_ADMIN_URL E2E_PORT=3119 E2E_WORKERS=2 E2E_TIMEOUT_SCALE=2 E2E_SCREENSHOTS=1 E2E_SWEEP_DIR=/home/ubuntu/oat-final-pass-2-shots pnpm --filter @oat/web exec playwright test a11y smoke foundation-surfaces`: **17 passed (2.2m)**, including light/dark axe scans and both screenshot cases. Console errors from intentional error-boundary probes are expected.
- Eyeballed Home, populated document and Settings in both themes: surfaces, borders, controls and typography render correctly, with no broken/unstyled surfaces. Screenshots:
  - `/home/ubuntu/oat-final-pass-2-shots/bridge-home-light.png`
  - `/home/ubuntu/oat-final-pass-2-shots/bridge-home-dark.png`
  - `/home/ubuntu/oat-final-pass-2-shots/bridge-document-light.png`
  - `/home/ubuntu/oat-final-pass-2-shots/bridge-document-dark.png`
  - `/home/ubuntu/oat-final-pass-2-shots/bridge-settings-light.png`
  - `/home/ubuntu/oat-final-pass-2-shots/bridge-settings-dark.png`
- Nothing remains unmigrated within the requested bridge/Lucide/raw-type scope. Full integration/E2E beyond the requested web specs and an independent reviewer were not run.
