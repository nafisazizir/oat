/**
 * `pnpm --filter @oat/agents agent:start` (after `agent:build`) / `dev` (what `pnpm dev` runs): `eve start` /
 * `eve dev --no-ui` with the D-29 environment fixed *before* the Workflow world loads:
 *
 * - `WORKFLOW_POSTGRES_URL` from config (default: the compose `oat_workflow` database). Left unset,
 *   `@workflow/world-postgres` falls back to `DATABASE_URL`, i.e. the app database; pointing it at the app
 *   database is refused outright. The database is created and migrated first if needed (`world:bootstrap`,
 *   idempotent; `--no-bootstrap` skips it).
 * - `WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS=30` unless set (a killed process's runs resume in ≈ 45 s, not 8 min).
 * - `EVE_TELEMETRY_DISABLED=1` (D-11).
 * - Bound to `127.0.0.1:${OAT_AGENTS_PORT:-3100}` unless `OAT_AGENTS_HOST` says otherwise: the agents server is
 *   never public; the web app (or a private network) reaches it at `OAT_AGENTS_URL`.
 * - `start` fires schedules (the post-meeting backstop sweep, every minute); `eve dev` never does.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { agentsConfig, DEFAULT_JOB_LOCK_STALE_SECONDS, workflowDatabaseProblem } from '../env.ts';
import { bootstrapWorld, ensureDatabase } from './bootstrap-world.ts';
import { AGENTS_DIR } from './build.ts';

type Env = Record<string, string | undefined>;

/** The environment the agents server runs with; throws when the Workflow database is unusable. */
export function agentServerEnv(env: Env = process.env): Env {
  const out: Env = {
    ...env,
    WORKFLOW_POSTGRES_URL: agentsConfig(env).workflowDatabaseUrl,
    WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS:
      env.WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS?.trim() || DEFAULT_JOB_LOCK_STALE_SECONDS,
    EVE_TELEMETRY_DISABLED: '1',
  };
  const problem = workflowDatabaseProblem(out);
  if (problem) throw new Error(problem);
  return out;
}

/** `eve start|dev` arguments: the configured host (default loopback) and port. */
export function eveArgs(mode: 'start' | 'dev', env: Env = process.env): string[] {
  const host = env.OAT_AGENTS_HOST?.trim() || '127.0.0.1';
  const port = String(agentsConfig(env).port);
  return mode === 'start'
    ? ['start', '--host', host, '--port', port]
    : ['dev', '--no-ui', '--host', host, '--port', port];
}

/**
 * The repo-root `.env` (like the web app's `next.config.ts`; variables already set win). In `dev` only, a missing
 * `.env` falls back to `.env.example` (the compose stack's defaults, D-11), so a fresh checkout's `pnpm dev`
 * agrees with the web app on the service token.
 */
export function loadRootEnv(mode: 'start' | 'dev'): void {
  const env = join(AGENTS_DIR, '..', '.env');
  const example = join(AGENTS_DIR, '..', '.env.example');
  if (existsSync(env)) process.loadEnvFile(env);
  else if (mode === 'dev' && existsSync(example)) process.loadEnvFile(example);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2];
  if (mode !== 'start' && mode !== 'dev') {
    console.error('usage: serve.ts start|dev [--no-bootstrap]');
    process.exit(2);
  }
  loadRootEnv(mode);
  let env: Env;
  try {
    env = agentServerEnv();
    if (!process.argv.includes('--no-bootstrap')) {
      const url = env.WORKFLOW_POSTGRES_URL!;
      if (await ensureDatabase(url)) console.log('agents: created the workflow database');
      bootstrapWorld(url, { quiet: true });
    }
  } catch (error) {
    console.error(`agents: ${(error as Error).message}`);
    process.exit(1);
  }
  const child = spawn(join(AGENTS_DIR, 'node_modules', '.bin', 'eve'), eveArgs(mode, env), {
    cwd: AGENTS_DIR,
    env: env as NodeJS.ProcessEnv,
    stdio: 'inherit',
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
}
