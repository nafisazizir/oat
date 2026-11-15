/**
 * `pnpm --filter @oat/db index:backfill` (= `pnpm --filter @oat/indexing backfill`): (re-)indexes every
 * document of `DATABASE_URL`. Idempotent; unchanged chunks are not re-embedded.
 *
 *   --workspace <id>   only one workspace
 *   --enqueue          push `document:<id>` jobs to the index queue (running workers do the work)
 *   --concurrency <n>  documents at once when inline (default 4)
 */
import { parseArgs } from 'node:util';
// The provider module, not the `@oat/ai` barrel: the barrel also loads prompt/context code (and the Markdown
// parser) that the worker never needs.
import { getEmbeddingModel } from '@oat/ai/provider';
import { createDb } from '@oat/db';
import { databaseUrl, loadRootEnv, redactUrl } from '@oat/db/env';
import { backfill } from '../backfill.ts';
import { indexingConfig } from '../env.ts';
import { connectRedis, createIndexQueue } from '../queue.ts';

loadRootEnv();
const { values } = parseArgs({
  options: {
    workspace: { type: 'string' },
    enqueue: { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '4' },
  },
});
const config = indexingConfig();
const url = databaseUrl();
const db = createDb(url, { max: Number(values.concurrency) + 1 });
const redis = values.enqueue ? await connectRedis(config.redisUrl) : undefined;

try {
  const started = Date.now();
  console.log(
    `[backfill] ${values.enqueue ? 'enqueueing' : 'indexing'} documents of ${redactUrl(url)}` +
      (values.workspace ? ` (workspace ${values.workspace})` : ''),
  );
  const totals = await backfill(
    { db, embeddingModel: getEmbeddingModel(), maxChunksPerDocument: config.maxChunksPerDocument },
    {
      workspaceId: values.workspace,
      concurrency: Number(values.concurrency),
      queue: redis ? createIndexQueue(redis, { prefix: config.prefix }) : undefined,
      onProgress: (done) => {
        if (done % 50 === 0) console.log(`[backfill] ${done} documents`);
      },
    },
  );
  console.log(`[backfill] done in ${((Date.now() - started) / 1000).toFixed(1)} s`, totals);
  if (totals.failed.length > 0) process.exitCode = 1;
} finally {
  redis?.destroy();
  await db.$client.end({ timeout: 5 });
}
