# UI redesign PR 1 — Geist Mono
status: done
milestone: M9 · deps: ui-final-pass · branch: devin/1795223782-type-geist-mono

## Goal
Self-host Geist Mono for all mono roles. Headings and editor/UI body stay Inter. Per human feedback,
the initial Newsreader display-title experiment is reverted. D-33 records the revised decision and
clean-room calm-layout direction in `research/granola/ui-design.md`.

## Scope
Mono dependency, gallery/tests, notices and typography docs. No new title roles or layout changes.
Newsreader stays bundled solely for its existing editor blockquotes.

## Acceptance criteria
- [x] Mono uses bundled Geist Mono; no old mono dependency or references remain.
- [x] No display-serif roles or usages; page titles retain their previous Inter heading roles.
- [x] Fast CI and relevant typography e2e pass after the feedback revision.

## Verification
`pnpm run ci --fast`; web `typography.spec.ts` checks Inter titles/body in both themes, empty titles,
the missing-document heading and Geist Mono. Initial documents/meetings e2e had 13 passing tests.

## Evidence
Original pre-feedback screenshots and check logs are at `/home/ubuntu/shots/pr1/`; they show the
superseded serif experiment, not the final approved direction. Revised evidence under
`/home/ubuntu/shots/pr1-feedback/`: fast CI **ci: ok** (52.1s); revised typography E2E **3 passed**
(including auth setup). Product title files are identical to origin/main before PR 1.
No native/audio changes. No PR created by this agent.
