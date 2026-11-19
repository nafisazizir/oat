# `.agent/` — tool-agnostic agent workflow

Everything an agent needs to work on Oat, independent of which agent tool is running it.

- `FACTORY.md` — how work is done: the loop, roles, global gates, when to stop and ask a human.
- `skills/<name>/SKILL.md` — reusable procedures loaded on demand:
  - `task-file` — writing the `docs/tasks/` brief.
  - `subagent-briefs` — standard briefs for spawned workers, plus merge/migration rules.
  - `rea-research` — clean-room research on Granola with REA.

Entry points: `AGENTS.md` (root, every agent) → this directory → `docs/` (SPEC, PLAN, DECISIONS, LOG, DEV).
Tool-specific mechanics live in that tool's own entry file (`CLAUDE.md` for Claude Code) — not here.
