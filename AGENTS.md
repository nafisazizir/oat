# Oat — agent entry point

Oat is a personal, AI meeting-notes app inspired by Granola: it captures mic + system audio on the desktop
(no meeting bot), transcribes live, and turns your rough notes + the transcript into clean notes, inside a
Notion-like workspace with private pages, team spaces, sharing and AI assistants.

**Every session — human-started or autonomous, whatever agent tool it runs on — starts here.** Read in
this order:

1. `.agent/FACTORY.md` — how work is done: the loop, roles, gates, when to stop and ask.
2. `docs/SPEC.md` — what we are building and the decisions already made.
3. `docs/PLAN.md` — milestones and the task board. Pick work from here.
4. `docs/DECISIONS.md` — decision log. Don't re-litigate a decision without writing a new entry.
5. `research/granola/` — what we know about how Granola works (reference only, see clean-room rules).
6. `docs/IDEAS.md` — backlog. Not in scope unless promoted into `PLAN.md`.

`.agent/skills/` holds the reusable procedures the factory uses — load the matching one when you write a
task brief (`task-file`), spawn a subagent (`subagent-briefs`) or research Granola (`rea-research`).

## Hard rules

- State lives on disk, not in conversation memory: update `docs/PLAN.md`, the task file in `docs/tasks/`,
  and `docs/LOG.md` as you go. A fresh session must be able to resume from the files alone.
- Clean room: never copy Granola's code, prompts, strings, icons or visual identity. Research produces
  descriptions of *behaviour and architecture* in `research/granola/`; implementation works from those.
- Never read, use, or exfiltrate Granola auth tokens or call Granola's servers.
- Stuck on "how does Granola do X?" at any point → check `research/granola/` first, then have the
  orchestrator spawn a Researcher that uses REA (https://rea.tools, MCP + CLI) to answer that one question.
  See `.agent/FACTORY.md` §2 "Research on demand" and §8.
- Stop and ask the human for anything on the "Human checkpoints" list in `.agent/FACTORY.md`.
- Verify before claiming done. "Done" means the task's acceptance checks ran and passed, with evidence
  recorded in the task file.
- Every change must keep affected unit, integration, web E2E and desktop E2E tests in sync with the intended
  behavior. GitHub runs only the fast tier: run the relevant local gates and report anything you could not
  run. Update any stale tests or documentation you notice; do not hide a product regression by weakening a test.

## Stack at a glance

pnpm + Turborepo · TypeScript everywhere · Electron + Vite (desktop) · Swift sidecar (audio capture) ·
Next.js App Router on Vercel (web + API) · Postgres (Neon) + Drizzle · SQLite on desktop · Better Auth ·
TipTap editor (JSON canonical, Markdown derived) · shadcn/ui + Tailwind tokens · Vercel AI SDK via AI Gateway ·
Deepgram streaming STT (behind a provider interface) · eve for durable background agents (from M8).
