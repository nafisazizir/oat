/**
 * Queue + worker + indexer end to end (6.1): writes → change_log → jobs → chunks in pgvector. Throwaway
 * database per file; the shared compose Redis with a unique key prefix per queue.
 */
import { createMockEmbeddingModel } from '@oat/ai/testing';
import { readAllChanges, schema as s } from '@oat/db';
import { waitFor } from '@oat/testkit';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backfill } from './backfill.ts';
import {
  addSegments,
  body,
  type Env,
  heading,
  makeDocument,
  makeUser,
  makeWorkspace,
  paragraph,
  segs,
  setupEnv,
  sync,
  teardownEnv,
  testQueue,
} from './int-fixtures.ts';
import { jobsForChanges } from './changes.ts';
import { indexDocument } from './indexer.ts';
import type { IndexQueue } from './queue.ts';
import { createIndexWorker, type IndexWorker } from './worker.ts';

let env: Env;
let userId: string;
let ws: string;
const model = createMockEmbeddingModel();
/** Texts sent to the embedding model so far. */
const embedded = () => model.doEmbedCalls.reduce((n, call) => n + call.values.length, 0);

beforeAll(async () => {
  env = await setupEnv();
  userId = await makeUser(env.db);
  ws = await makeWorkspace(env.db, userId);
});
afterAll(() => teardownEnv(env));

const chunksOf = (documentId: string) =>
  env.db
    .select()
    .from(s.chunk)
    .where(eq(s.chunk.documentId, documentId))
    .orderBy(asc(s.chunk.source), asc(s.chunk.ordinal));

/** ~70 tokens of distinct words per block, so a dozen blocks make several chunks. */
const longText = (topic: string) =>
  Array.from({ length: 35 }, (_, i) => `${topic}${i}`).join(' ') + '.';

describe('index worker (running)', () => {
  it('indexes a new document within seconds of the write', async () => {
    const queue = testQueue(env, { debounceMs: 100 });
    const worker = createIndexWorker({ db: env.db, queue, embeddingModel: model, pollMs: 50 });
    worker.start();
    try {
      const started = Date.now();
      const doc = await makeDocument(env.db, {
        workspaceId: ws,
        ownerId: userId,
        title: 'Roadmap',
        content: body(heading('h1', 'Q3 goals'), paragraph('p1', 'Ship semantic search.')),
      });
      const rows = await waitFor(
        async () => {
          const r = await chunksOf(doc);
          return r.length > 0 ? r : undefined;
        },
        { timeout: 15_000, interval: 50 },
      );
      const elapsed = Date.now() - started;
      console.log(`[6.1 evidence] write → indexed in ${elapsed} ms`);
      expect(elapsed).toBeLessThan(10_000);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        workspaceId: ws,
        source: 'notes',
        ordinal: 0,
        refIds: ['h1', 'p1'],
        segmentStartMs: null,
        text: 'Roadmap\n\n## Q3 goals\n\nShip semantic search.',
      });
      expect(rows[0]!.embedding).toHaveLength(s.EMBEDDING_DIMENSIONS);
      expect(rows[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await worker.stop();
    }
  });
});

