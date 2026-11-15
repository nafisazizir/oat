import { describe, expect, it } from 'vitest';

import { agentServerEnv } from './cli/serve.ts';
import {
  agentsConfig,
  DEFAULT_DATABASE_URL,
  DEFAULT_REDIS_URL,
  DEFAULT_AGENTS_PORT,
  DEFAULT_WORKFLOW_DATABASE_URL,
  DEV_JOBS_TOKEN,
  workflowDatabaseProblem,
} from './env.ts';

const TOKEN = 'a'.repeat(32);
const OLD = 'b'.repeat(40);

describe('agentsConfig', () => {
  it('defaults to the compose stack, with the Workflow world in its own database', () => {
    expect(agentsConfig({})).toEqual({
      databaseUrl: DEFAULT_DATABASE_URL,
      workflowDatabaseUrl: DEFAULT_WORKFLOW_DATABASE_URL,
      redisUrl: DEFAULT_REDIS_URL,
      port: DEFAULT_AGENTS_PORT,
      jobsTokens: [],
      appUrl: 'http://localhost:3000',
      busyRetryMs: 5_000,
      // Beyond D-26's 3-minute staleness.
      busyDeadlineMs: 4 * 60_000,
      stuckAfterMs: 10 * 60_000,
      enhanceStaleMs: undefined,
      enhanceTimeoutMs: undefined,
    });
  });

  it('reads env, treating blank values as unset', () => {
    const config = agentsConfig({
      DATABASE_URL: 'postgres://a/app',
      WORKFLOW_POSTGRES_URL: 'postgres://a/wf',
      REDIS_URL: '  ',
      OAT_AGENTS_PORT: '4100',
      BETTER_AUTH_URL: 'https://oat.example/',
      OAT_AGENTS_ENHANCE_STALE_MS: '10000',
      OAT_AGENTS_BUSY_RETRY_MS: '1000',
    });
    expect(config).toMatchObject({
      databaseUrl: 'postgres://a/app',
      workflowDatabaseUrl: 'postgres://a/wf',
      redisUrl: DEFAULT_REDIS_URL,
      port: 4100,
      appUrl: 'https://oat.example',
      enhanceStaleMs: 10_000,
      busyRetryMs: 1_000,
      busyDeadlineMs: 70_000, // follows a shortened staleness
    });
    expect(() => agentsConfig({ OAT_AGENTS_BUSY_RETRY_MS: '-1' })).toThrow(/positive integer/);
  });

  it('accepts the current and the previous jobs token, only when ≥ 32 characters', () => {
    expect(
      agentsConfig({ OAT_AGENTS_TOKEN: ` ${TOKEN} `, OAT_AGENTS_TOKEN_PREVIOUS: OLD }).jobsTokens,
    ).toEqual([TOKEN, OLD]);
    expect(
      agentsConfig({ OAT_AGENTS_TOKEN: 'short', OAT_AGENTS_TOKEN_PREVIOUS: OLD }).jobsTokens,
    ).toEqual([OLD]);
    expect(agentsConfig({ OAT_AGENTS_TOKEN: '' }).jobsTokens).toEqual([]);
  });

  it('refuses the dev token in production', () => {
    expect(agentsConfig({ OAT_AGENTS_TOKEN: DEV_JOBS_TOKEN }).jobsTokens).toEqual([DEV_JOBS_TOKEN]);
    expect(
      agentsConfig({ OAT_AGENTS_TOKEN: DEV_JOBS_TOKEN, NODE_ENV: 'production' }).jobsTokens,
    ).toEqual([]);
  });
});

describe('Workflow database (never the app database)', () => {
  it('is a problem when unset or equal to DATABASE_URL', () => {
    expect(workflowDatabaseProblem({})).toMatch(/not set/);
    expect(
      workflowDatabaseProblem({
        DATABASE_URL: 'postgres://u:p@h:5432/oat',
        WORKFLOW_POSTGRES_URL: 'postgres://x:y@h:5432/oat',
      }),
    ).toMatch(/app database/);
    expect(
      workflowDatabaseProblem({
        DATABASE_URL: 'postgres://u:p@h:5432/oat',
        WORKFLOW_POSTGRES_URL: 'postgres://u:p@h:5432/oat_workflow',
      }),
    ).toBeNull();
  });

  it('the server env sets the world URL from config and the 30 s lock-stale window', () => {
    const env = agentServerEnv({ DATABASE_URL: DEFAULT_DATABASE_URL });
    expect(env.WORKFLOW_POSTGRES_URL).toBe(DEFAULT_WORKFLOW_DATABASE_URL);
    expect(env.WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS).toBe('30');
    expect(env.EVE_TELEMETRY_DISABLED).toBe('1');
    expect(() =>
      agentServerEnv({
        DATABASE_URL: DEFAULT_DATABASE_URL,
        WORKFLOW_POSTGRES_URL: DEFAULT_DATABASE_URL,
      }),
    ).toThrow(/app database/);
  });
});
