# Oat

A personal AI meeting-notes app. Oat captures mic + system audio on the desktop (no meeting bot), transcribes
live, and turns your rough notes plus the transcript into clean notes, inside a Notion-like workspace with
private pages, team spaces, sharing and AI assistants.

- Start here: [`CLAUDE.md`](CLAUDE.md), then the docs it points to (`docs/SPEC.md`, `docs/PLAN.md`, ...).
- Local development setup: `docs/DEV.md` (coming in task 1.10).

## Monorepo

pnpm workspaces + Turborepo, TypeScript everywhere. Workspace globs: `apps/*`, `packages/*`, `tools/*`.

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test   # global gates
pnpm test:int                               # integration tests (*.int.test.ts)
pnpm format:check
```

Internal packages (`@oat/*`) ship TypeScript source with no build step; the apps compile them.
