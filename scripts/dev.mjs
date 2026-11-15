#!/usr/bin/env node
// Dev stack helper behind `pnpm dev:up | dev:build | dev:down | dev:reset | dev:logs | dev:ps`
// (D-11, docs/DEV.md).
// Plain Node (no shell-isms) so it behaves the same on macOS and Linux. Extra args are passed to compose,
// e.g. `pnpm dev:logs mocks` or `pnpm dev:up postgres`.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const commands = {
  // The stack is shared by every worktree, so `up` never rebuilds: it builds the local images
  // (postgres/oauth/mocks) only if they don't exist yet and leaves running, healthy containers alone.
  up: ['up', '--detach', '--wait'],
  // Rebuilds the local images from *this* checkout and recreates what changed. Run it from the main
  // checkout (after merging changes to docker/ or tools/mocks), not from a task worktree.
  build: ['up', '--detach', '--wait', '--build'],
  down: ['down', '--remove-orphans'],
  // Dev data only: drops the named volumes (Postgres, Redis, Mailpit).
  reset: ['down', '--volumes', '--remove-orphans'],
  logs: ['logs', '--follow', '--tail', '200'],
  ps: ['ps', '--all'],
};

const [command, ...extra] = process.argv.slice(2);
if (!command || !(command in commands)) {
  console.error(
    `usage: node scripts/dev.mjs <${Object.keys(commands).join('|')}> [compose args...]`,
  );
  process.exit(2);
}

function compose(args) {
  const result = spawnSync('docker', ['compose', ...args], { cwd: root, stdio: 'inherit' });
  if (result.error) {
    const missing = /** @type {NodeJS.ErrnoException} */ (result.error).code === 'ENOENT';
    console.error(
      missing
        ? 'dev: `docker` not found. Install Docker Desktop (or Docker Engine + compose plugin) and retry.'
        : `dev: failed to run docker compose: ${result.error.message}`,
    );
    return 1;
  }
  return result.status ?? 1;
}

const starts = command === 'up' || command === 'build';
if (starts) {
  const env = join(root, '.env');
  if (!existsSync(env)) {
    copyFileSync(join(root, '.env.example'), env);
    console.log('dev: created .env from .env.example');
  }
}

const status = compose([...commands[command], ...extra]);
if (starts && status !== 0) {
  console.error(
    '\ndev: stack did not become healthy. Check `pnpm dev:ps` and `pnpm dev:logs <service>`;' +
      ' port clashes and fixes are in docs/DEV.md#troubleshooting.',
  );
}
if (starts && status === 0) compose(['ps']);
process.exit(status);
