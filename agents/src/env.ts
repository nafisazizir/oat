/** Agents runtime configuration from the environment (`.env.example`, docs/tasks/8.2-eve-evaluation.md, D-29). */

type Env = Record<string, string | undefined>;

const value = (env: Env, name: string) => env[name]?.trim() || undefined;

/** The compose Postgres (D-11): the app database and, next to it, the Workflow world's own database. */
export const DEFAULT_DATABASE_URL = 'postgres://oat:oat@localhost:54329/oat';
export const DEFAULT_WORKFLOW_DATABASE_URL = 'postgres://oat:oat@localhost:54329/oat_workflow';
export const DEFAULT_REDIS_URL = 'redis://localhost:63790';
export const DEFAULT_RUN_LOG_PREFIX = 'oat:agents';
/**
 * D-29: a process that died mid-delivery holds its job lock until this window passes (the world's default is
 * 300 s, Graphile Worker's own 4 h). 30 s is well above the world's lock renewal interval, so a long LLM step
 * of a live worker is never taken over.
 */
export const DEFAULT_JOB_LOCK_STALE_SECONDS = '30';
/** The `/jobs/*` service token must be at least this long (≥ 32 random bytes, D-29). */
export const MIN_JOBS_TOKEN_LENGTH = 32;
/** The dev default in `.env.example`; refused with `NODE_ENV=production`. */
export const DEV_JOBS_TOKEN = 'oat-dev-agents-token-not-for-production-0123456789';

/** D-26: an enhancement still `generating` after 3 min is stale (the web app's `ENHANCE_STALE_MS`). */
const D26_STALE_MS = 3 * 60_000;

export interface AgentsConfig {
  databaseUrl: string;
  /**
   * `WORKFLOW_POSTGRES_URL`: where `@workflow/world-postgres` keeps runs, steps, streams and its Graphile
   * Worker queue. A database of its own, never the app database (unset, the world would fall back to
   * `DATABASE_URL`; `src/cli/serve.ts` therefore always sets it, and the jobs route refuses to run without it).
   */
  workflowDatabaseUrl: string;
  redisUrl: string;
  /** `OAT_AGENTS_RUN_LOG_PREFIX`: Redis prefix of the post-meeting run log. */
  runLogPrefix: string;
  /**
   * Accepted bearer tokens for `/jobs/*`: `OAT_AGENTS_TOKEN` and, during a rotation, `OAT_AGENTS_TOKEN_PREVIOUS`.
   * Values shorter than {@link MIN_JOBS_TOKEN_LENGTH} (and the dev token in production) are dropped, so a
   * misconfigured deployment answers 503 instead of accepting a weak token.
   */
  jobsTokens: string[];
  /** Public origin of the web app (links back to notes in Notion pages). */
  appUrl: string;
  /** How long a step waits before looking again at a note someone else is enhancing / pushing. */
  busyRetryMs: number;
  /** After this long busy, the run fails (beyond D-26's staleness, so a crashed run is always taken over). */
  busyDeadlineMs: number;
  /** Test knobs only (`OAT_AGENTS_ENHANCE_STALE_MS`/`…_TIMEOUT_MS`): in production the web app's D-26 values. */
  enhanceStaleMs: number | undefined;
  enhanceTimeoutMs: number | undefined;
}

function positiveInt(env: Env, name: string): number | undefined {
  const raw = value(env, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
}

export function agentsConfig(env: Env = process.env): AgentsConfig {
  const production = env.NODE_ENV === 'production';
  const tokens = [value(env, 'OAT_AGENTS_TOKEN'), value(env, 'OAT_AGENTS_TOKEN_PREVIOUS')].filter(
    (t): t is string =>
      t !== undefined && t.length >= MIN_JOBS_TOKEN_LENGTH && !(production && t === DEV_JOBS_TOKEN),
  );
  const enhanceStaleMs = positiveInt(env, 'OAT_AGENTS_ENHANCE_STALE_MS');
  return {
    databaseUrl: value(env, 'DATABASE_URL') ?? DEFAULT_DATABASE_URL,
    workflowDatabaseUrl: value(env, 'WORKFLOW_POSTGRES_URL') ?? DEFAULT_WORKFLOW_DATABASE_URL,
    redisUrl: value(env, 'REDIS_URL') ?? DEFAULT_REDIS_URL,
    runLogPrefix: value(env, 'OAT_AGENTS_RUN_LOG_PREFIX') ?? DEFAULT_RUN_LOG_PREFIX,
    jobsTokens: [...new Set(tokens)],
    appUrl: (value(env, 'BETTER_AUTH_URL') ?? 'http://localhost:3000').replace(/\/+$/, ''),
    busyRetryMs: positiveInt(env, 'OAT_AGENTS_BUSY_RETRY_MS') ?? 5_000,
    busyDeadlineMs:
      positiveInt(env, 'OAT_AGENTS_BUSY_DEADLINE_MS') ?? (enhanceStaleMs ?? D26_STALE_MS) + 60_000,
    enhanceStaleMs,
    enhanceTimeoutMs: positiveInt(env, 'OAT_AGENTS_ENHANCE_TIMEOUT_MS'),
  };
}

/**
 * Why the Workflow world's database is unusable, or `null`: unset (the world would silently use the app DB)
 * or the same database as the app.
 */
export function workflowDatabaseProblem(env: Env = process.env): string | null {
  const url = value(env, 'WORKFLOW_POSTGRES_URL');
  if (!url)
    return 'WORKFLOW_POSTGRES_URL is not set (the Workflow world would use the app database)';
  const app = new URL(value(env, 'DATABASE_URL') ?? DEFAULT_DATABASE_URL);
  const wf = new URL(url);
  if (app.host === wf.host && app.pathname === wf.pathname) {
    return 'WORKFLOW_POSTGRES_URL points at the app database; give the Workflow world its own database';
  }
  return null;
}
