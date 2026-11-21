/**
 * Enhance API against a throwaway migrated database: the exact route handlers, an in-memory broker (the Redis
 * broker has its own int test) and an in-process mock model. Sessions are faked (`x-test-user` header →
 * user id) as in the templates API test; what matters here is authorization, idempotency, one run per note,
 * resumable streaming and how completion writes the note.
 */
import { createMockModel } from '@oat/ai/testing';
import {
  createDb,
  type Db,
  document,
  enhancement,
  meeting,
  membership,
  migrate,
  newId,
  participant,
  template,
  transcriptSegment,
  user,
  workspace,
} from '@oat/db';
import type { JSONContent } from '@oat/editor';
import { createTestDatabase, type TestDatabase } from '@oat/testkit';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ApiErrorBody } from '@/lib/api-types';
import type { EnhanceEvent, EnhancementDto, StartEnhanceResult } from '@/lib/enhance';

import { denies } from '../api/authz-markers';
import type { RouteHandler } from '../api/route';
import { createEnhanceApi, type EnhanceApi } from './api';
import { createMemoryBroker } from './broker';
import type { EnhanceDeps, StoredOutput } from './service';

const BASE = 'http://localhost:3000';

let testDb: TestDatabase;
let db: Db;
let api: EnhanceApi;
const jobs: Promise<void>[] = [];
let model = createMockModel({ responses: ['{}'] });
const broker = createMemoryBroker();
const deps: EnhanceDeps = {
  broker,
  model: () => ({ model, id: 'mock-enhance' }),
  runInBackground: (task) => void jobs.push(task()),
  logError: () => undefined,
};
const settle = async () => {
  while (jobs.length) await Promise.all(jobs.splice(0));
};

type Role = 'owner' | 'admin' | 'member' | 'viewer';
const users = {} as Record<'owner' | 'member' | 'viewer' | 'outsider', string>;
let teamId: string;
let otherTeamId: string;

const NOTES: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'pilot in two clinics' }] },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'security review', marks: [{ type: 'bold' }] }],
            },
          ],
        },
      ],
    },
  ],
};

/** What the mock model "writes": the General template's headings, one of my lines, AI lines with refs. */
const OUTPUT = {
  sections: [
    {
      heading: 'Summary',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Discovery call with the clinic group.',
          origin: 'ai',
          sources: ['s1'],
        },
      ],
    },
    {
      heading: 'Discussion',
      blocks: [
        {
          kind: 'bullet',
          text: 'Pilot in two clinics',
          origin: 'ai',
          children: [
            { kind: 'bullet', text: 'Lakeside and Mill Street', origin: 'me', sources: ['s2'] },
          ],
        },
      ],
    },
    { heading: 'Decisions', blocks: [] },
    {
      heading: 'Action items',
      blocks: [
        {
          kind: 'task',
          text: 'Send the SOC 2 report',
          origin: 'ai',
          owner: 'Riley',
          sources: ['s2', 's9'],
        },
      ],
    },
  ],
};

async function addUser(label: string): Promise<string> {
  const [row] = await db
    .insert(user)
    .values({ id: newId(), email: `${label}-${newId()}@example.test`, name: label })
    .returning();
  return row!.id;
}

async function addWorkspace(members: Array<[string, Role]>): Promise<string> {
  const [ws] = await db
    .insert(workspace)
    .values({ name: 'Team', slug: `team-${newId()}`, createdBy: members[0]![0] })
    .returning();
  await db
    .insert(membership)
    .values(members.map(([userId, role]) => ({ workspaceId: ws!.id, userId, role })));
  return ws!.id;
}

