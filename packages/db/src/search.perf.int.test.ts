/**
 * 3.6 performance budget: search over 10k documents (and 30k transcript segments) answers in < 100 ms
 * (median of repeated runs, local compose Postgres). Prints a timing table; numbers are recorded in
 * docs/tasks/3.6-search.md.
 *
 * Opt-in (`pnpm --filter @oat/db test:perf`, i.e. OAT_SEARCH_PERF=1): seeding 40k rows and timing queries
 * while the other int test files run in parallel made both flaky in `pnpm run ci` (timeouts, noisy medians).
 */
import { createTestDatabase, type TestDatabase } from '@oat/testkit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDb, type Db, migrate } from './client.ts';
import { newId } from './id.ts';
import * as s from './schema/index.ts';
import { searchDocuments, searchSegments } from './search.ts';

const DOCS = 10_000;
const MEETINGS = 600;
const SEGMENTS_PER_MEETING = 50;
const BUDGET_MS = 100;

let testDb: TestDatabase;
let db: Db;
const me = newId();
const other = newId();
const workspaces = [newId(), newId()];

/** Deterministic PRNG (mulberry32) so every run indexes the same corpus. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(36);
const SYLLABLES = [
  'ka',
  'lo',
  'mi',
  'ne',
  'ru',
  'ta',
  'vi',
  'so',
  'pe',
  'da',
  'gu',
  'zo',
  'ri',
  'fa',
];
const COMMON = ['meeting', 'budget', 'roadmap', 'customer', 'launch', 'hiring', 'design', 'review'];
const VOCAB = Array.from({ length: 3000 }, () =>
  Array.from({ length: 2 + Math.floor(rand() * 3) }, () => SYLLABLES[Math.floor(rand() * 14)]).join(
    '',
  ),
);
const word = () =>
  rand() < 0.08
    ? COMMON[Math.floor(rand() * COMMON.length)]!
    : VOCAB[Math.floor(rand() * VOCAB.length)]!;
const words = (n: number) => Array.from({ length: n }, word).join(' ');

const RUN = !!process.env.OAT_SEARCH_PERF;

beforeAll(async () => {
  if (!RUN) return;
  testDb = await createTestDatabase();
  await migrate(testDb.url);
  db = createDb(testDb.url, { max: 4 });
  await db.insert(s.user).values([
    { id: me, email: `perf-${me}@example.test` },
    { id: other, email: `perf-${other}@example.test` },
  ]);
  await db.insert(s.workspace).values(
    workspaces.map((id, i) => ({
      id,
      name: `W${i}`,
      slug: `perf-${id}`,
      createdBy: me,
    })),
  );
  await db.insert(s.membership).values(
    workspaces.flatMap((workspaceId) => [
      { workspaceId, userId: me, role: 'owner' as const },
      { workspaceId, userId: other, role: 'member' as const },
    ]),
  );
  const now = Date.now();
  const docIds: string[] = [];
  for (let batch = 0; batch < DOCS / 1000; batch++) {
    const rows = Array.from({ length: 1000 }, (_, i) => {
      const n = batch * 1000 + i;
      const id = newId();
      docIds.push(id);
      const updatedAt = new Date(now - Math.floor(rand() * 365) * 86_400_000);
      return {
        id,
        workspaceId: workspaces[n % 2]!,
        // A third are someone else's private docs: they must be filtered out, not just ignored.
        ownerId: n % 3 === 0 ? other : me,
        kind: n < MEETINGS ? ('meeting' as const) : ('page' as const),
        title: words(3 + Math.floor(rand() * 4)),
        contentMd: Array.from({ length: 6 }, () => `## ${words(3)}\n\n${words(25)}`).join('\n\n'),
        visibility: n % 3 === 0 ? ('private' as const) : ('workspace' as const),
        createdAt: updatedAt,
        updatedAt,
      };
    });
    await db.insert(s.document).values(rows);
  }
  const meetingRows = docIds.slice(0, MEETINGS).map((documentId) => ({ id: newId(), documentId }));
  await db.insert(s.meeting).values(meetingRows);
  for (let i = 0; i < meetingRows.length; i += 100) {
    await db.insert(s.transcriptSegment).values(
      meetingRows.slice(i, i + 100).flatMap((m) =>
        Array.from({ length: SEGMENTS_PER_MEETING }, (_, k) => ({
          id: newId(),
          meetingId: m.id,
          source: k % 2 ? ('system' as const) : ('mic' as const),
          startMs: k * 6000,
          endMs: k * 6000 + 5000,
          text: words(14),
        })),
      ),
    );
  }
  await db.execute(sql`analyze document; analyze transcript_segment; analyze membership`);
}, 120_000);

afterAll(async () => {
  await db?.$client.end();
  await testDb?.drop();
});

async function time(fn: () => Promise<unknown>, runs = 15) {
  await fn(); // warm-up (plan cache, buffers)
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  return {
    median: ms[Math.floor(runs / 2)]!,
    p95: ms[Math.ceil(runs * 0.95) - 1]!,
    max: ms.at(-1)!,
  };
}

it.skipIf(!RUN)(
  `searches ${DOCS} documents and ${MEETINGS * SEGMENTS_PER_MEETING} segments in < ${BUDGET_MS} ms`,
  async () => {
    const rare = VOCAB[1234]!;
    const scope = { userId: me };
    const cases: Array<[string, () => Promise<{ items: unknown[] }>]> = [
      ['docs: common word "budget"', () => searchDocuments(db, scope, 'budget', { limit: 20 })],
      [
        'docs: two common words',
        () => searchDocuments(db, scope, 'customer launch', { limit: 20 }),
      ],
      [`docs: rare word "${rare}"`, () => searchDocuments(db, scope, rare, { limit: 20 })],
      ['docs: 2-char prefix "ka"', () => searchDocuments(db, scope, 'ka', { limit: 20 })],
      ['docs: typing prefix "bud"', () => searchDocuments(db, scope, 'bud', { limit: 20 })],
      ['docs: phrase', () => searchDocuments(db, scope, '"budget review"', { limit: 20 })],
      [
        'docs: page 3 of "meeting"',
        () => searchDocuments(db, scope, 'meeting', { limit: 20, offset: 40 }),
      ],
      ['segments: common word', () => searchSegments(db, scope, 'roadmap', { limit: 20 })],
      ['segments: 2-char prefix "lo"', () => searchSegments(db, scope, 'lo', { limit: 20 })],
      [
        'palette: docs + segments, limit 5',
        () =>
          Promise.all([
            searchDocuments(db, scope, 'hiring', { limit: 5 }),
            searchSegments(db, scope, 'hiring', { limit: 5 }),
          ]).then(([a]) => a),
      ],
    ];
    const rows: string[] = [];
    for (const [label, fn] of cases) {
      const result = await fn();
      expect(result.items.length, label).toBeGreaterThan(0);
      const t = await time(fn);
      rows.push(
        `| ${label} | ${result.items.length} | ${t.median.toFixed(1)} | ${t.p95.toFixed(1)} | ${t.max.toFixed(1)} |`,
      );
      expect(t.median, `${label} median ms`).toBeLessThan(BUDGET_MS);
    }
    console.log(
      ['| query | hits | median ms | p95 ms | max ms |', '|---|---|---|---|---|', ...rows].join(
        '\n',
      ),
    );
  },
  120_000,
);
