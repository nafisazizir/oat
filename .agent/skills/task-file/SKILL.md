---
name: task-file
description: Write and maintain a task brief in docs/tasks/ — the contract every later subagent (designer, implementer, reviewer, verifier) receives. Use when picking a task off docs/PLAN.md or updating one in flight.
---

# Task file

Each task gets `docs/tasks/<id>-<slug>.md`, written when the task is picked. This file *is* the brief:
subagents are given its path, not the orchestrator's memory. Keep it updated as the task moves through the
loop — status transitions, design notes, review verdicts, verification evidence all live here.

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

Rules:

- *Acceptance criteria* must be observable behaviours the verifier can check, not restatements of the goal.
- *Verification* lists runnable commands plus the global gates from `.agent/FACTORY.md` §3.
- A task that fails review or verification 3 times goes to `status: blocked` with a summary of what was
  tried.
