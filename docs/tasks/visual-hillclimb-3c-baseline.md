# Visual hill-climb 3c — Graphite refinements

status: done
milestone: M9 · branch: devin/1795326041-visual-hill-climb-3c

## Goal

Prepare the PR #31 web/desktop visual audit against ziiz's Graphite Claude clone. This handoff
authorizes setup, BEFORE screenshots and source-linked findings only, not product/UI changes.

## Scope

In: local compose/web/reference servers, built desktop renderer with stubbed window.oat,
external rerunnable Playwright harness and light/dark baseline. Out: UI implementation,
native Electron/macOS verification, live recording and provider mutations.

## Acceptance criteria

- [x] Branch from origin/main; dependencies/services ready; desktop renderer built.
- [x] Harness accepts output directory; scripts and screenshots remain outside git.
- [x] Captured 28 web, 34 desktop and 4 reference PNGs; inspected contact sheets and selected full images.
- [x] Audit lists source locations and separates rule violations from optional visual tuning.
- [ ] Web meeting loading/unavailable/offline and desktop invalid-invite landing captures outstanding.

## Verification and evidence

External report, commands, complete basename inventory and caveats: `/home/ubuntu/oat-shots/README.md`.
Harness: `/home/ubuntu/oat-shots/harness/{capture,web-states,states}.mjs`.
Evidence: `/home/ubuntu/oat-shots/before/{web,desktop}` and `/home/ubuntu/oat-shots/ref`.
Contact sheets: `/home/ubuntu/oat-shots/contact-*.jpg`.

Final state scripts emitted all requested fixture files with no FAILED output. Crash fixture logs
the intentional `TypeError: Cannot read properties of null (reading 'status')` while showing recovery;
it is not evidence of a real production crash or recording continuity. Desktop conflict-banner
capture is inside the compare dialog; standalone web banner captured. No product tests rerun because
only documentation changed. Global FACTORY gates deferred until product implementation; capture
rendering is the check for this baseline step. No commit/push.

## Design notes

Main hard-rule mismatch: outline/default supporting actions instead of secondary. Command menu
already uses sm, rounded-xl matches reference, red/amber are valid ramps, skeleton rounded-full is
permitted. Avoid treating these as token violations. Other candidates are narrower panel greeting,
broader command/history surfaces, and web greeting email-local-part fallback; details in audit.

## Step 2 — authorized visual changes

Shared supporting actions use secondary; invitation Accept keeps primary; recovery Retry is secondary
and Reload ghost. Conflict banner uses background-200/gray-alpha border, gray text and amber icon.
History is a ghost-sm value trigger with a quieter preview border. Command menu uses the dialog's
default width. AssistantChat passes its page/panel layout to ChatSession: panel greeting is heading-24
and truncates long names without changing its accessible text; page remains heading-32.

Additional related polish: Enhance error Retry is secondary and its split divider uses the component's
default gray-alpha border color instead of a high-contrast gray-700 override. Diff fills retained.
Shared packages contain no new Next/Electron imports. Web Back to Oat link composition unchanged.

### Acceptance checks

- [x] Supporting controls, banner, history, command width and greeting refinements implemented.
- [x] Regression assertions cover primary/supporting join actions, invitation account switch,
      recovery action styles, neutral conflict surface and panel/page long-name greeting semantics.
- [x] Rebuilt desktop; all three harness scripts rerun into `/home/ubuntu/oat-shots/after`.
- [x] Side-by-side before/after light/dark sheets reviewed under `/home/ubuntu/oat-shots/compare`.
- [x] Conflict banner axe AA and real-browser greeting geometry checked.
- [x] Private/shared leaving light/dark E2E retains Back to Oat role=link to /home.
- [x] All fast-gate steps verified: original four static passes plus successful test-only retry below.

### Step 2 evidence

All three external capture scripts exited 0: 28 web and 34 desktop AFTER images match BEFORE
filenames; both state manifests have `failures=[]`. Reference rerun also captured 4 images.
Reviewed all 19 comparison sheets (`/home/ubuntu/oat-shots/compare/<surface>.jpg`):
assistant-greeting, command-menu, conflict-banner, conflict-retry, crash-recovery, enhance-menu,
enhance-notion, home-documents, invite-invalid, invite-response, join-workspace, meeting-error,
meeting-loading, meeting-offline, meeting-unavailable, note-assistant, notion-send, notion-update,
version-history. Source fixture account IDs/times differ between runs; web BEFORE thread list was
still loading whereas AFTER settled empty. These are fixture differences, not product changes.

