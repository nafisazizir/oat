/**
 * Runtime dependencies of the post-meeting steps, built on first use and kept for the life of the process
 * (eve runs steps in the app runtime, so module state is per server process; nothing here is workflow state).
 * Every external service comes from env (D-11): the compose Postgres/Redis and the mocks in dev and tests.
 */
import { getAi } from '@oat/ai/provider';
import { type RateLimiter, secretSourceFromEnv } from '@oat/auth';
import { createDb, type Db } from '@oat/db';
import { resolveNotionConfig } from '@oat/integrations-notion';
import { createRedisBroker } from '@oat/services/enhance/broker';
import type { EnhanceDeps } from '@oat/services/enhance/service';
import type { NotionDeps } from '@oat/services/notion';

import { type AgentsConfig, agentsConfig } from '../env.ts';

export interface StepContext {
  config: AgentsConfig;
  db: Db;
  enhance: Omit<EnhanceDeps, 'runInBackground'>;
  notion: NotionDeps;
}

const unlimited: RateLimiter = {
  hit: async () => ({ allowed: true, count: 1, retryAfter: 0 }),
  close: async () => {},
};

let current: StepContext | undefined;

export function stepContext(env: Record<string, string | undefined> = process.env): StepContext {
  if (current) return current;
  const config = agentsConfig(env);
  const db = createDb(config.databaseUrl, { max: 4 });
  // The stored Notion token is decrypted with the auth secret config, built from env like the web app's
  // Better Auth instance builds it (`BETTER_AUTH_SECRET` / `BETTER_AUTH_SECRETS`); no auth instance here.
  let secrets: ReturnType<typeof secretSourceFromEnv> | undefined;
  const ctx: StepContext = {
    config,
    db,
    enhance: {
      broker: createRedisBroker(config.redisUrl),
      model: () => {
        const ai = getAi();
        return { model: ai.getModel('enhance'), id: ai.models.enhance };
      },
      logError: (message, error) => console.error(`[post-meeting] ${message}`, error),
      // D-26's values unless a test shortens them (the web app and the agents must agree in production).
      ...(config.enhanceStaleMs ? { staleAfterMs: config.enhanceStaleMs } : {}),
      ...(config.enhanceTimeoutMs ? { timeoutMs: config.enhanceTimeoutMs } : {}),
    },
    notion: {
      db,
      auth: {
        get $context() {
          secrets ??= secretSourceFromEnv(env);
          return secrets.$context;
        },
      },
      config: resolveNotionConfig(env),
      appUrl: config.appUrl,
      // Signs the interactive OAuth state cookie; the pipeline never connects, so any value works.
      stateSecret: 'agents-do-not-connect',
      // The per-user send limit protects the interactive button. Pipeline pushes are bounded by the workflow
      // (one per run, plus busy retries until the deadline); counting those retries would turn a held lease
      // into `rate_limited`.
      rateLimiter: unlimited,
    },
  };
  current = ctx;
  return ctx;
}

/** Closes the connections (tests that run the steps in-process). */
export async function closeStepContext(): Promise<void> {
  const ctx = current;
  current = undefined;
  if (!ctx) return;
  await ctx.enhance.broker.close().catch(() => undefined);
  await ctx.db.$client.end();
}
