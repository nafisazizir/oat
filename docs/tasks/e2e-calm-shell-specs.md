# e2e-calm-shell-specs — desktop e2e and the acceptance journey on the calm shell

status: review
milestone: M9 · deps: ui-calm-shell, ui-calm-settings, ui-calm-note-surfaces, ui-calm-auth-dialogs ·
branch: task/e2e-calm-shell-specs (from `task/unified-workspaces` 0fb193f)

## Goal

The `e2e` and `acceptance` steps of `pnpm run ci` are red on `main` (d3b92e2). PR CI runs only the fast steps
(D-34), so the calm UI PRs (#15–#19) changed the desktop shell and the note layout without these specs being
run. Make both steps green again **without hiding anything**: per failing test, decide whether the spec is
stale or the product regressed; update stale specs to reach the same behaviour through the new UI; leave real
regressions failing and report them.

## Context

- `docs/tasks/ui-calm-shell.md`, `ui-calm-settings.md`, `ui-calm-note-surfaces.md`, `ui-calm-auth-dialogs.md`
  (what moved, and what they say must still work), D-33, D-34.
- `apps/desktop/e2e/workspaces.spec.ts` was adapted in bcf9a2b (pattern: Home via `home-nav`, transcript
  through its toggle).
- Product code read for every decision: `apps/desktop/src/renderer/src/windows/main-window.tsx`,
  `meetings/meeting-view.tsx`, `meetings/home-view.tsx`, `calendar/upcoming-list.tsx`,
  `windows/shell-menus.tsx`, `packages/meeting-ui/src/{participants,transcript-toggle}.tsx`.

## Scope

In: `apps/desktop/e2e/*`, `e2e/acceptance/journey.spec.ts`, the two intermittent web specs
(`apps/web/e2e/typography.spec.ts`, `notion.spec.ts`) if a cause in the test setup is found.
Out: any product behaviour change; redesigning the UI; skips, deleted assertions, longer timeouts.

## Acceptance criteria

- [ ] Every previously failing desktop spec and the acceptance journey pass, or is listed below as a product
      regression with evidence.
- [ ] No assertion removed or weakened, no `skip`, no timeout raised; product code untouched.
- [ ] `pnpm install && pnpm run ci` summary pasted under Evidence.

## Verification

- `pnpm run ci --only stack,e2e,acceptance` (or the full `pnpm run ci`): `e2e` and `acceptance` pass.
- `git diff 0fb193f --stat`: only `apps/desktop/e2e/`, `e2e/acceptance/`, `apps/web/e2e/` and this file.

## Design notes

### What the calm shell changed (all deliberate, per the ui-calm task files)

| Before | Calm shell | How a spec reaches it now |
| --- | --- | --- |
| Start screen `meeting-start` when no note is open | Home (`desktop-home`): the workspace's notes, "Coming up" when the calendar has events; "No notes yet" when empty | `home(page)` |
| Transcript panel always beside the note (and on the start screen) | Behind the "Transcript N" toggle in the note's bottom bar, closed by default, remembered per user; not on Home | `openTranscript(page)` |
| Player (`playback`) and transcript notices (`transcript-notice`) above the transcript | Unchanged, but inside that panel | `openTranscript(page)` first |
| Attendee chips + "Add attendee" in the note header | Popover behind the "N attendees" chip (desktop and web) | `openAttendees(page)` / `closeAttendees(page)` |
| Sync line with text in the sidebar footer | Icon button; the text is its accessible name and tooltip | `syncStatus(page)` + `toHaveAccessibleName` |
| "Upcoming" in the sidebar | "Coming up" on Home only | `home-nav`, then `upcoming` |
| "Connect calendar" box under "Upcoming" | Not on Home; Settings → Setup → "Open setup" → Calendar step → "Allow calendars" | see calendar-notes below |
| Account menu: one "Settings" item | "Settings" and "Workspace settings (web)" (#17) | `{ name: 'Settings', exact: true }` |
| Local search field in the sidebar | Dialog behind the sidebar's "Search" button | click "Search" first (as `sync.spec.ts` already did) |

Helpers added to `apps/desktop/e2e/helpers.ts`: `home`, `openTranscript`, `openAttendees`, `closeAttendees`,
`syncStatus`. They only reach the surface; every assertion that followed is kept.

### Per spec

All "stale spec" unless marked. Line numbers are the tests' first lines on `main`.

| Spec (test) | Verdict | What changed in the spec |
| --- | --- | --- |
| `sync.spec.ts:51` | stale | Sync status read by accessible name (same text). |
| `meeting.spec.ts:94`, `:255` | stale | Home instead of the start screen; attendees through their popover (plus the chip's count); transcript opened with its toggle, on the web too; relaunch asserts the panel is still open (remembered). |
| `recording.spec.ts:188` (+ the two tests after it) | stale | Empty state before the first recording is Home's "No notes yet"; transcript opened right after Start (first-segment latency still measured to the first visible segment: 583 / 562 ms, as before); sync status by accessible name. |
| `storage.spec.ts:133` | stale | Transcript opened before waiting for finals; exact "Settings" menu item. |
| `playback.spec.ts:132` | stale | Asserts no player while the panel is closed, then opens it; rest unchanged. |
| `backfill.spec.ts:133`, `:213` | stale | Transcript opened before the notices are asserted (see note 2). |
| `auto-stop.spec.ts:173` (+ `:257`, `:314`, `:350`) | stale | `segments()` opens the transcript; exact "Settings" menu item. |
| `calendar-notes.spec.ts:190`, `:295`, `:334` | stale | "Coming up" on Home (`home-nav` before each look); attendees through their popover; third test connects the calendar through Settings → Setup → Open setup → "Allow calendars" (see note 1). |
| `onboarding.spec.ts:74` | stale | Home instead of the start screen; exact "Settings" menu item. |
| `a11y.spec.ts:156` | spec updated, **still fails: product regression** | Home, transcript opened for the recording sweeps, "Coming up" via Home (+ a Home-with-notes sweep), exact "Settings". It now runs to the end and reports one axe finding, below. |
| `e2e/acceptance/journey.spec.ts:159` | stale | Home; transcript opened right after "New meeting note" and on the web; sync status by name; desktop search through its dialog; Notion link through the web note's "More actions" (as `apps/web/e2e/pipeline.spec.ts` does). |

### Product regression left failing

`apps/desktop/e2e/a11y.spec.ts` — axe `label-content-name-mismatch` (serious, WCAG 2.5.3) on all three
Settings screens, light and dark (6 findings, nothing else): the back button in
`apps/desktop/src/renderer/src/settings/settings-view.tsx` (`data-testid="settings-close"`, from #17) has
`aria-label="Back to notes"` while its visible text is "Back" + the `Esc` key hint, so the visible label is
not part of the accessible name (voice-control users saying what they see don't hit it). Product code, so
not fixed here. Likely fix: drop the `aria-label` or make the `Kbd` `aria-hidden` and keep the name
starting with the visible text.

### Not a calm-shell issue: `storage.spec.ts` intermittent on this branch (left as is)

1 run in 5 here: "Start recording" right after sign-in stays idle with "You’re not in a workspace any more,
so there’s nowhere to save a new note…" (`NO_WORKSPACE_MESSAGE`, `apps/desktop/src/main/workspaces.ts`).
That path is from the in-flight unified-workspaces work (0b825e8, a1329ce; not on `main`): when the first
pull has landed but no workspace is known yet, a start waits only `RECHECK_MS` (1.5 s) and then says the
user is in no workspace. A user who starts a recording within moments of signing in can hit it. Reported to
the owner of `task/unified-workspaces`; not masked in the spec.

### The two intermittent web specs (both had a cause in the test, fixed)

- `typography.spec.ts`: the trace of a failing run shows 5 × `429` from `GET /api/sync/events`
  (`retry-after` 1–2 s): the per-user limit of 30 SSE connects a minute (`SYNC_EVENTS_CONNECTS_PER_MINUTE`).
  The spec ran as the shared signed-in user (as do smoke, settings, calm-shell, …, on 4 workers) and loads
  12 pages within seconds. It now signs up its own user per test (the pattern of `calm-notes.spec.ts`).
  Other specs on the shared user can in principle still add up to 30 a minute; none was seen failing.
- `notion.spec.ts`: the failing run's page snapshot has "More actions" still open (`[expanded]`, with the
  Notion link) at phone width. Since #18 the Notion controls live in that popover, it stays open after
  "Update in Notion", and the one-shot `scrollWidth` read right after the resize caught the popup at its
  desktop position (1178). The spec now closes the menu before resizing; the phone-width assertions are
  unchanged. Both specs: 3/3 passes each with `--repeat-each 3`, and green in the full run.

### Judgement calls to review (specs adapted, not regressions by the "reachable" standard)

1. **Connect calendar.** 7.3 asks for "a clear Connect calendar call-to-action" when no calendar is readable.
   `UpcomingList` is now only rendered `compact` on Home, where it returns nothing without events and never
   renders the CTA (`calendar-connect` is dead code). `ui-calm-note-surfaces.md` says "Calendar connect
   remains in settings": in practice Settings → Setup shows "Calendar: Not allowed yet" and "Open setup",
   whose Calendar step has "Allow calendars" / "Connect Google Calendar". The spec now walks that path and
   asserts that Home shows no "Coming up" and that nothing asked on its own. Reachable, but three clicks deep
   and unlabelled as a calendar action.
2. **Transcript notices.** "Filling in N min of transcript…" and "Oat quit unexpectedly — recording saved up
   to …" (2.7) are only visible once the transcript panel is opened. 2.7 places them in the transcript panel,
   so the specs open it; a user who never opens the transcript doesn't see the crash-recovery note.
3. **"No transcript yet" start copy** ("Start recording to transcribe your microphone (you) and your
   computer's audio (them), live") is unreachable on the desktop: no panel without a note. Home's "No notes
   yet" is asserted instead.