describe('index worker (stepped)', () => {
  let worker: IndexWorker;
  let queue: IndexQueue;
  beforeAll(async () => {
    // A fresh queue (and so cursor): the follower starts at the beginning of this test DB's change log.
    queue = testQueue(env);
    worker = createIndexWorker({ db: env.db, queue, embeddingModel: model });
    await sync(worker); // catch up with earlier tests' writes
  });

  it('moves its cursor past changes it does not index', async () => {
    const [folder] = await env.db
      .insert(s.folder)
      .values({ workspaceId: ws, ownerId: userId, name: 'f', visibility: 'private' })
      .returning();
    // Once the folder's change is visible, a follower pass consumes it (no job: folders aren't indexed).
    await waitFor(
      async () => {
        const page = await readAllChanges(env.db, await queue.getCursor());
        return page.changes.some((c) => c.rowId === folder!.id) ? true : undefined;
      },
      { timeout: 15_000, interval: 50 },
    );
    await worker.followOnce();
    const rest = await readAllChanges(env.db, await queue.getCursor());
    expect(rest.changes.map((c) => c.rowId)).not.toContain(folder!.id);
  });

  it('re-embeds only changed chunks, keeps unchanged rows, deletes what disappeared', async () => {
    const blocks = Array.from({ length: 14 }, (_, i) => paragraph(`b${i}`, longText(`topic${i}x`)));
    const doc = await makeDocument(env.db, {
      workspaceId: ws,
      ownerId: userId,
      title: 'Long note',
      content: body(...blocks),
    });
    let before = embedded();
    await sync(worker, doc);
    const first = await chunksOf(doc);
    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(embedded() - before).toBe(first.length);
    // Every block id is cited, in order.
    expect([...new Set(first.flatMap((c) => c.refIds))]).toEqual(blocks.map((b) => b.attrs!.id));

    // A write that doesn't change the content (version bump): job runs, nothing re-embedded or rewritten.
    before = embedded();
    await env.db
      .update(s.document)
      .set({ version: sql`${s.document.version} + 1` })
      .where(eq(s.document.id, doc));
    const ran = await sync(worker, doc);
    expect(ran.map((r) => r.result)).toContainEqual(
      expect.objectContaining({
        documentId: doc,
        inserted: 0,
        updated: 0,
        deleted: 0,
        embedded: 0,
      }),
    );
    expect(embedded()).toBe(before);
    expect(await chunksOf(doc)).toEqual(first);

    // Edit the last block: only the last chunk changes.
    before = embedded();
    const edited = [...blocks];
    edited[13] = paragraph('b13', longText('rewritten'));
    await env.db
      .update(s.document)
      .set({ contentJson: body(...edited) })
      .where(eq(s.document.id, doc));
    await sync(worker, doc);
    const second = await chunksOf(doc);
    expect(embedded() - before).toBe(1);
    expect(second.slice(0, -1).map((c) => c.id)).toEqual(first.slice(0, -1).map((c) => c.id));
    expect(second.at(-1)!.id).not.toBe(first.at(-1)!.id);
    expect(second.at(-1)!.text).toContain('rewritten0');

    // Clear the body: notes chunks are deleted.
    await env.db.update(s.document).set({ contentJson: body() }).where(eq(s.document.id, doc));
    await sync(worker, doc);
    expect(await chunksOf(doc)).toEqual([]);
  });

  it('indexes a meeting transcript in time windows; appends re-embed only the tail; deletes are applied', async () => {
    const doc = await makeDocument(env.db, {
      workspaceId: ws,
      ownerId: userId,
      kind: 'meeting',
      title: 'Standup',
      content: body(paragraph('n1', 'My notes.')),
    });
    const [m] = await env.db.insert(s.meeting).values({ documentId: doc }).returning();
    await addSegments(env.db, m!.id, segs('s', 0, 40)); // 200 s
    await sync(worker, doc);
    let rows = await chunksOf(doc);
    const notes = rows.filter((r) => r.source === 'notes');
    const transcript = rows.filter((r) => r.source === 'transcript');
    expect(notes).toHaveLength(1);
    expect(transcript.length).toBeGreaterThanOrEqual(2);
    expect(transcript[0]).toMatchObject({ segmentStartMs: 0, ordinal: 0 });
    expect(transcript[0]!.refIds[0]).toBe('s0000');
    expect(
      transcript[0]!.text.startsWith('Transcript · Standup\n\nMe: point 0\nThem: point 1'),
    ).toBe(true);
    for (const c of transcript) {
      expect(c.segmentEndMs! - c.segmentStartMs!).toBeLessThanOrEqual(90_000);
      expect(c.segmentEndMs).toBe(Number(c.refIds.at(-1)!.slice(1)) * 5000 + 4800);
    }

    // Live meeting: more segments arrive. Earlier windows keep their rows; only the tail is re-embedded.
    let before = embedded();
    await addSegments(env.db, m!.id, segs('s', 40, 3));
    await sync(worker, doc);
    rows = await chunksOf(doc);
    const after = rows.filter((r) => r.source === 'transcript');
    expect(after.slice(0, -1).map((c) => c.id)).toEqual(transcript.slice(0, -1).map((c) => c.id));
    const fresh = after.filter((c) => !transcript.some((t) => t.id === c.id));
    expect(fresh.length).toBeGreaterThanOrEqual(1);
    expect(fresh.length).toBeLessThanOrEqual(2);
    expect(embedded() - before).toBe(fresh.length);
    expect(after.at(-1)!.refIds.at(-1)).toBe('s0042');

    // A deleted segment disappears from the chunks that cited it (found through ref_ids).
    before = embedded();
    await env.db.delete(s.transcriptSegment).where(eq(s.transcriptSegment.id, 's0001'));
    await sync(worker, doc);
    rows = await chunksOf(doc);
    expect(rows.flatMap((r) => r.refIds)).not.toContain('s0001');
    expect(rows.find((r) => r.source === 'transcript')!.text).not.toContain('point 1\n');
    expect(embedded()).toBeGreaterThan(before);
  });

  it('removes chunks with the document (cascade) and treats the job as done', async () => {
    const doc = await makeDocument(env.db, {
      workspaceId: ws,
      ownerId: userId,
      content: body(paragraph('x', 'Temporary.')),
    });
    await sync(worker, doc);
    expect(await chunksOf(doc)).toHaveLength(1);
    await env.db.delete(s.document).where(eq(s.document.id, doc));
    expect(await chunksOf(doc)).toEqual([]);
    expect(await indexDocument({ db: env.db, embeddingModel: model }, doc)).toMatchObject({
      status: 'missing',
      inserted: 0,
    });
  });

  it('retries a failing job with backoff instead of losing it', async () => {
    const failing = createMockEmbeddingModel();
    failing.doEmbed = async () => {
      throw new Error('embeddings unavailable');
    };
    const queue = testQueue(env, { backoffMs: 60_000 });
    const broken = createIndexWorker({ db: env.db, queue, embeddingModel: failing });
    const doc = await makeDocument(env.db, {
      workspaceId: ws,
      ownerId: userId,
      content: body(paragraph('f', 'Will fail first.')),
    });
    await queue.enqueue({ kind: 'document', id: doc });
    const [ran] = await broken.processOnce();
    expect(String(ran!.error)).toMatch(/embeddings unavailable/);
    expect(await queue.stats()).toEqual({ pending: 1, active: 0, failed: 0 });
    expect(await chunksOf(doc)).toEqual([]);
  });
});

