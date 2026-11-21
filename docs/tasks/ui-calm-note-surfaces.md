# UI redesign PR 4 — home and note surfaces

status: in-progress
milestone: M9 · branch: devin/1795226919-calm-note-surfaces · deps: ui-calm-settings

## Goal
Calm home and document/meeting surfaces across web and desktop. Inter headings, ziiz roles/ramps.

## Acceptance
- [ ] Centered ~680px home content with optional Coming up and borderless date-grouped notes.
- [ ] Title first, quiet metadata and toolbar actions, without duplicate buttons/headers.
- [ ] Transcript closed by default, per-user persistence, bottom toggle, close/Escape, citation opens.
- [ ] Web Ask/transcript/recording share a bottom anchor; native recording/transcript share a bottom bar.
- [ ] Preserve saving, permissions, playback, errors, recording and assistant interactions.
- [ ] Fast CI, relevant web e2e, desktop meeting unit tests and renderer build pass.
- [ ] Light/dark 1440×900 screenshots under ~/shots/pr4/ reviewed; commit/push, no PR opened.

## Scope notes
Desktop has no existing Ask composer or native chat feature; don't invent one in this layout PR.
Citation links must still open transcript. Web currently forces it open for recording errors; keep
those errors visible without forcing open the transcript. Calendar connect is still in settings when
Home has no events. Device recording/auto-stop safety controls remain reachable.

## Verification
Pending.
