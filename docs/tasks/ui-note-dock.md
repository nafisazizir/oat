# Floating meeting note dock

status: verify

branch: `devin/1795541973-note-floating-dock`

## Goal

Try a layout that brings meeting recording, transcript and Ask together over the note without replacing Oat’s visual style.

## Scope

Web and desktop meeting notes. Recording, playback, chat, citations and proposal handling keep their current data paths. No new audio device picker, language settings or assistant backend.

## Design

The compact capture controls sit left of Ask near the bottom of the note. A transcript sheet opens above them, with search, copy and collapse. Ask expands to suggested prompts and the note’s chat; existing threads can also open in the full Assistant. Use Oat components, tokenized surfaces, default control radii and a small live dot.

## Acceptance criteria

- Capture baseline and dock states in the built desktop renderer with a mock bridge.
- In both apps, the transcript collapses, searches and copies without changing stored lines or citation handling.
- Opening the dock assistant shows note-scoped suggestions and history without persisting side-panel state.
- The dock leaves room to scroll the end of the note above its open sheet.

## Verification

- Run `pnpm run ci --fast` and the remaining steps from the [global gate](../../.agent/FACTORY.md#3-global-gates-every-task).
- Run `pnpm --filter @oat/web exec playwright test meeting.spec.ts assistant.spec.ts calm-notes.spec.ts --workers=2`.
- Run `pnpm --filter @oat/web exec playwright test recording.spec.ts --workers=1`.
- Build with `pnpm --filter @oat/desktop build` and capture the dock states using the mock bridge.

## Evidence

- Fast CI: format, actionlint, typecheck, lint and unit tests passed (`ci: ok`).
- Focused Chromium e2e: `12 passed (1.5m)`.
- Browser recording Chromium e2e after restoring the close selector: `3 passed (1.2m)`. Format, typecheck, lint and unit tests also passed on that revision.
- Desktop renderer build: `✓ built in 864ms`. Baselines: `/home/ubuntu/oat-dock-shots/before-light-{idle,transcript}.png`.
  Dock: `/home/ubuntu/oat-dock-shots/after-{light,dark}-{idle,recording,transcript,listening,ask,chat}.png`.
  The fixture does not verify native capture or hardware devices.
- Slow CI: stack, migration and integration tests passed. Desktop Electron e2e (29 tests), acceptance and Swift checks skipped on Linux.
- The full Chromium run found a missing transcript close selector, now preserved by `TranscriptSheet`. It also failed two auth checks that expect email text in the unchanged workspace menu and two home shell checks that timed out clicking the detached Templates command. See `/home/ubuntu/oat-dock-shots/ci-integration.log`.