describe('indexer: races, limits, partial failures', () => {
  it('maps meeting and segment changes to the one document key', async () => {
    const doc = await makeDocument(env.db, { workspaceId: ws, ownerId: userId, kind: 'meeting' });
    const [m] = await env.db.insert(s.meeting).values({ documentId: doc }).returning();
    await addSegments(env.db, m!.id, segs(`k${doc}-`, 0, 3));
    await env.db.update(s.document).set({ title: 'Renamed' }).where(eq(s.document.id, doc));
    await env.db.delete(s.transcriptSegment).where(eq(s.transcriptSegment.id, `k${doc}-0000`));
    const changes = await waitFor(
      async () => {
        const page = await readAllChanges(env.db, null, { limit: 10_000 });
        const mine = page.changes.filter(
          (c) => c.rowId === doc || c.rowId === m!.id || c.rowId.startsWith(`k${doc}-`),
        );
        return mine.length >= 7 ? mine : undefined;
      },
      { timeout: 15_000, interval: 50 },
    );
    expect(new Set(changes.map((c) => c.tableName))).toEqual(
      new Set(['document', 'meeting', 'transcript_segment']),
    );
    expect(await jobsForChanges(env.db, changes)).toEqual([{ kind: 'document', id: doc }]);
  });

  it('a rename racing an index run never leaves the old title behind', async () => {
    const doc = await makeDocument(env.db, {
      workspaceId: ws,
      ownerId: userId,
      kind: 'meeting',
      title: 'Old title',
      content: body(paragraph('r1', 'Racing notes.')),
    });
    const [m] = await env.db.insert(s.meeting).values({ documentId: doc }).returning();
    await addSegments(env.db, m!.id, segs(`r${doc}-`, 0, 30));
    // The rename lands while the run is embedding (after it read the document, before it writes).
    const racing = createMockEmbeddingModel();
    const embedOnce = racing.doEmbed;
    let renamed = false;
    racing.doEmbed = async (options) => {
      if (!renamed) {
        renamed = true;
        await env.db.update(s.document).set({ title: 'New title' }).where(eq(s.document.id, doc));
      }
      return embedOnce(options);
    };
    const result = await indexDocument({ db: env.db, embeddingModel: racing }, doc);
    expect(result.status).toBe('indexed');
    const rows = await chunksOf(doc);
    expect(rows.some((r) => r.source === 'transcript')).toBe(true);
    for (const r of rows) {
      expect(r.text).toContain('New title');
      expect(r.text).not.toContain('Old title');
    }
  });

  it('caps chunks per document and embeds in bounded batches', async () => {
    const blocks = Array.from({ length: 30 }, (_, i) => paragraph(`c${i}`, longText(`cap${i}x`)));
    const doc = await makeDocument(env.db, {
      workspaceId: ws,
      ownerId: userId,
      content: body(...blocks),
    });
    const counted = createMockEmbeddingModel();
    const result = await indexDocument(
      { db: env.db, embeddingModel: counted, maxChunksPerDocument: 5, embedBatchSize: 2 },
      doc,
    );
    expect(result.truncated).toBeGreaterThan(0);
    expect(await chunksOf(doc)).toHaveLength(5);
    expect(result.embedded).toBe(5);
    expect(counted.doEmbedCalls.map((c) => c.values.length)).toEqual([2, 2, 1]);
  });

  it('a run that fails halfway keeps what it embedded; the retry embeds only the rest', async () => {
    const blocks = Array.from({ length: 14 }, (_, i) => paragraph(`h${i}`, longText(`half${i}x`)));
    const doc = await makeDocument(env.db, {
      workspaceId: ws,
      ownerId: userId,
      content: body(...blocks),
    });
    const flaky = createMockEmbeddingModel();
    const embedOnce = flaky.doEmbed;
    let calls = 0;
    flaky.doEmbed = async (options) => {
      if (++calls === 2) throw new Error('provider hiccup');
      return embedOnce(options);
    };
    const deps = { db: env.db, embeddingModel: flaky, embedBatchSize: 1 };
    await expect(indexDocument(deps, doc)).rejects.toThrow(/provider hiccup/);
    const staged = await chunksOf(doc);
    expect(staged).toHaveLength(1);

    const retry = await indexDocument(deps, doc);
    const rows = await chunksOf(doc);
    expect(retry.embedded).toBe(rows.length - 1); // the staged chunk was not embedded again
    expect(rows.map((r) => r.id)).toContain(staged[0]!.id);
    expect(rows.map((r) => r.ordinal)).toEqual(rows.map((_, i) => i));
  });
});

