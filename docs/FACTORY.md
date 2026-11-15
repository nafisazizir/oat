# The Factory — how agents build Oat autonomously

Goal: from these docs alone, an orchestrator session can run long-lived, spawn subagents, and drive every
task through **prompt → design → code → review → verify → ship** until the v1 definition of "ready"
(`SPEC.md` §9) is met — stopping only for the human checkpoints below.

## 1. Roles

| Role | Runs as | Owns | Must not |
|---|---|---|---|
| **Orchestrator** | Long-running main session (`/loop` self-paced, or a workflow) | Picking tasks, `PLAN.md`, `LOG.md`, spawning others, merging | Write large features itself; skip gates |
| **Researcher** | Subagent with REA + web | `research/granola/*` | Write product code; copy Granola code/prompts/assets |
| **Designer** | Subagent | UI composition with `packages/ui`, design notes in the task file | Invent one-off colours/spacing outside tokens |
| **Implementer** | Subagent in its own git worktree | Code + tests for one task | Touch files outside the task's scope without noting it |
| **Reviewer** | Fresh subagent, given the diff + task file only (not the implementer's reasoning) | Review verdict in task file | Fix code itself (it reports; implementer fixes) |
| **Verifier** | Fresh subagent | Running acceptance checks, recording evidence | Mark done without running checks |

Independence matters: reviewer and verifier get the *artifact*, not the implementer's conclusions.

## 2. The loop (per task)

```
pick ─► PROMPT ─► DESIGN ─► CODE ─► REVIEW ─► VERIFY ─► SHIP ─► log
            ▲                  │        │         │
            └──── (fail ≤3x) ◄─┴────────┴─────────┘   then escalate to human
```

1. **Pick** — next unchecked task in `PLAN.md` whose `deps` are all checked. Tasks without shared files may
   run in parallel (max 3 implementers at once), each in its own worktree.
2. **Prompt** — write `docs/tasks/<id>-<slug>.md` from the template (§5): goal, context links, scope,
   acceptance criteria, verification commands. This file *is* the brief every later subagent receives.
3. **Design** — for UI tasks: layout sketch (ASCII ok), components used from `packages/ui`, states
   (empty/loading/error). For architecture tasks: interfaces + data flow. Any real decision → new entry in
   `DECISIONS.md`.
4. **Code** — implementer works on branch `task/<id>-<slug>`, small commits, adds/updates tests. Must run
   `pnpm typecheck && pnpm lint && pnpm test` locally before handing back.
5. **Review** — reviewer reads task file + `git diff main...`. Checks: meets acceptance criteria, correctness,
   security (secrets, authz via `packages/core/permissions`), clean-room compliance, tests meaningful,
   no scope creep. Verdict: `approve` or `changes` with a numbered list. Use `/code-review` where available.
6. **Verify** — verifier runs every command in the task's *Verification* section plus the global gates (§3)
   and pastes the outputs (trimmed) into the task file. UI tasks need a screenshot or Playwright trace.
7. **Ship** — orchestrator squash-merges the task branch into local `main` (D-12), re-runs `pnpm run ci` on
   `main`, ticks the box in `PLAN.md`, appends to `LOG.md`. (Vercel previews start at PLAN 9.6.) Production
   deploys and signed desktop releases are human checkpoints.

**Research on demand (any phase, any milestone).** When a task hits a "how does Granola do X?" question —
e.g. the system-audio tap fails, meeting detection is flaky, sync conflicts behave oddly — first check
`research/granola/`. If the answer isn't there, the orchestrator spawns a **Researcher** with one specific
question; it uses REA (§8) and writes the answer to `research/granola/<topic>.md`, then the task continues
from that note. Implementers never run REA themselves or read `research/granola/raw/` (clean room). Log each
research request in the task file under *Context*.

A task that fails review or verification 3 times goes to `blocked` with a summary of what was tried, and the
orchestrator moves on to other unblocked work.

## 3. Global gates (every task)

- **`pnpm run ci` is the gate** (D-12; `scripts/ci.mjs`, same command as the GitHub workflow): format,
  actionlint, typecheck, lint, unit tests, then — ensuring the shared compose stack is up (no-op when healthy) —
  a migration check on a throwaway DB, `test:int`, package e2e (Playwright, free port each) and, on macOS, the
  Swift sidecar (build, test, synthetic capture). Green = every step `pass` or `skip`. While iterating,
  `pnpm run ci --fast` (no stack/e2e/Swift) or `--only <step>`; the full run is required before hand-back,
  verification and merge. Details: `docs/DEV.md` → "CI".
- No calls to external services in dev or tests (D-11): new integrations get a mock in `tools/mocks` and an
  env-selected base URL; real-provider smoke tests are skipped unless the key is set.
- New logic has tests; bug fixes have a regression test.
- Permission-sensitive code goes through `packages/core/permissions.ts` and has tests for deny cases.
- AI prompt/behaviour changes: `pnpm --filter @oat/ai eval` does not regress vs `main`.
- No secrets committed; env vars documented in `.env.example`.
- Clean-room check: no strings/prompts/assets lifted from `research/granola/raw/`.

## 4. Making things verifiable without a human

The factory only works if agents can check their own work. Design for it:

- **Audio:** `FileSource` replays WAV fixtures (`fixtures/audio/*.wav`, two-channel me/them) through the
  same pipeline as the Swift sidecar. The real sidecar is verified once per change by a human checkpoint
  (macOS permission prompts can't be automated).
- **STT:** `FakeSttProvider` returns scripted segments; a small recorded-response fixture covers the
  Deepgram adapter. A live Deepgram smoke test runs only when `DEEPGRAM_API_KEY` is set.
- **AI:** evals with fixture meetings; schema-validated outputs; a mocked model for unit tests.
- **Web:** Playwright against `next dev` and against the Vercel preview URL.
- **Desktop:** Playwright's Electron support (`_electron.launch`) for renderer flows; main-process logic
  is plain TS with unit tests.
- **Sync:** property-style tests for outbox replay and conflict handling.

## 5. Task file template (`docs/tasks/<id>-<slug>.md`)

```markdown
# <id> — <title>
status: todo | in-progress | review | verify | blocked | done
milestone: M<n> · deps: <ids> · branch: task/<id>-<slug>

## Goal
One paragraph: what and why.

## Context
Links to SPEC sections, DECISIONS entries, research notes, related code.

## Scope
In: … · Out: …

## Acceptance criteria
- [ ] Observable behaviour 1
- [ ] …

## Verification
Commands / steps the verifier runs, with expected results.

## Design notes
(designer / implementer)

## Review
(reviewer verdicts, numbered findings, resolution)

## Evidence
(verifier: command outputs, screenshots, preview URL)
```

## 6. Running long sessions in Claude Code

- **Start the orchestrator:** a session with a prompt like *"Act as Orchestrator per docs/FACTORY.md.
  Continue until SPEC §9 is met or you hit a human checkpoint."* Use `/loop` (no interval) so it self-paces
  and resumes; it re-reads `PLAN.md` and `LOG.md` on every wake-up instead of relying on memory.
- **Subagents:** spawn implementers with `isolation: worktree`; reviewer/verifier as fresh agents with the
  task file path and branch name as the whole brief.
- **Fan-out:** multi-agent workflows (review across dimensions, parallel tasks) only when the human has opted
  in for that run — they're token-expensive.
- **Context hygiene:** subagents report back short summaries; details go in the task file, not the chat.
- **Resumability:** if a session dies, a new one reads `LOG.md` (last entries) + task files with
  `status: in-progress` and picks up from there.

## 7. Human checkpoints (stop and ask)

- Any credential/API key/OAuth app setup (Deepgram, AI Gateway, Google, Notion, Neon, Vercel link).
- macOS permission prompts (microphone, screen & system audio recording, calendars, accessibility).
- Apple code signing, notarization, publishing a desktop release.
- Production deploys, custom domains, anything that costs money beyond the dev tier.
- Destructive ops: dropping tables, force-push, deleting data or branches not created by the factory.
- Anything that contacts real people (emails, Slack messages, invites to real addresses).
- Changing a decision in `DECISIONS.md` that the human made.
- A task blocked after 3 attempts.

When stopping: write the question at the top of `LOG.md` under `## Waiting on human`, with the exact action
needed, then continue with any other unblocked task.

## 8. Research with REA (rea.tools)

[REA — "Reverse Engineer Anything"](https://rea.tools/) (npm `rea-agents`, repo `morluto/rea`) is an MCP
server + CLI that gives the agent tools to inspect software without source: JavaScript/Electron apps
(static), native Mach-O binaries (via Hopper/Ghidra/IDA providers), SQLite databases, websites and HAR
captures. Findings come back with evidence records. It is the **Researcher's** tool — never a code source.

Setup (human checkpoint the first time, since it edits client config):
```bash
npx rea-agents@latest setup --client claude_code     # adds MCP entry + REA skill; restart Claude Code
npx -y rea-agents@latest doctor --client claude_code --json   # expect "healthy": true
```
Useful commands for Granola:
```bash
rea analyze-javascript-application /Applications/Granola.app --json   # Electron bundle structure
rea analyze /Applications/Granola.app/Contents/Resources/native/<addon>.node
rea inspect-sqlite-database <path-to-local-db> --json                # schema only, never row data
rea capabilities --json
```
Rules for research:
- Answer a specific question per run (e.g. "how is meeting detection triggered?"), write the answer as
  prose + diagrams in `research/granola/<topic>.md` with REA evidence IDs.
- Raw dumps go in `research/granola/raw/` (git-ignored). Implementers do not read `raw/`.
- Never extract or use auth tokens, never call Granola endpoints, never read the user's meeting content
  from Granola's database — schemas and structure only.

## 9. Standard subagent briefs (orchestrator copies these)

All briefs start with: *"You are the <Role> in the Oat factory. Read `CLAUDE.md`, `docs/FACTORY.md` and your
task file `docs/tasks/<file>` first. Keep your final report under 15 lines; put details in the task file."*

- **Implementer** (Agent, `isolation: worktree`): "Implement task <id> on branch `task/<id>-<slug>` (create it
  from `main`). Work only within the task's scope. Commit in small steps. Before finishing run
  `pnpm install && pnpm run ci` (the full gate; `--fast` while iterating). The compose stack is shared: `ci`
  starts it if it's down and leaves it alone if healthy; never `dev:reset`/`dev:down`/`dev:build`.
  Fill *Design notes* in the task file. Report: branch name, worktree path, what was done, check results,
  anything out of scope you touched. If review findings are attached, fix exactly those."
- **Reviewer** (fresh Agent, read-only intent): "Review branch `<branch>` against task <id>. Read the task file
  and `git diff main...<branch>` only — not the implementer's report. Check acceptance criteria, correctness,
  security/authz, clean-room, tests meaningful, scope creep, D-11 (no external calls). Write the verdict under
  *Review* in the task file **on that branch's worktree** and report `approve` or `changes` + numbered list."
- **Verifier** (fresh Agent): "In worktree `<path>` (branch `<branch>`), run every command in the task's
  *Verification* section plus the global gates (`pnpm run ci`, paste its summary table). Paste trimmed outputs into *Evidence*, commit the task file.
  UI tasks: Playwright screenshot saved under `docs/tasks/evidence/<id>/`. Report `pass` or `fail` + reasons.
  Never edit product code."
- **Researcher** (fresh Agent, REA MCP): "Answer: <one question> about /Applications/Granola.app using REA
  static analysis (MCP `mcp__rea__*`, load via ToolSearch). Rules: FACTORY §8 — structure only, no tokens, no
  network, no user content, no copying strings/prompts/code. Raw dumps → `research/granola/raw/`. Write prose
  answer with evidence IDs to `research/granola/<topic>.md`. Close REA sessions when done."

Merging: orchestrator runs `git merge --squash <branch>` on `main`, commits `<id>: <title>`, re-runs
`pnpm run ci`, then removes the worktree/branch. Merge conflicts on docs files (PLAN/LOG) are resolved by the
orchestrator; conflicts in code go back to the implementer.
