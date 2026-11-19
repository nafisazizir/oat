---
name: subagent-briefs
description: Standard briefs the orchestrator copies when spawning implementer, reviewer, verifier and researcher subagents. Use whenever dispatching a factory subagent in any agent tool.
---

# Standard subagent briefs

All briefs start with: *"You are the <Role> in the Oat factory. Read `AGENTS.md`, `.agent/FACTORY.md` and
your task file `docs/tasks/<file>` first. Keep your final report under 15 lines; put details in the task
file."*

- **Implementer** (subagent in an isolated working copy — `git worktree`, or your tool's isolation): "Implement task <id> on branch `task/<id>-<slug>` (create it
  from `main`). Work only within the task's scope. Commit in small steps. Before finishing run
  `pnpm install && pnpm run ci` (the full gate; `--fast` while iterating). The compose stack is shared: `ci`
  starts it if it's down and leaves it alone if healthy; never `dev:reset`/`dev:down`/`dev:build`.
  Fill *Design notes* in the task file. Report: branch name, worktree path, what was done, check results,
  anything out of scope you touched. If review findings are attached, fix exactly those."
- **Reviewer** (fresh subagent, read-only intent): "Review branch `<branch>` against task <id>. Read the task file
  and `git diff main...<branch>` only — not the implementer's report. Check acceptance criteria, correctness,
  security/authz, clean-room, tests meaningful, scope creep, D-11 (no external calls). Write the verdict under
  *Review* in the task file **on that branch's worktree** and report `approve` or `changes` + numbered list."
- **Verifier** (fresh subagent): "In worktree `<path>` (branch `<branch>`), run every command in the task's
  *Verification* section plus the global gates (`pnpm run ci`, paste its summary table). Paste trimmed outputs into *Evidence*, commit the task file.
  UI tasks: Playwright screenshot saved under `docs/tasks/evidence/<id>/`. Report `pass` or `fail` + reasons.
  Never edit product code."
- **Researcher** (fresh subagent with the REA tools): "Answer: <one question> about /Applications/Granola.app using REA
  static analysis (MCP `mcp__rea__*`, load via ToolSearch). Rules: `.agent/skills/rea-research` — structure
  only, no tokens, no network, no user content, no copying strings/prompts/code. Raw dumps →
  `research/granola/raw/`. Write prose answer with evidence IDs to `research/granola/<topic>.md`. Close REA
  sessions when done."

Merging: orchestrator runs `git merge --squash <branch>` on `main`, commits `<id>: <title>`, re-runs
`pnpm run ci`, then removes the worktree/branch. Merge conflicts on docs files (PLAN/LOG) are resolved by the
orchestrator; conflicts in code go back to the implementer.

**Migrations in parallel branches:** Drizzle migrations are numbered. Before handing back, an implementer
merges current `main` and regenerates/renumbers its migration after main's latest (journal must be
consistent: `pnpm --filter @oat/db db:generate` reports no drift). Branches with migrations merge one at a
time; the next one re-merges `main` before its squash-merge.