`pnpm --filter @oat/desktop build` exited 0; existing >500kB chunk advisory retained.
Browser harness `/home/ubuntu/oat-shots/harness/checks.mjs` output:

```text
PASS /join Back to Oat remains role=link, href=/home, navigates Home
PASS Assistant panel uses single-line 24px greeting; full page remains 32px
PASS conflict banner light: axe WCAG A/AA violations=0
PASS conflict banner dark: axe WCAG A/AA violations=0
```

Both axe scans also have zero incomplete rules. JSON/logs: `step2-browser-checks.{json,log}`.
Existing E2E command (separate dist directory avoids disturbing capture server):

```sh
DATABASE_URL=postgres://oat:oat@localhost:54329/oat E2E_PORT=3108 OAT_NEXT_DIST_DIR=.next-visual-3c-e2e pnpm --filter @oat/web exec playwright test e2e/private-shared.spec.ts --grep 'leaving \(' --workers=1
```

Output: `3 passed (2.0m)` (setup plus light/dark leaving journeys, including role=link Back to Oat).
An initial anchored grep selected no tests; corrected the test filter, not product/tests.

`pnpm run ci --fast` initially passed format/actionlint/typecheck/lint but failed test:
unchanged `packages/editor/src/markdown.test.ts:915` property test exceeded 5000ms (5657ms) while
browser work ran concurrently. `git diff --quiet HEAD -- packages/editor` confirms editor inputs
unchanged, and the headless Markdown test imports no changed UI component. No test budget/code changed.
After browser work finished, reran only the failed gate (`pnpm run ci --only test`; --fast and --only
cannot be combined). All 24 package tasks succeeded, 17 cached; editor 186, workspace-ui 118,
feature-ui 176, UI 129, desktop 634 and web 210 tests passed. Earlier four unchanged static passes
retained, not rerun. Gate tails:

```text
━━ ci summary (--fast)
step        status     time  note
format      pass      20.0s
actionlint  pass       2.7s
typecheck   pass      54.8s
lint        pass      20.8s
test        FAIL      29.5s  pnpm run test --concurrency=4 exited with 1
total                127.8s

ci: FAILED (test)

 Tasks:    24 successful, 24 total
Cached:    17 cached, 24 total
  Time:    30.042s

━━ ci summary (--only test)
step  status     time  note
test  pass      30.4s
total            30.4s

ci: ok
```

Logs: `/home/ubuntu/oat-shots/step2-{ci-fast,ci-test-retry,join-e2e,desktop-build,web-capture,desktop-capture}.log`.
No full integration/native gate requested for this step. No commit/push.

## Review

Step 2 implementation and visual verification complete; all five fast steps verified across the initial
run and test-only retry. Step 3 authorizes full E2E, final fast gate, conventional commit and origin push.
Step 1 capture gaps and native limitations explicitly retained above.

## Step 3 — release gates and publication

Installed/ensured Chromium with `pnpm exec playwright install chromium` in apps/web (exit 0).
Stopped the capture-only web server before E2E to avoid sharing Next's dev cache. Ran:

```sh
DATABASE_URL=postgres://oat:oat@localhost:54329/oat pnpm run ci --only e2e
```

No product fixes needed. Web 91 passed/17 opt-in skips; editor 16 passed/2 screenshot opt-in skips.
Desktop native E2E remains macOS-only; its runtime limitations are unchanged. Expected error-probe,
adversarial script-tag and aborted-stream diagnostics remain non-fatal. Tail:

```text
  17 skipped
  91 passed (8.8m)

  2 skipped
  16 passed (11.3s)

━━ ci summary (--only e2e)
step  status     time  note
e2e   pass     546.3s
total           546.3s

ci: ok
```

Evidence: `/home/ubuntu/oat-shots/step3-ci-e2e.log`.

Final `pnpm run ci --fast` passed without timeout scaling; the property timeout did not recur.
Test tasks reused all 24 successful Turbo cache entries. Tail:

```text
 Tasks:    24 successful, 24 total
Cached:    24 cached, 24 total
  Time:    39ms >>> FULL TURBO

━━ ci summary (--fast)
step        status     time  note
format      pass      16.5s
actionlint  pass       0.3s
typecheck   pass       0.5s
lint        pass       1.1s
test        pass       0.4s
total                 18.8s

ci: ok
```

Evidence: `/home/ubuntu/oat-shots/step3-ci-fast.log`. No Step 3 product/test changes were needed.
User accepted the visual work and authorized conventional commit/push on
`devin/1795326041-visual-hill-climb-3c`; publication follows this closeout. Screenshots/harness/logs
remain outside git. Baseline capture gaps/native limitations remain explicit, not claimed resolved.