/** A meeting note with notes + a 3-line transcript (+ participants). */
async function meetingNote(
  options: {
    owner?: string;
    visibility?: 'private' | 'workspace';
    kind?: 'meeting' | 'page';
    notes?: JSONContent;
    segments?: boolean;
    workspaceId?: string;
  } = {},
) {
  const [doc] = await db
    .insert(document)
    .values({
      workspaceId: options.workspaceId ?? teamId,
      ownerId: options.owner ?? users.owner,
      kind: options.kind ?? 'meeting',
      title: 'Clinic discovery',
      visibility: options.visibility ?? 'workspace',
      contentJson: options.notes ?? NOTES,
    })
    .returning();
  const [m] = await db
    .insert(meeting)
    .values({ documentId: doc!.id, startedAt: new Date('2026-11-12T10:00:00Z') })
    .returning();
  await db.insert(participant).values([
    { meetingId: m!.id, name: 'Riley', email: 'riley@oat.test', source: 'calendar' },
    { meetingId: m!.id, name: 'Tomás', email: 'tomas@clinic.test', source: 'calendar' },
  ]);
  if (options.segments !== false) {
    await db.insert(transcriptSegment).values(
      ['We run eleven clinics.', 'A pilot in Lakeside and Mill Street.', 'Interim words'].map(
        (text, i) => ({
          id: `${doc!.id}-seg-${i}`,
          meetingId: m!.id,
          source: i === 0 ? ('system' as const) : ('mic' as const),
          startMs: i * 5000,
          endMs: i * 5000 + 4000,
          text,
          isFinal: i < 2,
        }),
      ),
    );
  }
  return doc!;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await migrate(testDb.url);
  db = createDb(testDb.url, { max: 6 });
  api = createEnhanceApi(
    {
      db: () => db,
      getSession: async (headers) => {
        const id = headers.get('x-test-user');
        return id ? { user: { id } } : null;
      },
      allowedOrigins: () => [BASE],
    },
    deps,
  );
  users.owner = await addUser('owner');
  users.member = await addUser('member');
  users.viewer = await addUser('viewer');
  users.outsider = await addUser('outsider');
  teamId = await addWorkspace([
    [users.owner, 'owner'],
    [users.member, 'member'],
    [users.viewer, 'viewer'],
  ]);
  otherTeamId = await addWorkspace([[users.outsider, 'owner']]);
});

beforeEach(() => {
  model = createMockModel({ responses: [JSON.stringify(OUTPUT)] });
});

afterAll(async () => {
  await settle();
  await broker.close();
  await db?.$client.end();
  await testDb?.drop();
});

type Call = {
  as: string | null;
  body?: unknown;
  origin?: string | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

async function request(
  handler: RouteHandler<never>,
  method: string,
  path: string,
  id: string,
  options: Call,
): Promise<Response> {
  const headers = new Headers(options.headers);
  const origin = options.origin === undefined ? BASE : options.origin;
  if (origin !== null) headers.set('origin', origin);
  if (options.as) headers.set('x-test-user', options.as);
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set('content-type', 'application/json');
  }
  return (handler as RouteHandler<Record<string, string>>)(
    new Request(`${BASE}${path}`, { method, headers, body, signal: options.signal }),
    { params: Promise.resolve({ id }) },
  );
}

async function json<T>(res: Response) {
  const text = await res.text();
  const body = (text ? JSON.parse(text) : undefined) as T & Partial<ApiErrorBody>;
  return { status: res.status, body, error: body?.error };
}

let keys = 0;
const key = () => `key-${Date.now()}-${keys++}`;

const start = (
  as: string | null,
  docId: string,
  body: Record<string, unknown> = {},
  extra: Partial<Call> = {},
) =>
  request(api.documentEnhance.POST, 'POST', `/api/documents/${docId}/enhance`, docId, {
    as,
    body: { idempotencyKey: key(), ...body },
    ...extra,
  }).then((r) => json<StartEnhanceResult>(r));

const latest = (as: string | null, docId: string) =>
  request(api.documentEnhance.GET, 'GET', `/api/documents/${docId}/enhance`, docId, { as }).then(
    (r) => json<{ latest: EnhancementDto | null }>(r),
  );

type SseEvent = { id: string; type: string; data: EnhanceEvent };

/** Parses complete SSE events out of a text buffer. */
function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.includes('data: '))
    .map((chunk) => {
      const field = (name: string) =>
        chunk
          .split('\n')
          .find((l) => l.startsWith(`${name}: `))
          ?.slice(name.length + 2) ?? '';
      return {
        id: field('id'),
        type: field('event'),
        data: JSON.parse(field('data')) as EnhanceEvent,
      };
    });
}

function stream(as: string | null, enhancementId: string, extra: Partial<Call> = {}) {
  return request(
    api.enhancementStream.GET,
    'GET',
    `/api/enhancements/${enhancementId}/stream`,
    enhancementId,
    { as, ...extra },
  );
}

async function readAll(res: Response): Promise<SseEvent[]> {
  return parseSse(await res.text());
}

async function body(docId: string) {
  const [row] = await db.select().from(document).where(eq(document.id, docId));
  return row!;
}

async function run(id: string) {
  const [row] = await db.select().from(enhancement).where(eq(enhancement.id, id));
  return row!;
}

