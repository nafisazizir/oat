/** Worker/backfill configuration from the environment (documented in `.env.example` and docs/DEV.md). */

/** The compose Redis (D-11). */
export const DEFAULT_REDIS_URL = 'redis://localhost:63790';
export const DEFAULT_QUEUE_PREFIX = 'oat:idx';

export interface IndexingConfig {
  redisUrl: string;
  /** `OAT_INDEX_QUEUE_PREFIX`. */
  prefix: string;
  /** `OAT_INDEX_DEBOUNCE_MS`. */
  debounceMs: number;
  /** `OAT_INDEX_CONCURRENCY`. */
  concurrency: number;
  /** `OAT_INDEX_MAX_CHUNKS`: cap per document (the rest isn't indexed and is logged). */
  maxChunksPerDocument: number;
}

type Env = Record<string, string | undefined>;

const value = (env: Env, name: string) => env[name]?.trim() || undefined;

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = value(env, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

export function indexingConfig(env: Env = process.env): IndexingConfig {
  return {
    redisUrl: value(env, 'REDIS_URL') ?? DEFAULT_REDIS_URL,
    prefix: value(env, 'OAT_INDEX_QUEUE_PREFIX') ?? DEFAULT_QUEUE_PREFIX,
    debounceMs: positiveInt(env, 'OAT_INDEX_DEBOUNCE_MS', 1500),
    concurrency: Math.max(1, positiveInt(env, 'OAT_INDEX_CONCURRENCY', 2)),
    // Same default as DEFAULT_MAX_CHUNKS_PER_DOCUMENT in indexer.ts.
    maxChunksPerDocument: Math.max(1, positiveInt(env, 'OAT_INDEX_MAX_CHUNKS', 1000)),
  };
}
