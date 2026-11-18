---
name: rea-research
description: Research Granola's internals with REA (rea.tools) — static analysis only, under strict clean-room rules. Use when a task needs to answer "how does Granola do X?".
---

# Research with REA (rea.tools)

[REA — "Reverse Engineer Anything"](https://rea.tools/) (npm `rea-agents`, repo `morluto/rea`) is an MCP
server + CLI that gives the agent tools to inspect software without source: JavaScript/Electron apps
(static), native Mach-O binaries (via Hopper/Ghidra/IDA providers), SQLite databases, websites and HAR
captures. Findings come back with evidence records. It is the **Researcher's** tool — never a code source.

Setup (human checkpoint the first time, since it edits client config):

```bash
npx rea-agents@latest setup --client <your-agent-client>   # e.g. claude_code; `rea setup --help` lists clients
npx -y rea-agents@latest doctor --client <your-agent-client> --json   # expect "healthy": true
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
