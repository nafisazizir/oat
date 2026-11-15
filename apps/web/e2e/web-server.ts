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
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

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
// Specs that need rows the API can't create yet (e.g. transcript segments) write them here directly.
mkdirSync(new URL('./.auth/', import.meta.url), { recursive: true });
writeFileSync(databaseUrlFile(port), db.url);
writeFileSync(mocksUrlFile(port), mocks.url);
console.log(`[e2e] database ${db.name} ready; starting next dev on :${port}`);

const child = spawn('pnpm', ['exec', 'next', 'dev', '--port', port], {
  stdio: 'inherit',
  env: {
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
  },
});

let stopping = false;
async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  await worker.stop().catch(() => undefined);
  await queue.clear().catch(() => undefined);
  redis.destroy();
  await workerDb.$client.end({ timeout: 5 }).catch(() => undefined);
  await mocks.close().catch(() => undefined);
  try {
    await db.drop();
  } catch (error) {
    console.error(`[e2e] could not drop ${db.name}:`, error);
  }
  process.exit(code);
}

process.on('SIGTERM', () => void shutdown(0));
process.on('SIGINT', () => void shutdown(0));
child.on('exit', (code) => void shutdown(code ?? 1));
