/**
 * The index worker (6.1): two loops in one process.
 *
 * - **Follower** (one per queue across all processes, under a Redis lock): reads `change_log` after the
 *   stored cursor (`readAllChanges`, D-22 visibility rule), turns changes into jobs (`jobsForChanges`),
 *   enqueues them (debounced per document) and then advances the cursor. Enqueue-before-advance means a
 *   crash re-reads a page instead of losing it; duplicates are harmless (jobs are deduplicated and
 *   idempotent). No stored cursor = start from the beginning of the log, which re-checks every document
 *   (cheap: unchanged chunks are not re-embedded).
 * - **Processor**: claims due jobs (`concurrency` at a time), runs `syncActionItems` (8.4) then
 *   `indexDocument`/`indexMeeting`, completes or fails them (retry with backoff, then `failed`).
 */
import { type Db, readAllChanges } from '@oat/db';
import { syncActionItems, type SyncActionItemsResult } from './action-items.ts';
import { INDEXED_TABLES, jobsForChanges } from './changes.ts';
import { type IndexerDeps, indexDocument, type IndexResult, indexMeeting } from './indexer.ts';
import type { ClaimedJob, IndexJob, IndexQueue, Lock } from './queue.ts';

export interface WorkerLogger {
  info(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface IndexWorkerOptions extends IndexerDeps {
  db: Db;
  queue: IndexQueue;
  /** Jobs processed at once. Default 2. */
  concurrency?: number;
  /** Idle sleep between polls of the change log and the queue. Default 500 ms. */
  pollMs?: number;
  /** Change-log page size. Default 500. */
  changeBatch?: number;
  /** Run the change-log follower (default true). Off = process jobs only. */
  follow?: boolean;
  logger?: WorkerLogger;
}

export interface IndexWorker {
  start(): void;
  /** Stops both loops after their current iteration. */
  stop(): Promise<void>;
  /** One follower pass (all available pages); returns the number of jobs enqueued. For tests and scripts. */
  followOnce(): Promise<number>;
  /** Claims and runs one batch of due jobs; returns what ran. */
  processOnce(): Promise<{ job: ClaimedJob; result?: JobResult; error?: unknown }[]>;
}

/** What a job did: the chunk index result, plus the action items for document jobs (8.4). */
export type JobResult = IndexResult & { actionItems?: SyncActionItemsResult };

const silent: WorkerLogger = { info() {}, error() {} };

/**
 * Runs one job. Document jobs first re-extract the action items (cheap, no embeddings, so "My tasks" is current
 * even when the embedding provider is down; a failure still fails the job and it is retried).
 */
export async function runJob(deps: IndexerDeps, job: IndexJob): Promise<JobResult> {
  if (job.kind !== 'document') return indexMeeting(deps, job.id);
  const actionItems = await syncActionItems(deps.db, job.id);
  return { ...(await indexDocument(deps, job.id)), actionItems };
}

const actionItemChanges = (result: JobResult) =>
  result.actionItems && result.actionItems.status === 'written'
    ? result.actionItems.inserted + result.actionItems.updated + result.actionItems.deleted
    : 0;

export function createIndexWorker(options: IndexWorkerOptions): IndexWorker {
  const { db, queue } = options;
  const concurrency = options.concurrency ?? 2;
  const pollMs = options.pollMs ?? 500;
  const changeBatch = options.changeBatch ?? 500;
  const log = options.logger ?? silent;
  const lockTtl = Math.max(10_000, pollMs * 20);

  let running = false;
  let loops: Promise<void>[] = [];
  const sleepers = new Set<() => void>();
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (!running) return resolve();
      const done = () => {
        clearTimeout(timer);
        sleepers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      sleepers.add(done);
    });
  const wakeAll = () => [...sleepers].forEach((done) => done());

  /** Follows to the end of the log, renewing `lock` after every page; stops if the lock was lost. */
  async function followPages(lock: Lock, untilDone = false): Promise<number> {
    let enqueued = 0;
    let cursor = await queue.getCursor();
    for (;;) {
      // Unfiltered on purpose: the cursor then moves past other tables' rows too, instead of every poll
      // re-scanning a growing tail of irrelevant changes after the last relevant one.
      const page = await readAllChanges(db, cursor, { limit: changeBatch });
      const relevant = page.changes.filter((c) => INDEXED_TABLES.includes(c.tableName));
      if (relevant.length > 0) {
        const jobs = await jobsForChanges(db, relevant);
        await queue.enqueue(...jobs);
        enqueued += jobs.length;
      }
      if (page.cursor !== cursor) {
        await queue.setCursor(page.cursor);
        cursor = page.cursor;
      }
      if (!page.hasMore || (!running && !untilDone)) return enqueued;
      if (!(await lock.renew())) return enqueued; // another follower took over
    }
  }

  async function followOnce(): Promise<number> {
    const lock = await queue.acquireLock('follower', lockTtl);
    if (!lock) return 0;
    try {
      return await followPages(lock, true);
    } finally {
      await lock.release();
    }
  }

  async function followLoop() {
    while (running) {
      try {
        const lock = await queue.acquireLock('follower', lockTtl);
        if (!lock) {
          await sleep(lockTtl / 2);
          continue;
        }
        try {
          while (running) {
            const n = await followPages(lock);
            if (n > 0) log.info('changes enqueued', { jobs: n });
            if (!(await lock.renew())) break;
            await sleep(pollMs);
          }
        } finally {
          await lock.release().catch(() => {});
        }
      } catch (error) {
        log.error('change follower failed', { error: String(error) });
        await sleep(Math.max(pollMs, 2000));
      }
    }
  }

  async function processOnce() {
    const claimed = await queue.claim(concurrency);
    return Promise.all(
      claimed.map(async (job) => {
        // Heartbeat: keep the lease while the job runs, so a slow (not dead) worker keeps its claim.
        const heartbeat = setInterval(
          () => void queue.extend(job).catch(() => {}),
          Math.max(1000, Math.floor(queue.leaseMs / 3)),
        );
        try {
          const result = await runJob(options, job.job);
          clearInterval(heartbeat);
          if (!(await queue.complete(job))) {
            log.info('lease was lost meanwhile; the new owner finishes the job', { job: job.key });
          }
          if (result.inserted + result.updated + result.deleted + actionItemChanges(result) > 0) {
            log.info('indexed', { job: job.key, ...result });
          }
          if (result.truncated > 0) {
            log.error('document exceeds maxChunksPerDocument; its tail is not indexed', {
              job: job.key,
              truncated: result.truncated,
            });
          }
          return { job, result };
        } catch (error) {
          clearInterval(heartbeat);
          const outcome = await queue.fail(job, error);
          log.error(
            'gaveUp' in outcome
              ? 'index job failed for good'
              : 'stale' in outcome
                ? 'index job failed after its lease was lost'
                : 'index job failed, will retry',
            {
              job: job.key,
              attempt: job.attempt,
              error: error instanceof Error ? error.message : String(error),
            },
          );
          return { job, error };
        }
      }),
    );
  }

  async function processLoop() {
    while (running) {
      try {
        const ran = await processOnce();
        if (ran.length === 0) await sleep(pollMs);
      } catch (error) {
        log.error('index processor failed', { error: String(error) });
        await sleep(Math.max(pollMs, 2000));
      }
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      loops = [processLoop()];
      if (options.follow !== false) loops.push(followLoop());
    },
    async stop() {
      running = false;
      wakeAll();
      await Promise.all(loops);
      loops = [];
    },
    followOnce,
    processOnce,
  };
}
