/**
 * Playwright's web server: a throwaway, migrated Postgres database (`@oat/testkit`) + `next dev` on
 * `E2E_PORT`, pointed at it. Sign-ups made by e2e tests never touch the shared `oat` dev database, and
 * parallel worktrees never see each other's users. The database is dropped when Playwright stops the
 * server (SIGTERM, see `gracefulShutdown` in playwright.config.ts); a hard kill leaks it until the next
 * test run sweeps `oat_test_*` databases older than an hour.
 *
 * It also runs an in-process mocks server with the Google Calendar provider (this checkout's code, not the
 * shared container, which may predate it) and points `GOOGLE_CALENDAR_BASE_URL` at it. Its `next-week`
 * anchor keeps the fixture week upcoming whenever the tests run. The same server runs the Notion provider
 * (8.1) for `NOTION_BASE_URL`, and the LLM provider for the AI calls (`AI_BASE_URL`), slowed down
 * (`AI_MOCK_CHUNK_DELAY_MS`) so streaming UIs can be watched mid-stream (4.4).
 *
 * And the index worker (6.1/8.4), in-process against the same database, with its own Redis queue prefix and a
 * short debounce: it follows `change_log` like in production, so action items ("My tasks") and retrieval chunks
 * appear a moment after a write. Embeddings come from the in-process mock LLM.
 *
 * And the background agents (8.3): this checkout's eve app, built and started on a free port with a throwaway
 * Workflow-world database (`@oat/agents` test harness), so a meeting that ends runs the post-meeting pipeline
 * against the same database and mocks. The web app reaches it at `OAT_AGENTS_URL` with a random token.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { bootstrapWorld } from '@oat/agents/cli/bootstrap-world';
import { buildAgent, devEnv, freePort, startAgent } from '@oat/agents/post-meeting/int-server';
import { createAi } from '@oat/ai/provider';
import { createDb, migrate } from '@oat/db';
import { connectRedis, createIndexQueue, createIndexWorker, indexingConfig } from '@oat/indexing';
import { gcalProvider, llmProvider, notionProvider, startMocks } from '@oat/mocks';
import { createTestDatabase } from '@oat/testkit';

import { databaseUrlFile, mocksUrlFile } from './paths';

const port = process.env.E2E_PORT ?? '3000';
// A `.next/dev` left by an earlier `next dev` whose sources changed since (formatting, edits) sometimes
// made the new dev server rebuild and full-reload every page in a loop (1.4/1.6/3.3 notes); always
// start e2e from a clean dev cache. That is the cache of the dist dir this server uses
// (`OAT_NEXT_DIST_DIR`, e.g. the desktop e2e's `.next-desktop-e2e`), never another server's.
const distDir = process.env.OAT_NEXT_DIST_DIR || '.next';
rmSync(new URL(`../${distDir}/dev`, import.meta.url), { recursive: true, force: true });
const db = await createTestDatabase();
await migrate(db.url);
const mocks = await startMocks({
  providers: [
    () => gcalProvider({ anchor: 'next-week' }),
    () => notionProvider(),
    () => llmProvider(),
  ],
});
const workerDb = createDb(db.url, { max: 4 });
const redis = await connectRedis(indexingConfig().redisUrl);
const queue = createIndexQueue(redis, { prefix: `oat-e2e:idx:${randomUUID()}`, debounceMs: 200 });
const worker = createIndexWorker({
  db: workerDb,
  queue,
  embeddingModel: createAi({ env: { AI_BASE_URL: `${mocks.url}/llm/v1` } }).getEmbeddingModel(),
  pollMs: 200,
  logger: {
    info() {},
    error: (message, data) => console.error(`[e2e indexer] ${message}`, data ?? ''),
  },
});
worker.start();
// The agents server (8.3): its own Workflow-world database, this checkout's build.
const worldDb = await createTestDatabase();
bootstrapWorld(worldDb.url, { quiet: true });
buildAgent();
const agentsToken = randomBytes(32).toString('base64url');
const agents = await startAgent(
  {
    ...devEnv(),
    DATABASE_URL: db.url,
    WORKFLOW_POSTGRES_URL: worldDb.url,
    REDIS_URL: indexingConfig().redisUrl,
    MOCKS_URL: mocks.url,
    AI_BASE_URL: `${mocks.url}/llm/v1`,
    AI_GATEWAY_API_KEY: '',
    NOTION_BASE_URL: `${mocks.url}/notion`,
    NOTION_OAUTH_CLIENT_ID: '',
    NOTION_OAUTH_CLIENT_SECRET: '',
    BETTER_AUTH_URL: `http://localhost:${port}`,
    OAT_AGENTS_TOKEN: agentsToken,
    // 7.5: auto-enhance needs 60 s of speech in production; e2e transcripts (fixtures) are a few seconds.
    OAT_AUTO_ENHANCE_MIN_SPEECH_MS: '5000',
    // A suite that watches the pipeline's steps in a header (the desktop's, 7.5) slows the agents' mock LLM.
    ...(process.env.OAT_E2E_AGENTS_AI_DELAY_MS
      ? { AI_MOCK_CHUNK_DELAY_MS: process.env.OAT_E2E_AGENTS_AI_DELAY_MS }
      : {}),
  },
  await freePort(),
);
// Specs that need rows the API can't create yet (e.g. transcript segments) write them here directly.
mkdirSync(new URL('./.auth/', import.meta.url), { recursive: true });
writeFileSync(databaseUrlFile(port), db.url);
writeFileSync(mocksUrlFile(port), mocks.url);
/**
 * `OAT_E2E_PROD=1` (`pnpm e2e:prod`): a production build (`next build` into its own dist dir) served by
 * `next start`, for what only production shows (9.3: the share page's strict CSP without `'unsafe-eval'`).
 * Production doesn't fall back to `.env.example` by itself (next.config.ts), so the dev defaults are loaded
 * here; real variables and the overrides below still win.
 */
