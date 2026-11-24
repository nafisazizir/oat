# Floating meeting note dock

status: verify

branch: `devin/1795541973-note-floating-dock`

## Goal

Try a layout that brings meeting recording, transcript and Ask together over the note without replacing Oat’s visual style.

## Scope

Web and desktop meeting notes. Recording, playback, chat, citations and proposal handling keep their current data paths. No new audio device picker, language settings or assistant backend.

## Design

The compact capture controls sit left of Ask near the bottom of the note. The transcript header only offers copy and collapse, with no placeholder row for missing audio. Transcript bubbles align by speaker without visible speaker or timestamp captions. Ask expands to suggested prompts and the note’s chat; existing threads can also open in the full Assistant. Both use Oat components and tokenized surfaces.

The capture buttons are icon-only on web and desktop. The waveform toggle exposes the transcript’s expanded state. Recording and transcript buttons retain accessible names and show Oat tooltips.

Oat’s existing `ButtonGroup` holds at most two controls: waveform and record when idle, waveform and pause or resume during capture. The note dock has no elapsed timer; Stop is in the transcript footer. The waveform animates only during recording and respects reduced motion. The dock buttons and Ask use Oat’s large size variants.

The expanded transcript and Ask panels replace the dock row. Their surfaces extend around the existing dock bounds so the capture group and the single-line Ask composer align exactly with their collapsed positions. The Ask launcher hides while Transcript is open, leaving room for recording status and Stop.

The floating controls use pill corners, with square inside seams on the capture group and large corners on the expanded panels. Ask is 40 px in the collapsed row and for a single line in the expanded composer, which can grow with the draft.

## Acceptance criteria

- Capture baseline and dock states in the built desktop renderer with a mock bridge.
- In both apps, the transcript collapses and copies without changing stored lines or citation handling.
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
- Icon-only follow-up: fast CI printed `ci: ok`; the focused web meeting, assistant, calm-notes and recording suites printed `14 passed (1.8m)`. Refreshed the light and dark captures and added `/home/ubuntu/oat-dock-shots/after-dark-tooltip.png` (waveform hover).
- ButtonGroup follow-up: inspected the attached controls in the light and dark desktop renderer captures for idle, recording, listening, transcript and chat. Both waveform tooltip captures are at `/home/ubuntu/oat-dock-shots/after-{light,dark}-tooltip.png`.
  Fast CI printed `ci: ok`; the Chromium recording suite printed `3 passed (49.9s)` after preserving the off-note recording banner. The focused meeting, assistant and calm-notes specs passed in the preceding combined run.
- Two-control follow-up: fast CI printed `ci: ok`; focused Chromium suites printed `14 passed (1.7m)`, including reduced motion, pause/resume, and stopping from the footer. Refreshed the light and dark mock desktop screenshots. The paused state is at `/home/ubuntu/oat-dock-shots/after-dark-recording-paused.png`; Stop is visible in the listening screenshots.
- Full-width follow-up: fast CI printed `ci: ok`; focused Chromium suites printed `14 passed (1.9m)`, including matching transcript and dock widths and bottom edges, footer focus, and recording controls. The desktop renderer built in 1.01 seconds. Refreshed the light and dark mock desktop captures and visually checked the dock and expanded panels. Native capture was not tested.
- Rounded follow-up: fast CI printed `ci: ok`. The focused Chromium run passed 12 checks and exposed two assertions that assumed a 24 px radius; the Oat token resolves to 43.12 px at the default setting. The corrected targeted run printed `3 passed (40.2s)`. The rebuilt mock preview at `http://localhost:4174/` verified both Ask heights at 40 px, growth for multiline drafts, and recording and chat interactions. Refreshed and visually checked the light and dark dock captures.
- Stationary controls follow-up: focused Chromium printed `14 passed (2.0m)` with exact bounding-box checks for the waveform, live recording group and Ask composer. The refreshed mock desktop preview matched both trigger positions; Stop fit at a 390 px viewport. Fast CI passed format, actionlint, typecheck and lint, and timed out in one main-process audio fixture. The unit-test rerun printed `24 successful, 24 total`.
- Minimal transcript follow-up: fast CI printed `ci: ok`. Focused Chromium printed `14 passed (1.8m)`, covering unchanged waveform background and bounds, keyboard focus, header actions, and timestamp deep links without visible captions. The mock renderer preview on port 4174 verified exact trigger geometry and recording and Ask interactions. Refreshed and inspected the light and dark transcript captures.
