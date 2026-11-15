/**
 * `pnpm --filter @oat/indexing worker` (also part of `pnpm dev`, and the compose `worker` service): follows
 * `change_log` and keeps `chunk` up to date. Env: DATABASE_URL, REDIS_URL, AI_* / MOCKS_URL (embeddings via
 * `@oat/ai`), OAT_INDEX_QUEUE_PREFIX, OAT_INDEX_DEBOUNCE_MS, OAT_INDEX_CONCURRENCY.
 */
// The provider module, not the `@oat/ai` barrel: the barrel also loads prompt/context code (and the Markdown
// parser) that the worker never needs.
import { getEmbeddingModel } from '@oat/ai/provider';
import { createDb } from '@oat/db';
import { databaseUrl, loadRootEnv, redactUrl } from '@oat/db/env';
import { indexingConfig } from '../env.ts';
import { connectRedis, createIndexQueue } from '../queue.ts';
import { createIndexWorker, type WorkerLogger } from '../worker.ts';

loadRootEnv();
const config = indexingConfig();
const url = databaseUrl();

const logger: WorkerLogger = {
  info: (message, data) => console.log(`[indexer] ${message}`, data ? JSON.stringify(data) : ''),
  error: (message, data) => console.error(`[indexer] ${message}`, data ? JSON.stringify(data) : ''),
};

const db = createDb(url, { max: config.concurrency + 2 });
const redis = await connectRedis(config.redisUrl, (m) => logger.error(m));
const queue = createIndexQueue(redis, { prefix: config.prefix, debounceMs: config.debounceMs });
const embeddingModel = getEmbeddingModel();
const worker = createIndexWorker({
  db,
  queue,
  embeddingModel,
  maxChunksPerDocument: config.maxChunksPerDocument,
  concurrency: config.concurrency,
  logger,
});

worker.start();
logger.info('started', {
  database: redactUrl(url),
  queue: config.prefix,
  model: `${embeddingModel.provider}/${embeddingModel.modelId}`,
  concurrency: config.concurrency,
  debounceMs: config.debounceMs,
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info('stopping', { signal });
  await worker.stop();
  redis.destroy();
  await db.$client.end({ timeout: 5 });
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