const texts = (node: JSONContent): string[] =>
  node.type === 'text' ? [node.text ?? ''] : (node.content ?? []).flatMap(texts);

describe('authorization', () => {
  it('needs a session (401), hides unreadable notes (404) and refuses cross-site writes (403)', async () => {
    denies('POST /api/documents/[id]/enhance', 'GET /api/documents/[id]/enhance');
    const doc = await meetingNote();
    expect((await start(null, doc.id)).status).toBe(401);
    expect((await latest(null, doc.id)).status).toBe(401);
    expect((await start(users.outsider, doc.id)).status).toBe(404);
    expect((await latest(users.outsider, doc.id)).status).toBe(404);
    expect((await start(users.owner, 'nope')).status).toBe(404);
    const crossSite = await start(users.owner, doc.id, {}, { origin: 'https://evil.test' });
    expect(crossSite).toMatchObject({ status: 403, error: { code: 'cross_site' } });

    const priv = await meetingNote({ visibility: 'private' });
    expect((await start(users.member, priv.id)).status).toBe(404);
    expect((await latest(users.member, priv.id)).status).toBe(404);
    expect(await db.select().from(enhancement).where(eq(enhancement.documentId, doc.id))).toEqual(
      [],
    );
  });

  it('lets viewers watch but not start', async () => {
    denies('POST /api/documents/[id]/enhance');
    const doc = await meetingNote();
    expect(await start(users.viewer, doc.id)).toMatchObject({
      status: 403,
      error: { code: 'forbidden' },
    });
    const started = await start(users.owner, doc.id);
    expect(started.status).toBe(201);
    await settle();
    expect((await latest(users.viewer, doc.id)).body.latest?.status).toBe('completed');
    const events = await readAll(await stream(users.viewer, started.body.enhancement.id));
    expect(events.map((e) => e.type)).toEqual(['completed']);
  });

  it('streams only runs of notes the caller can read', async () => {
    denies('GET /api/enhancements/[id]/stream');
    const doc = await meetingNote({ visibility: 'private' });
    const started = await start(users.owner, doc.id);
    await settle();
    expect((await json(await stream(null, started.body.enhancement.id))).status).toBe(401);
    expect((await json(await stream(users.member, started.body.enhancement.id))).status).toBe(404);
    expect((await json(await stream(users.outsider, started.body.enhancement.id))).status).toBe(
      404,
    );
    expect((await json(await stream(users.owner, 'unknown'))).status).toBe(404);
  });
});

describe('validation', () => {
  it('rejects pages, trashed notes, bad keys, foreign templates and empty meetings', async () => {
    const page = await meetingNote({ kind: 'page' });
    expect((await start(users.owner, page.id)).status).toBe(400);

    const doc = await meetingNote();
    const badKey = await request(api.documentEnhance.POST, 'POST', '/x', doc.id, {
      as: users.owner,
      body: { idempotencyKey: 'no spaces allowed!' },
    });
    expect(badKey.status).toBe(400);
    const extra = await request(api.documentEnhance.POST, 'POST', '/x', doc.id, {
      as: users.owner,
      body: { idempotencyKey: key(), sneaky: true },
    });
    expect(extra.status).toBe(400);

    const [foreign] = await db
      .insert(template)
      .values({
        workspaceId: otherTeamId,
        name: 'Theirs',
        sectionsJson: [{ heading: 'A', instructions: '' }],
      })
      .returning();
    expect(await start(users.owner, doc.id, { templateId: foreign!.id })).toMatchObject({
      status: 404,
      error: { message: 'Template not found.' },
    });
    expect((await start(users.owner, doc.id, { templateId: 'missing' })).status).toBe(404);

    const empty = await meetingNote({ notes: { type: 'doc', content: [] }, segments: false });
    expect(await start(users.owner, empty.id)).toMatchObject({
      status: 422,
      error: { code: 'nothing_to_enhance' },
    });

    const trashed = await meetingNote();
    await db.update(document).set({ deletedAt: new Date() }).where(eq(document.id, trashed.id));
    expect((await start(users.owner, trashed.id)).status).toBe(403);
  });
});

