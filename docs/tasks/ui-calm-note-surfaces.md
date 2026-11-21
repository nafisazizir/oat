# UI redesign PR 4 — home and note surfaces

status: done
milestone: M9 · branch: devin/1795226919-calm-note-surfaces · deps: ui-calm-settings

## Goal
Calm home and document/meeting surfaces across web and desktop. Inter headings, ziiz roles/ramps.
Reference: research/granola/ui-design.md, Home and Note page; D-33.

## Acceptance
- [x] Centered ~680px home content with optional Coming up and borderless date-grouped notes.
- [x] Title first, one compact metadata row and toolbar actions, without duplicate buttons/headers.
- [x] Transcript closed by default, per-user persistence, bottom toggle, close/Escape, citation opens.
- [x] Web Ask/transcript/recording share a bottom anchor; native recording/transcript share a bottom bar.
- [x] Preserve saving, permissions, playback, errors, recording and assistant interactions.
- [x] Fast CI, relevant web e2e, desktop meeting unit tests and renderer build pass.
- [x] Light/dark 1440×900 screenshots under ~/shots/pr4/ reviewed.

## Scope and design notes
Desktop has no existing Ask composer or native chat feature; no new one was invented.
Citation links still open transcript. Recording errors stay visible without forcing open transcript.
Calendar connect remains in settings when Home has no events. Device recording/auto-stop controls stay
reachable. Attendee details/add/remove are in a popover behind the compact count chip on both surfaces.
Web groups existing shell notes by update date; native uses the available recording/creation date.
Rebased onto origin/main 12ad11c after PR 3 merged, preserving its teamWorkspace Members-link guard.
Publish this branch without opening a PR.

## Verification
From the repo root:
- `pnpm run ci --fast`.
- `DATABASE_URL=postgres://oat:oat@localhost:54329/oat OAT_NEXT_DIST_DIR=.next-pr4-e2e E2E_PORT=3104 pnpm --filter @oat/web exec playwright test e2e/documents.spec.ts e2e/meeting.spec.ts e2e/recording.spec.ts e2e/recording-recovery.spec.ts e2e/assistant.spec.ts e2e/a11y.spec.ts e2e/smoke.spec.ts e2e/calm-notes.spec.ts e2e/calendar.spec.ts e2e/notion.spec.ts e2e/enhance-versions.spec.ts`.
- Focused calendar rerun after adapting its attendee selector: same command with only
  `e2e/calendar.spec.ts`.
- `pnpm --filter @oat/desktop build`.
- Screenshots/interaction + axe checks: `node /home/ubuntu/shots/pr4/capture.mjs`; seeded local web
  session plus simulated desktop bridge. Extra Coming up capture: `calendar-capture.mjs`.

## Review and evidence
Evidence under `/home/ubuntu/shots/pr4/`:
- `ci-fast-metadata.log`: **ci: ok** (41.1s); desktop **54 files / 417 tests passed**, including
  meeting-view's 3 cases; shared meeting UI **5 files / 34 tests passed**, including summary normal,
  empty and removal-error cases. Final release gate: `ci-fast-release.log`.
- `web-e2e-final.log`: **37 passed**, one stale calendar attendee selector failed after moving the
  details into a popover. Selector updated; `calendar-e2e-final.log`: **3 passed (34.5s)**. All requested
  routes, recording/recovery, citations, resize/persistence, assistant, accessibility and integrations
  covered. The Home e2e uses its own account so it does not pollute smoke's empty-state fixture.
- `renderer-build-summary.log`: **built in 758ms**, existing >500kB chunk advisory only.
- `web-capture-summary.log`, `desktop-capture-summary.log`: closed/open states, Escape and web focus
  return passed; all captured-state axe scans **0 violations**. Initial desktop active-timestamp
  contrast 4.17:1 was fixed with the selected foreground ramp; subsequent scans passed.
- **18 PNGs, all 1440×900**, visually reviewed. Each basename has `-light.png` and `-dark.png`:
  web-home, web-document, web-meeting-closed, web-meeting-open, desktop-home, desktop-meeting-closed,
  desktop-meeting-open, desktop-recording; extra desktop-home-coming-up.

Linux desktop evidence uses a built renderer and simulated bridge/calendar/recording state, not native
Electron/macOS audio, permissions or real capture. Web transcript content is seeded; real provider
integrations and AI services were not exercised.

## PR 18 review follow-up
- Verified starting HEAD `b04c9a2`. Three findings confirmed from their reachable layout/close paths.
- `3b57242`: desktop recording bar now follows the entire note/transcript row, not the squeezable note
  column. Regression unit asserts the bar's parent; at 780px with expanded sidebar and transcript set
  to its 600px maximum, Pause/Stop pass viewport, center hit-testing and click actionability checks.
- `394747f`: recording feedback is a slot above the sticky bottom control group. The denial regression
  creates a 120-paragraph meeting, scrolls its title offscreen, denies mic capture, asserts alert/Retry
  in viewport and retries (two getUserMedia attempts) without opening transcript.
- `40a898a`: closing transcript calls the existing player's pause, which pauses both local audio
  elements. Real browser recording/playback regression closes via Escape, pill and × while playing,
  asserts the hidden audio is paused and reopens to paused controls for every method.
- `ci-review-fixes.log`: **ci: ok** (47.1s), including desktop meeting-view 3 tests and all desktop
  **417 tests / 54 files**. `e2e-review-fixes.log`: **13 passed (1.4m)** across recording, recovery,
  meeting and assistant specs. `build-review-fixes.log`: **built in 665ms**, existing chunk advisory.
- Screenshots reviewed: `desktop-narrow-review-fixed.png` and `web-denied-review-fixed.png` under
  ~/shots/pr4/. Desktop is simulated bridge evidence, not native Electron/audio capture.
