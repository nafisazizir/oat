# UI overhaul — desktop renderer (ziiz)

status: in review
branch: devin/1795121467-ziiz-desktop

## Goal

Move `apps/desktop/src/renderer/**` onto ziiz ramp vocabulary, type roles, Tabler icons and registry components, and improve UX: optimistic updates with rollback, loading states that match the loaded layout, keyboard shortcuts. Excludes `packages/meeting-ui` (another session owns it) and the Swift sidecar.

## Acceptance criteria

- [x] No shadcn aliases, raw size/weight utilities or lucide icons left in the renderer; `lucide-react` removed from `@oat/desktop`.
- [x] Empty, AlertDialog, InputGroup, Field/Switch, Kbd, Spinner and Skeleton used in place of hand-built markup.
- [x] Optimistic workspace switch and recording-settings saves roll back on failure; unit test for `withActive`.
- [x] Loading skeletons for the note, conflict compare and setup permissions match the loaded layout.
- [x] Before/after light and dark screenshots in the PR.
- [ ] Desktop e2e green on a Mac (`pnpm --filter @oat/desktop e2e`). GitHub CI does not run it.

## Verification

`pnpm run ci --fast`: format, typecheck, lint and test pass. actionlint skipped because Docker Hub returned HTTP 429. Desktop e2e is macOS-only and needs the compose stack. GitHub CI's macOS job runs only the Swift sidecar, so it has not run yet. Screenshots come from the built renderer with a stubbed `window.oat` bridge.