describe('a run', () => {
  it('turns notes + transcript into the note body: my lines `me`, AI lines `ai`, notes kept', async () => {
    const doc = await meetingNote();
    const started = await start(users.member, doc.id, { timeZone: 'Europe/Berlin' });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({
      attached: false,
      enhancement: { status: 'generating', documentId: doc.id, model: 'mock-enhance' },
    });
    await settle();

    const after = await body(doc.id);
    expect(after.version).toBe(doc.version + 1);
    const content = after.contentJson as JSONContent;
    expect(content.content![0]).toMatchObject({ type: 'heading', attrs: { origin: 'ai' } });
    // My dropped line is back under "Other notes", as mine, with my bold mark.
    const paragraphs: JSONContent[] = [];
    const visit = (n: JSONContent) => {
      if (n.type === 'paragraph') paragraphs.push(n);
      n.content?.forEach(visit);
    };
    visit(content);
    const mine = paragraphs.find((p) => texts(p).join('') === 'security review')!;
    expect(mine.attrs?.origin).toBe('me');
    expect(mine.content).toEqual([
      { type: 'text', text: 'security review', marks: [{ type: 'bold' }] },
    ]);
    // The model's claim that "Lakeside and Mill Street" is mine is not trusted.
    const lake = paragraphs.find((p) => texts(p).join('') === 'Lakeside and Mill Street')!;
    expect(lake.attrs?.origin).toBe('ai');
    expect(texts(content)).toContain('pilot in two clinics');
    expect(texts(content)).toContain('Other notes');
    expect(after.contentMd).toContain('## Action items');

    const row = await run(started.body.enhancement.id);
    expect(row.status).toBe('completed');
    // My notes as they were (block ids added, as on every stored body).
    expect(texts(row.inputNotesJson as JSONContent)).toEqual(texts(NOTES));
    expect(JSON.stringify(row.inputNotesJson)).toContain('"bold"');
    const stored = row.outputJson as Extract<StoredOutput, { output: unknown }>;
    expect(stored).toMatchObject({
      v: 1,
      applied: true,
      documentVersion: after.version,
      missingLines: 1,
    });
    expect(stored.doc).toEqual(content);
    const lakeside = stored.output.sections[1]!.blocks[0]!;
    expect(lakeside).toMatchObject({ text: 'pilot in two clinics', origin: 'me' });
    expect(lakeside.kind !== 'paragraph' && lakeside.children?.[0]?.origin).toBe('ai');
    // Citations resolve transcript refs (final segments only) to segment ids; unknown refs dropped.
    expect(Object.values(stored.citations)).toEqual(
      expect.arrayContaining([[`${doc.id}-seg-0`], [`${doc.id}-seg-1`]]),
    );
    // The prompt: our rules as system, the meeting fenced, the interim segment left out.
    const call = model.doStreamCalls[0]!;
    const prompt = JSON.stringify(call.prompt);
    expect(prompt).toContain('<oat:transcript>');
    expect(prompt).toContain('A pilot in Lakeside and Mill Street.');
    expect(prompt).not.toContain('Interim words');
    expect(prompt).toContain('tomas@clinic.test');

    const final = await latest(users.owner, doc.id);
    expect(final.body.latest).toMatchObject({ status: 'completed', applied: true, error: null });
  });

  it('keeps the user’s edits if the note changed while the AI was writing', async () => {
    model = createMockModel({ responses: [JSON.stringify(OUTPUT)], chunkDelayInMs: 2 });
    const doc = await meetingNote();
    const started = await start(users.owner, doc.id);
    // An autosave lands mid-run.
    const edited: JSONContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'typed meanwhile' }] }],
    };
    await db
      .update(document)
      .set({ contentJson: edited, version: doc.version + 1 })
      .where(eq(document.id, doc.id));
    await settle();
    const after = await body(doc.id);
    expect(after.version).toBe(doc.version + 1);
    expect(after.contentJson).toEqual(edited);
    const row = await run(started.body.enhancement.id);
    expect(row.status).toBe('completed');
    expect(row.outputJson).toMatchObject({ applied: false, documentVersion: null });
    const events = await readAll(await stream(users.owner, row.id));
    expect(events.at(-1)).toMatchObject({
      type: 'completed',
      data: { enhancement: { applied: false } },
    });
    expect((events.at(-1)!.data as { doc: JSONContent }).doc).toEqual(
      (row.outputJson as { doc: JSONContent }).doc,
    );
  });

  it('records failures without touching the note', async () => {
    model = createMockModel({
      handler: () => {
        throw new Error('provider down');
      },
    });
    const doc = await meetingNote();
    const started = await start(users.owner, doc.id);
    await settle();
    expect((await body(doc.id)).contentJson).toEqual(NOTES);
    const row = await run(started.body.enhancement.id);
    expect(row.status).toBe('failed');
    expect(row.outputJson).toMatchObject({ error: { code: 'internal' } });
    const events = await readAll(await stream(users.owner, row.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'failed',
      data: { enhancement: { status: 'failed' } },
    });

    model = createMockModel({ responses: ['{"sections": "nope"}'] });
    const invalid = await start(users.owner, doc.id);
    await settle();
    expect((await run(invalid.body.enhancement.id)).outputJson).toMatchObject({
      error: { code: 'invalid_output' },
    });
  });
});

