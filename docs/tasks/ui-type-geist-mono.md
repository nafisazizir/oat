# UI redesign PR 1 — typography

status: done
milestone: M9 · deps: ui-final-pass · branch: devin/1795223782-type-geist-mono

## Goal
Use self-hosted Geist Mono and regular Newsreader display titles across web and desktop, retaining
Inter body/UI typography and ziiz metrics. Direction and clean-room research are recorded in D-33.

## Scope
Font dependencies, shared roles/gallery/tests, page/document titles, notices and typography docs.
No layout redesign, native capture changes or PR creation.

## Acceptance criteria
- [x] Mono uses bundled Geist Mono; no old mono font dependency or references remain.
- [x] Page/document titles use regular Newsreader; editor body remains Inter in both themes.
- [x] Fast CI and relevant web Playwright specs pass.
- [x] Web document/home and built desktop meeting screenshots captured at 1440×900.

## Verification
`pnpm run ci --fast`; web `typography.spec.ts`, `documents.spec.ts`, `meeting.spec.ts`.
Playwright computed-style checks for family/weight, empty title, and not-found heading; visual checks
on populated web and built desktop renderer with the existing screenshot bridge fixture.

## Design notes
Shared `text-display-{14,20,24,32}` roles compose matching ziiz metrics and own regular serif typography.
No component overrides ziiz roles with raw size or weight utilities.

## Evidence
- `pnpm --filter @oat/web exec playwright test typography.spec.ts documents.spec.ts meeting.spec.ts`
  with local `DATABASE_URL`, `OAT_NEXT_DIST_DIR=.next-pr1-e2e`, `E2E_PORT=3108`: **13 passed (1.8m)**.
  An initial launch on the default dist dir collided with the running screenshot server; using the
  existing documented dist-dir override isolated both servers. No app/config edits needed.
- `pnpm --filter @oat/desktop build`: successful; Vite's >500 kB chunk advisory only.
- Captured and inspected `/home/ubuntu/shots/pr1/{web-home,web-document,desktop-meeting-transcript}.png`
  and matching `-dark.png` variants at 1440×900. Computed styles assert Newsreader/400 and Inter body;
  browser tests also check Geist Mono and font readiness. Desktop bridge is simulated, no native/audio
  verification. Screenshot script and output: `/home/ubuntu/shots/pr1/capture.{mjs,log}`.
- First `pnpm run ci --fast` passed format/actionlint/typecheck/lint; test gate hit the unchanged
  Markdown property test's 5000 ms timeout under concurrent e2e load (5658 ms elapsed). Final serial
  run passed all five gates (**ci: ok**, 33.1s); no editor test, timeout or CI changes. Logs:
  `/home/ubuntu/shots/pr1/ci-fast{,-final}.log`. Shared UI tests: **112 passed**, six files.
- Review retained existing 20px metrics on error/empty/signing-in titles (rather than increasing them
  to 24px). Relevant typography spec rerun: **3 passed**, including auth setup; desktop rebuilt.
- React/ziiz review: class-only product changes, no hook/state/event changes or new dependencies beyond
  the font swap; display roles own family/weight and preserve heading metrics. Source vocabulary tests
  pass. No editor-body, native capture, permissions or bridge changes.
