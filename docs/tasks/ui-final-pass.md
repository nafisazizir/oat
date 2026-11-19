# Ziiz final pass — part 1
status: done
branch: devin/1795126593-ziiz-final-pass

## Goal
Finish Home, Sonner and the shared UI gallery before removing the shadcn bridge in a later pass.

## Scope
Home and its loading state; Sonner; gallery; eligible UI Lucide dependency and lockfile. No changes to document routes, document/meeting/pipeline components, shared page components, editor or meeting-ui. Keep the bridge and catalog entry.

## Design notes
- Home uses Item links and an Empty call to action. Keep dates; drop redundant sharing metadata and sidebar instructions. Loading mirrors the header, streamed calendar and 5/4 recent-document rows.
- Gallery shows eleven ramps, all 31 roles and four floating materials. In-page specimens stay flat. Inter and JetBrains Mono replace stale font guidance.
- Upstream Sonner still uses shadcn slots; upstream Toast uses material-modal, background-100, gray-1000 and a transparent border. Apply that material with importance to beat Sonner's unlayered default shadow/radius.
- Keep the web Lucide dependency: excluded PR #5 files still import it. Remove only the UI dev dependency. Leave editor/catalog alone.

## Acceptance criteria
- [x] Home renders empty and populated states, links documents and propagates loader errors.
- [x] Gallery and Sonner no longer use shadcn color aliases or Lucide imports.
- [x] Gallery demonstrates all requested ramps and type roles.
- [x] Fast CI and gallery build pass; excluded paths and bridge are unchanged.

## Verification
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