describe('idempotency and concurrency', () => {
  it('returns the same run for the same key; keys are scoped per user and note', async () => {
    // Slow enough that the first run is still going when the other user's request arrives.
    model = createMockModel({ responses: [JSON.stringify(OUTPUT)], chunkDelayInMs: 10 });
    const doc = await meetingNote();
    const idempotencyKey = key();
    const first = await start(users.owner, doc.id, { idempotencyKey });
    const again = await start(users.owner, doc.id, { idempotencyKey });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      attached: true,
      enhancement: { id: first.body.enhancement.id },
    });
    // The same client key from another user, or for another note, is a different request.
    const byMember = await start(users.member, doc.id, { idempotencyKey });
    expect(byMember).toMatchObject({
      status: 200,
      body: { attached: true, enhancement: { id: first.body.enhancement.id } },
    });
    const other = await meetingNote();
    expect((await start(users.owner, other.id, { idempotencyKey })).status).toBe(201);
    await settle();
    expect(
      await db.select().from(enhancement).where(eq(enhancement.documentId, doc.id)),
    ).toHaveLength(1);
  });

  it('runs one job per note: concurrent starts attach to the same run', async () => {
    model = createMockModel({ responses: [JSON.stringify(OUTPUT)], chunkDelayInMs: 1 });
    const doc = await meetingNote();
    const results = await Promise.all(Array.from({ length: 5 }, () => start(users.owner, doc.id)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.enhancement.id)).size).toBe(1);
    await settle();
    expect(model.doStreamCalls).toHaveLength(1);
    expect(
      await db.select().from(enhancement).where(eq(enhancement.documentId, doc.id)),
    ).toHaveLength(1);
    // Once finished, a new start is a new run.
    expect((await start(users.owner, doc.id)).status).toBe(201);
    await settle();
  });

  it('fails a stale run and lets a new one start', async () => {
    const doc = await meetingNote();
    const [old] = await db
      .insert(enhancement)
      .values({
        documentId: doc.id,
        model: 'm',
        inputHash: 'h',
        inputNotesJson: NOTES,
        idempotencyKey: key(),
        startedAt: new Date(Date.now() - 10 * 60_000),
      })
      .returning();
    expect((await latest(users.owner, doc.id)).body.latest).toMatchObject({
      id: old!.id,
      status: 'failed',
      error: { code: 'stale' },
    });
    const events = await readAll(await stream(users.owner, old!.id));
    expect(events.map((e) => e.type)).toEqual(['failed']);
    const next = await start(users.owner, doc.id);
    expect(next.status).toBe(201);
    await settle();
  });
});

