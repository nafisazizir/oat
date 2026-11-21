# ci-fast-gate — PR CI under 3 minutes

status: in-review
branch: devin/1795225563-ci-fast-gate (PR #14, builds on #13)

## Goal

The human: "Linux CI takes forever and I dont know if its useful … ideally CI need to runs <3m." Find out why
`Checks (Linux)` is slow and often red, which of its checks catch bugs, and restore an automatic PR job that
runs in under 3 minutes wall clock. Decision: D-34.

## Analysis (CI runs 2026-11-18 → 2026-11-21)

Data: the last 55 `CI` workflow runs (`gh run list --workflow ci.yml`), job/step timings from the Actions API
and the `ci summary` table that `scripts/ci.mjs` prints in each `Checks (Linux)` log.

### Outcomes

| outcome   | runs | notes |
| --------- | ---: | ----- |
| success   |   20 | 11.7–17.2 min for `pnpm run ci` alone (one is #13's run, which skipped the job) |
| failure   |   14 | classified below |
| cancelled |   20 | `cancel-in-progress`: a newer push to the same branch, usually an agent pushing the next fix while the previous 15-min run was still going |

So only 36 % of runs went green. A one-line fix took a 15-minute round trip, which is why so many runs were
cancelled by the next push.

### Where the time goes (`ci summary`, 19 green full runs)

| step            | min    | median | max    | notes |
| --------------- | -----: | -----: | -----: | ----- |
| job setup (checkout, pnpm, node, install, caches) | ~25 s | ~35 s | ~60 s | pnpm store cached; install 6–10 s |
| `format`        |  9.4 s | 10.1 s | 14.1 s | |
| `actionlint`    |  4.0 s |  6.7 s |  7.3 s | |
| `typecheck`     |  0.3 s | 16.4 s | 65.5 s | low numbers are turbo cache hits |
| `lint`          |  1.0 s |  8.8 s | 29.7 s | |
| `test` (unit)   |  0.3 s | 17.0 s | 64.6 s | |
| `stack`         | 19.7 s | 26.3 s | 28.4 s | builds local images + `compose up --wait` |
| `migrate`       |  2.2 s |  2.3 s |  3.4 s | |
| `test:int`      |  176 s |  202 s |  240 s | serial vitest across packages, `--concurrency=2` |
| `e2e`           |  470 s |  517 s |  730 s | `@oat/web` Playwright: 63 tests on 4 workers behind one `next dev` (7.5–10.3 min), plus `@oat/editor` (15 s); desktop e2e skips on Linux |
| **total**       |  703 s |  845 s | 1034 s | failed runs went up to 1258 s |

`format → test` (`--fast`) is 30–200 s; **`test:int` + `e2e` are ~90 % of the run.** e2e is slow because
one `next dev` compiles routes on first request on a 4-vCPU runner, and the timeouts are already scaled by 2.
The Swift macOS job is a separate 1.2–2.3 min.

### Why runs fail: flake vs real (all 14 red runs)

| run (commit) | failing step(s) | cause | kind |
| --- | --- | --- | --- |
| 44419134859 (`e3f43e7` main, LOG-only commit) | test, test:int | unit timing asserts (`82480 < 80000`, 5 s timeout) on the slow runner; fixed by scaling timeouts (`079de58`) | flake |
| 44423615037 (`d317613`, docs-only) | test, test:int | same timing asserts | flake |
| 44424165866 (`58a011b`) | test, test:int, e2e | runner-speed timeouts (notion, documents) while CI was being tuned | flake |
| 44426675201 (`b8403a3`) | test, e2e | same, 4 flaky + timeouts | flake |
| 44597600194 (`9f1506d`) | test:int, e2e | axe a11y violations, focus trap and tabs after the ziiz foundation (fixed in the next commits); `sync.int` ordering assert | **real** (e2e) + flake (int) |
| 44604726254 (`4663a6b`, docs-only) | test:int | backfill timing assert `16600 ≤ 16000`; the test was fixed in `acd50e7` | flake |
| 44614220880 (`6d9065f`) | e2e | axe contrast violations (light/dark) | **real** (e2e) |
| 44614471530 (`16f5b05`) | install | `ERR_PNPM_OUTDATED_LOCKFILE` | **real** (install, 1.5 min) |
| 44620085041 (`b313899`) | e2e | workspace switch read before it was stored; fixed by a test wait (`77da74e`) | flake (test race) |
| 44623196600 (`ba424ee`, merge of main) | typecheck, e2e | type error and a duplicate radio (strict-mode violation) from the merge | **real** (typecheck + e2e) |
| 44703514772 (`bd9eba1`) | e2e | Notion moved behind the overflow menu, so the pipeline spec could not find it | **real** (test out of date) |
| 44710194667 (`f2b07e9`) | e2e | dark search-snippet contrast 4.1:1 (also on main, missed by local runs), template spec 429s from a shared test identity, 4 flaky | **real** (e2e) + test-isolation bug |
| 44715788534 (`1735fb8`) | e2e | new recording spec clicked during the pause between archive parts | flake (test race) |
| 44722228345 (`d38f80a` main) | e2e | `ECONNRESET` in enhance.spec; the same tree passed on the PR | flake |

**8 of 14 red runs were flakes** (timing on a slow runner, or test races), and 3 of those were on commits that
changed only docs or LOG. **6 were real:** 2 were caught by install or typecheck within 1–2 minutes, and 4 only by
web e2e (mostly axe contrast and a11y after UI changes, plus e2e specs that the UI change broke).

### Is it useful, or does it duplicate local `pnpm run ci`?

- On paper the job is a duplicate: GitHub runs the same `pnpm run ci` (D-12) that every implementer must run
  before hand-back (FACTORY §2.4/§3).
- In practice it is the only place the **full** suite runs on a clean machine. LOG entries show agents mostly
  run `pnpm run ci --fast` plus the e2e specs they touched (the Devin VM also hits Docker Hub 429s that make
  the compose stack painful). The 4 e2e-only catches (contrast, a11y, specs broken by UI changes) were all
  missed locally, and one (search contrast) had already landed on main.
- The fast steps (format, actionlint, typecheck, lint, unit) are cheap and catch lockfile, merge and type
  errors. They also flaked twice early on, before the timeout scaling.
- `test:int` caught nothing real in this window; its 3 failures were timing or ordering flakes.

### Recommendation (implemented, D-34)

1. **PR gate = fast tier, in parallel:** `format,actionlint,lint` · `typecheck` · `test`, as 3 matrix jobs
   each running `pnpm run ci --only …` with its own turbo cache. Target and measured: < 3 min wall clock.
2. **Full `pnpm run ci` on every push to `main`** (the post-merge signal, ~15 min), and **on demand** for any
   branch (Actions → CI → Run workflow, select the branch). Run it on demand before merging UI or a11y-heavy
   PRs, since that is where e2e found real bugs.
3. Local gate unchanged: `pnpm run ci` before hand-back (FACTORY §3).
4. Follow-ups (not in this PR): shard web e2e (`playwright --shard`, one stack + `next dev` per shard) or
   run it against `next build && next start` to cut the main run to ~5 min; then e2e could return to PRs.
   Also replace the remaining wall-clock asserts in int tests with condition-based waits.

## Verification

GitHub Actions run times for PR #14 (job durations come from the Actions jobs API, start → completed).

| Run | Cache | Fast (static) | Fast (typecheck) | Fast (unit) | Swift (macOS) | Wall clock |
| --- | ----- | ------------- | ---------------- | ----------- | ------------- | ---------- |
| [44852204771](https://github.com/nafisazizir/oat/actions/runs/44852204771) | cold (new keys) | 1m15s | 1m18s | 1m19s | 1m51s | **1m56s** |
| [44852432051](https://github.com/nafisazizir/oat/actions/runs/44852432051) | warm (turbo hits) | 47s | 32s | 19s | 1m41s | **1m45s** |

`Checks (Linux)` shows `skipped` on PRs, as intended. The slowest job is now the unchanged macOS Swift job (~1m45s),
not the Linux gate. The `workflow_dispatch` path for the full suite was not run from this session (the session's
GitHub token can't dispatch workflows); the job and its steps are unchanged apart from the `if:` and cache key. Locally, `pnpm run ci --only format,actionlint` passed
(13.7 s).