const prod = process.env.OAT_E2E_PROD === '1';
if (prod) {
  const example = new URL('../../../.env.example', import.meta.url);
  const env = new URL('../../../.env', import.meta.url);
  process.loadEnvFile(existsSync(env) ? env : example);
}
console.log(
  `[e2e] database ${db.name} ready; starting ${prod ? 'next build + start' : 'next dev'} on :${port}`,
);

const serverEnv = {
  ...process.env,
  DATABASE_URL: db.url,
  // Own rate-limit counters: parallel e2e servers share one dev Redis and all clients are 127.0.0.1.
  OAT_RATE_LIMIT_NAMESPACE: `e2e-${db.name}`,
  BETTER_AUTH_URL: `http://localhost:${port}`,
  GOOGLE_CALENDAR_BASE_URL: `${mocks.url}/gcal`,
  AI_BASE_URL: `${mocks.url}/llm/v1`,
  AI_MOCK_CHUNK_DELAY_MS: process.env.AI_MOCK_CHUNK_DELAY_MS ?? '60',
  NOTION_BASE_URL: `${mocks.url}/notion`,
  NOTION_OAUTH_CLIENT_ID: '',
  NOTION_OAUTH_CLIENT_SECRET: '',
  OAT_AGENTS_URL: agents.url,
  OAT_AGENTS_TOKEN: agentsToken,
};

let child: ChildProcess | undefined;
let stopping = false;
async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child!.once('exit', resolve));
  }
  await agents.stop().catch(() => undefined);
  await worker.stop().catch(() => undefined);
  await queue.clear().catch(() => undefined);
  redis.destroy();
  await workerDb.$client.end({ timeout: 5 }).catch(() => undefined);
  await mocks.close().catch(() => undefined);
  for (const each of [db, worldDb]) {
    try {
      await each.drop();
    } catch (error) {
      console.error(`[e2e] could not drop ${each.name}:`, error);
    }
  }
  process.exit(code);
}

process.on('SIGTERM', () => void shutdown(0));
process.on('SIGINT', () => void shutdown(0));

/** Runs `next <args>` with the server env; the last one started is what `shutdown` stops. */
function next(args: string[]): ChildProcess {
  child = spawn('pnpm', ['exec', 'next', ...args], { stdio: 'inherit', env: serverEnv });
  return child;
}

if (prod) {
  const code = await new Promise<number | null>((resolve) =>
    next(['build']).once('exit', (exitCode) => resolve(exitCode)),
  );
  if (code !== 0) {
    console.error('[e2e] next build failed');
    await shutdown(1);
  }
}
next([prod ? 'start' : 'dev', '--port', port]).on('exit', (code) => void shutdown(code ?? 1));
