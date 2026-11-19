# Oat — Claude Code entry point

All agent instructions are tool-agnostic: read [`AGENTS.md`](AGENTS.md), then `.agent/FACTORY.md` and the
docs it points to. Reusable procedures live in `.agent/skills/`.

Claude Code specifics:

- Self-pace long orchestrator runs with `/loop`; spawn implementers with `isolation: worktree`.
- REA setup uses `--client claude_code` (see `.agent/skills/rea-research/SKILL.md`).
