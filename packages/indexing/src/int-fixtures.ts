/** Shared setup for this package's integration tests (not exported from the package entry). */
import { randomUUID } from 'node:crypto';
import type { DocumentVisibility, Role } from '@oat/core';
import { createDb, type Db, migrate, newId, schema as s } from '@oat/db';
import { createTestDatabase, type TestDatabase, waitFor } from '@oat/testkit';
import { createClient } from 'redis';
import { indexingConfig } from './env.ts';
import type { NotesDoc } from './chunk-notes.ts';
import { createIndexQueue, type IndexQueue, type IndexQueueOptions, type Redis } from './queue.ts';
import type { IndexWorker } from './worker.ts';

export interface Env {
  testDb: TestDatabase;
  db: Db;
  redis: Redis;
  queues: IndexQueue[];
}

export async function setupEnv(): Promise<Env> {
  const testDb = await createTestDatabase();
  await migrate(testDb.url);
  const db = createDb(testDb.url, { max: 6 });
  const redis = createClient({ url: indexingConfig().redisUrl });
  await redis.connect();
  return { testDb, db, redis, queues: [] };
}

export async function teardownEnv(env: Env | undefined): Promise<void> {
  if (!env) return;
  await Promise.all(env.queues.map((q) => q.clear()));
  env.redis.destroy();
  await env.db.$client.end();
  await env.testDb.drop();
}

/** A queue under a unique prefix (the compose Redis is shared by every test run). */
export function testQueue(env: Env, options: IndexQueueOptions = {}): IndexQueue {
  const q = createIndexQueue(env.redis, {
    prefix: `oat-test:idx:${randomUUID()}`,
    debounceMs: 0,
    ...options,
  });
  env.queues.push(q);
  return q;
}

export async function makeUser(db: Db, name = 'U'): Promise<string> {
  const id = newId();
  await db.insert(s.user).values({ id, email: `${id}@example.test`, name });
  return id;
}

export async function makeWorkspace(
  db: Db,
  owner: string,
  members: [userId: string, role: Role][] = [],
): Promise<string> {
  const id = newId();
  await db
    .insert(s.workspace)
    .values({ id, name: 'W', slug: `w-${id}`, createdBy: owner, kind: 'team' });
  await db
    .insert(s.membership)
    .values([
      { workspaceId: id, userId: owner, role: 'owner' },
      ...members.map(([userId, role]) => ({ workspaceId: id, userId, role })),
    ]);
  return id;
}

export const paragraph = (id: string, text: string): NotesDoc => ({
  type: 'paragraph',
  attrs: { id },
  content: [{ type: 'text', text }],
});
export const heading = (id: string, text: string, level = 2): NotesDoc => ({
  type: 'heading',
  attrs: { id, level },
  content: [{ type: 'text', text }],
});
export const body = (...content: NotesDoc[]): NotesDoc => ({ type: 'doc', content });

export async function makeDocument(
  db: Db,
  input: {
    workspaceId: string;
    ownerId: string;
    title?: string;
    visibility?: DocumentVisibility;
    content?: NotesDoc;
    kind?: 'page' | 'meeting';
  },
): Promise<string> {
  const id = newId();
  await db.insert(s.document).values({
    id,
    workspaceId: input.workspaceId,
    ownerId: input.ownerId,
    kind: input.kind ?? 'page',
    title: input.title ?? '',
    visibility: input.visibility ?? 'private',
    shareToken: input.visibility === 'link' ? `tok${randomUUID().replaceAll('-', '')}` : null,
    contentJson: input.content ?? body(),
  });
  return id;
}

export interface Seg {
  id: string;
  source: 'mic' | 'system';
  startMs: number;
  endMs: number;
  text: string;
}

export async function addSegments(db: Db, meetingId: string, segments: Seg[]): Promise<void> {
  if (segments.length === 0) return;
  await db.insert(s.transcriptSegment).values(segments.map((seg) => ({ ...seg, meetingId })));
}

/** `n` segments of 5 s from `from`, with ids `<prefix><i>`. */
export function segs(
  prefix: string,
  from: number,
  n: number,
  text = (i: number) => `point ${i}`,
): Seg[] {
  return Array.from({ length: n }, (_, k) => {
    const i = from + k;
    return {
      id: `${prefix}${String(i).padStart(4, '0')}`,
      source: i % 2 === 0 ? 'mic' : 'system',
      startMs: i * 5000,
      endMs: i * 5000 + 4800,
      text: text(i),
    };
  });
}

/**
 * Follows the change log and runs every due job, repeatedly, until a job for `documentId` has run (without
 * one: until anything ran). Visibility waits for every older transaction on the shared server, so a write's
 * change can surface a pass later than an earlier write's; jobs read current rows, so any run for the
 * document after the write reflects it. Returns everything that ran.
 */
export async function sync(worker: IndexWorker, documentId?: string) {
  const ran: Awaited<ReturnType<IndexWorker['processOnce']>> = [];
  await waitFor(
    async () => {
      const enqueued = await worker.followOnce();
      for (;;) {
        const batch = await worker.processOnce();
        if (batch.length === 0) break;
        ran.push(...batch);
      }
      if (documentId === undefined) return enqueued > 0 || ran.length > 0 ? true : undefined;
      return ran.some((r) => r.result?.documentId === documentId) ? true : undefined;
    },
    { timeout: 15_000, interval: 50 },
  );
  return ran;
}
