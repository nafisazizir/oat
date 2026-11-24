# ci-fast-only — Keep only fast hosted CI

status: done
branch: devin/1795552919-ci-fast-only

## Goal

Keep quick automated feedback without requiring two unreliable hosted jobs. Keep the full local gate.

## Context

- [D-42](../DECISIONS.md#d-42--2026-11-24--accepted--human) supersedes the hosted full tier.
- [Run 45476945700](https://github.com/nafisazizir/oat/actions/runs/45476945700): all three fast checks
  finished in under a minute. Linux exceeded its 30-minute limit during web Playwright, which logged ten
  failing tests before cancellation, including auth assertions that still expected email next to the display
  name. The Swift job ran no steps: GitHub reported it never acquired a hosted runner.
- [Run 45470215322](https://github.com/nafisazizir/oat/actions/runs/45470215322): Linux again exceeded
  30 minutes; Swift passed when a runner was available. Unit tests failed looking up the Status “Done”
  option immediately after clicking the trigger. Base UI defers pointer opening to an animation frame.

## Scope

Update the hosted workflow and its docs, and have the tasks filter test wait for the rendered option.
Do not change the local CI runner or rewrite the failing full-suite specs.

## Acceptance criteria

- [x] Only the three fast matrix checks are defined in GitHub Actions CI, on PRs, pushes to main and dispatch.
- [x] The full local gate and the local Swift group are unchanged and documented.
- [x] The tasks filter test still checks control, refetching and focus, without timing its option query to the click.

## Verification

- `pnpm run ci --only format,actionlint,lint`
- `OAT_TEST_TIMEOUT_SCALE=3 pnpm --filter @oat/feature-ui test src/tasks.test.tsx`

## Evidence

- Static gate: `format      pass      11.6s` and `lint        pass      12.4s`. Docker Hub returned
  `429 Too Many Requests` pulling the pinned actionlint image. After pulling the same version from the
  mirror and retagging, `pnpm run ci --only actionlint` printed `actionlint: .github/workflows/ci.yml ok`
  and `ci: ok`.
- Focused test: `Test Files  1 passed (1)` and `Tests  17 passed (17)`.
- The full and Swift gates were not rerun; their implementation is unchanged.
