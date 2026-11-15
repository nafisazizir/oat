#!/usr/bin/env node
// Dev stack helper behind `pnpm dev:up | dev:build | dev:down | dev:reset | dev:logs | dev:ps` and
// `pnpm dev:app | dev:app:stop` (D-11, docs/DEV.md).
// Plain Node (no shell-isms) so it behaves the same on macOS and Linux. Extra args are passed to compose,
// e.g. `pnpm dev:logs mocks` or `pnpm dev:up postgres`.
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {Record<string, string[] | string[][]>} One compose invocation, or several run in order. */
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
  // Profile `app` (1.9): builds the web + migrate (+ 6.1 index worker, 8.3 agents) images from *this*
  // checkout (only those: the shared images are never rebuilt here), then starts web, worker and agents.
  // Compose brings up their dependencies, runs the one-shot migrate, and recreates a container only if its
  // image or definition changed. Waits until every started service is healthy.
  app: [
    ['--profile', 'app', 'build', 'migrate', 'web', 'worker', 'agents'],
    ['--profile', 'app', 'up', '--detach', '--wait', 'web', 'worker', 'agents'],
  ],
  // Stops and removes just the app containers (frees :3000); the shared stack keeps running.
  'app:stop': ['--profile', 'app', 'rm', '--stop', '--force', 'web', 'worker', 'agents', 'migrate'],
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

const starts = command === 'up' || command === 'build' || command === 'app';
if (starts) {
  const env = join(root, '.env');
  const example = join(root, '.env.example');
  if (!existsSync(env)) {
    copyFileSync(example, env);
    console.log('dev: created .env from .env.example');
  } else {
    // Keys added to .env.example after .env was created would otherwise be missing (and the app's env
    // validation fails). Append them with their example values; never touch keys already in .env.
    const keysIn = (text) =>
      new Set(
        [...text.matchAll(/^\s*([A-Z0-9_]+)\s*=/gm)].map((m) => /** @type {string} */ (m[1])),
      );
    const current = keysIn(readFileSync(env, 'utf8'));
    const missing = readFileSync(example, 'utf8')
      .split('\n')
      .filter((line) => {
        const key = /^\s*([A-Z0-9_]+)\s*=/.exec(line)?.[1];
        return key !== undefined && !current.has(key);
      });
    if (missing.length > 0) {
      appendFileSync(env, `\n# Added by dev:up from .env.example\n${missing.join('\n')}\n`);
      console.log(`dev: added ${missing.length} new key(s) from .env.example to .env`);
    }
  }
}

const spec = commands[command];
const steps = Array.isArray(spec[0])
  ? /** @type {string[][]} */ (spec)
  : [/** @type {string[]} */ (spec)];
let status = 0;
for (const [index, args] of steps.entries()) {
  // Extra args go to the last step (e.g. `pnpm dev:app --force-recreate`).
  status = compose(index === steps.length - 1 ? [...args, ...extra] : args);
  if (status !== 0) break;
}
if (starts && status !== 0) {
  console.error(
    '\ndev: stack did not become healthy. Check `pnpm dev:ps` and `pnpm dev:logs <service>`;' +
      ' port clashes and fixes are in docs/DEV.md#troubleshooting.',
  );
}
if (starts && status === 0) compose(command === 'app' ? ['--profile', 'app', 'ps'] : ['ps']);
process.exit(status);