describe('backfill', () => {
  it('rebuilds every chunk, and a second run embeds nothing', async () => {
    const doc = await makeDocument(env.db, {
      workspaceId: ws,
      ownerId: userId,
      title: 'Backfilled',
      content: body(paragraph('bf', 'Indexed by the backfill.')),
    });
    await env.db.delete(s.chunk);
    const deps = { db: env.db, embeddingModel: model };
    const totals = await backfill(deps);
    expect(totals.failed).toEqual([]);
    const docs = await env.db.select({ id: s.document.id }).from(s.document);
    expect(totals.documents).toBe(docs.length);
    expect(totals.inserted).toBeGreaterThan(0);
    expect(totals.embedded).toBe(totals.inserted);
    expect(await chunksOf(doc)).toHaveLength(1);

    const again = await backfill(deps, { workspaceId: ws });
    expect(again).toMatchObject({ embedded: 0, inserted: 0, deleted: 0, updated: 0 });
    expect(again.unchanged).toBe(totals.inserted);
  });

  it('can enqueue instead of indexing inline', async () => {
    const queue = testQueue(env);
    const totals = await backfill(
      { db: env.db, embeddingModel: model },
      { queue, workspaceId: ws },
    );
    expect((await queue.stats()).pending).toBe(totals.documents);
  });
});
