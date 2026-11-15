/**
 * `pnpm --filter @oat/agents agent:start` / `agent:dev`: runs `eve start` / `eve dev --no-ui` with the D-29
 * environment fixed *before* the Workflow world loads:
 *
 * - `WORKFLOW_POSTGRES_URL` from config (default: the compose `oat_workflow` database). Left unset,
 *   `@workflow/world-postgres` falls back to `DATABASE_URL`, i.e. the app database; pointing it at the app
 *   database is refused outright.
 * - `WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS=30` unless set (a killed process's runs resume in ≈ 45 s, not 8 min).
 * - `EVE_TELEMETRY_DISABLED=1` (D-11).
 * - Bound to `127.0.0.1` unless `OAT_AGENTS_HOST` says otherwise: the agents server is never public; the web app
 *   (or a private network) reaches it.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { agentsConfig, DEFAULT_JOB_LOCK_STALE_SECONDS, workflowDatabaseProblem } from '../env.ts';
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2];
  if (mode !== 'start' && mode !== 'dev') {
    console.error('usage: serve.ts start|dev');
    process.exit(2);
  }
  let env: Env;
  try {
    env = agentServerEnv();
  } catch (error) {
    console.error(`agents: ${(error as Error).message}`);
    process.exit(1);
  }
  const host = process.env.OAT_AGENTS_HOST?.trim() || '127.0.0.1';
  const args =
    mode === 'start'
      ? ['start', '--host', host, '--no-schedules']
      : ['dev', '--no-ui', '--host', host];
  const child = spawn(join(AGENTS_DIR, 'node_modules', '.bin', 'eve'), args, {
    cwd: AGENTS_DIR,
    env: env as NodeJS.ProcessEnv,
    stdio: 'inherit',
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
}