describe('crash recovery and re-enhancing', () => {
  it('a retry after a crash takes over the dead run’s lock (no `busy`)', async () => {
    const doc = await meetingNote();
    // A run that died mid-way: still `generating` long ago (DB clock), its lock still held.
    const [dead] = await db
      .insert(enhancement)
      .values({
        documentId: doc.id,
        model: 'm',
        inputHash: 'h',
        inputNotesJson: NOTES,
        idempotencyKey: key(),
        startedAt: sql`now() - interval '10 minutes'`,
      })
      .returning();
    expect(await broker.lock(doc.id, dead!.id, 60 * 60_000)).toBe(true);

    const retry = await start(users.owner, doc.id);
    expect(retry).toMatchObject({ status: 201, body: { attached: false } });
    expect(await run(dead!.id)).toMatchObject({
      status: 'failed',
      outputJson: { error: { code: 'stale' } },
    });
    expect(await broker.holder(doc.id)).toBe(retry.body.enhancement.id);
    await settle();
    expect((await run(retry.body.enhancement.id)).status).toBe('completed');
    expect(await broker.holder(doc.id)).toBeNull();
  });

  it('judges staleness by the database clock, not the app clock', async () => {
    const doc = await meetingNote();
    // Started "just now" by the DB clock: live, whatever the app clock says.
    const [live] = await db
      .insert(enhancement)
      .values({
        documentId: doc.id,
        model: 'm',
        inputHash: 'h',
        inputNotesJson: NOTES,
        idempotencyKey: key(),
        startedAt: sql`now()`,
      })
      .returning();
    const realNow = Date.now;
    Date.now = () => realNow() + 60 * 60_000; // app clock an hour ahead
    try {
      expect((await latest(users.owner, doc.id)).body.latest).toMatchObject({
        id: live!.id,
        status: 'generating',
      });
      expect(await start(users.owner, doc.id)).toMatchObject({
        status: 200,
        body: { attached: true, enhancement: { id: live!.id } },
      });
    } finally {
      Date.now = realNow;
    }
    await db.update(enhancement).set({ status: 'failed' }).where(eq(enhancement.id, live!.id));
  });

  it('enhancing an enhanced note uses only my lines and keeps one "Other notes"', async () => {
    const doc = await meetingNote();
    await start(users.owner, doc.id);
    await settle();
    const once = (await body(doc.id)).contentJson as JSONContent;
    const second = await start(users.owner, doc.id);
    expect(second.status).toBe(201);
    await settle();
    const row = await run(second.body.enhancement.id);
    // input_notes_json = my two lines, not the previous AI output.
    expect(texts(row.inputNotesJson as JSONContent)).toEqual([
      'pilot in two clinics',
      'security review',
    ]);
    const twice = (await body(doc.id)).contentJson as JSONContent;
    const count = (doc: JSONContent, t: string) => texts(doc).filter((x) => x === t).length;
    for (const t of ['Other notes', 'Summary', 'pilot in two clinics', 'security review']) {
      expect(count(twice, t)).toBe(count(once, t));
      expect(count(twice, t)).toBe(1);
    }
  });
});

describe('streaming', () => {
  it('streams previews then the result, and resumes after Last-Event-ID', async () => {
    // Slow enough that the reader attaches mid-run.
    model = createMockModel({ responses: [JSON.stringify(OUTPUT)], chunkDelayInMs: 15 });
    const doc = await meetingNote();
    const started = await start(users.owner, doc.id);
    const id = started.body.enhancement.id;

    // First connection: read until the first preview, then drop it.
    const abort = new AbortController();
    const res = await stream(users.owner, id, { signal: abort.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let first: SseEvent | undefined;
    while (!first) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      first = parseSse(buffer).find((e) => e.type === 'preview');
    }
    abort.abort();
    await reader.cancel().catch(() => undefined);
    expect(first).toBeDefined();
    expect(first!.data.type).toBe('preview');

    // Reconnect with Last-Event-ID: only later events, ending with `completed`.
    const resumed = await readAll(
      await stream(users.owner, id, { headers: { 'last-event-id': first!.id } }),
    );
    expect(resumed.length).toBeGreaterThan(0);
    expect(resumed.every((e) => e.id === 'final' || Number(e.id) > Number(first!.id))).toBe(true);
    const done = resumed.at(-1)!;
    expect(done.type).toBe('completed');
    const completed = done.data as Extract<EnhanceEvent, { type: 'completed' }>;
    expect(completed.enhancement).toMatchObject({ id, status: 'completed', applied: true });
    expect(completed.doc).toEqual((await body(doc.id)).contentJson);
    // Previews carry derived origins too.
    const previews = resumed.filter((e) => e.type === 'preview');
    for (const p of previews) {
      const output = (p.data as Extract<EnhanceEvent, { type: 'preview' }>).output;
      expect(output.sections.length).toBeGreaterThan(0);
    }
    await settle();
  });

  it('answers a finished run with its terminal event at once (no live events needed)', async () => {
    const doc = await meetingNote();
    const started = await start(users.owner, doc.id);
    await settle();
    const fresh = createMemoryBroker();
    const api2 = createEnhanceApi(
      {
        db: () => db,
        getSession: async (headers) => ({ user: { id: headers.get('x-test-user')! } }),
        allowedOrigins: () => [BASE],
      },
      { ...deps, broker: fresh },
    );
    const res = await request(
      api2.enhancementStream.GET,
      'GET',
      '/x',
      started.body.enhancement.id,
      { as: users.owner },
    );
    const events = await readAll(res);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: 'final', type: 'completed' });
  });
});
