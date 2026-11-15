/**
 * "My tasks" API (8.4) against a throwaway migrated database: the exact route handlers, called the way Next.js
 * calls them. Sessions are faked (`x-test-user` header → user id); what matters here is who may list, tick
 * and assign which items. Action items are extracted with `syncActionItems` (the worker's step) directly.
 */
import {
  actionItem,
  createDb,
  type Db,
  document,
  meeting,
  membership,
  migrate,
  newId,
  participant,
  user,
  workspace,
} from '@oat/db';
import type { JSONContent } from '@oat/editor';
import { syncActionItems } from '@oat/indexing';
import { createTestDatabase, type TestDatabase } from '@oat/testkit';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiErrorBody } from '@/lib/api-types';
import type { TaskAssigneesResponse, TaskListResponse } from '@/lib/tasks';

import { denies } from '../api/authz-markers';
import type { RouteHandler } from '../api/route';
import { createTasksApi, type TasksApi } from './api';

const BASE = 'http://localhost:3000';

let testDb: TestDatabase;
let db: Db;
let api: TasksApi;

type Role = 'owner' | 'admin' | 'member' | 'viewer';
const users = {} as Record<'alice' | 'bob' | 'viewer' | 'outsider', { id: string; email: string }>;
let team: string;
let sharedDoc: string;
let privateDoc: string;

async function addUser(label: string) {
  const email = `${label}-${newId()}@example.test`;
  const [row] = await db.insert(user).values({ id: newId(), email, name: label }).returning();
  return { id: row!.id, email };
}

async function addWorkspace(members: Array<[string, Role]>): Promise<string> {
  const [ws] = await db
    .insert(workspace)
    .values({ name: 'Team', slug: `team-${newId()}`, kind: 'team', createdBy: members[0]![0] })
    .returning();
  await db
    .insert(membership)
    .values(members.map(([userId, role]) => ({ workspaceId: ws!.id, userId, role })));
  return ws!.id;
}

const task = (id: string, text: string, attrs: Record<string, unknown> = {}): JSONContent => ({
  type: 'taskItem',
  attrs: { id, checked: false, ...attrs },
  content: [{ type: 'paragraph', attrs: { id: `${id}-p` }, content: [{ type: 'text', text }] }],
});
const body = (...items: JSONContent[]): JSONContent => ({
  type: 'doc',
  content: [
    { type: 'heading', attrs: { id: 'h', level: 2 }, content: [{ type: 'text', text: 'Next' }] },
    { type: 'taskList', attrs: { id: 'list' }, content: items },
  ],
});

async function addDoc(input: {
  ownerId: string;
  visibility: 'private' | 'workspace';
  title: string;
  content: JSONContent;
}): Promise<string> {
  const [row] = await db
    .insert(document)
    .values({
      workspaceId: team,
      ownerId: input.ownerId,
      kind: 'meeting',
      title: input.title,
      visibility: input.visibility,
      contentJson: input.content,
      version: 3,
    })
    .returning();
  await syncActionItems(db, row!.id);
  return row!.id;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await migrate(testDb.url);
  db = createDb(testDb.url, { max: 4 });
  api = createTasksApi({
    db: () => db,
    getSession: async (headers) => {
      const id = headers.get('x-test-user');
      return id ? { user: { id } } : null;
    },
    allowedOrigins: () => [BASE],
  });
  users.alice = await addUser('alice');
  users.bob = await addUser('bob');
  users.viewer = await addUser('viewer');
  users.outsider = await addUser('outsider');
  team = await addWorkspace([
    [users.alice.id, 'owner'],
    [users.bob.id, 'member'],
    [users.viewer.id, 'viewer'],
  ]);
  await addWorkspace([[users.outsider.id, 'owner']]);

  sharedDoc = await addDoc({
    ownerId: users.alice.id,
    visibility: 'workspace',
    title: 'Pricing sync',
    content: body(
      task('t-bob', 'Send the deck', {
        owner: { name: 'bob', userId: users.bob.id },
        due: '2026-11-20',
      }),
      task('t-alice', 'Book the room', { owner: { name: 'alice', userId: users.alice.id } }),
      task('t-email', 'Bob by email', { owner: { name: 'Bob', email: users.bob.email } }),
      task('t-none', 'Unassigned', { checked: true }),
    ),
  });
  const [m] = await db
    .insert(meeting)
    .values({ documentId: sharedDoc, startedAt: new Date('2026-11-18T16:00:00Z') })
    .returning();
  await db.insert(participant).values({
    meetingId: m!.id,
    name: 'Riley Client',
    source: 'calendar',
    email: 'riley@client.test',
  });
  privateDoc = await addDoc({
    ownerId: users.alice.id,
    visibility: 'private',
    title: 'Alice private',
    content: body(
      task('t-secret', 'Secret for Bob', { owner: { name: 'bob', userId: users.bob.id } }),
    ),
  });
});

afterAll(async () => {
  await db?.$client.end();
  await testDb?.drop();
});

type Result<T> = { status: number; body: T; error?: ApiErrorBody['error'] };

async function call<T = unknown>(
  handler: RouteHandler<never>,
  method: string,
  path: string,
  options: { as: string | null; body?: unknown; params?: Record<string, string>; origin?: string },
): Promise<Result<T>> {
  const headers = new Headers({ origin: options.origin ?? BASE });
  if (options.as) headers.set('x-test-user', options.as);
  let payload: string | undefined;
  if (options.body !== undefined) {
    payload = JSON.stringify(options.body);
    headers.set('content-type', 'application/json');
  }
  const res = await (handler as RouteHandler<Record<string, string>>)(
    new Request(`${BASE}${path}`, { method, headers, body: payload }),
    { params: Promise.resolve(options.params ?? {}) },
  );
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : undefined;
  const error = (json as Partial<ApiErrorBody> | undefined)?.error;
  return { status: res.status, body: json as T, ...(error ? { error } : {}) };
}

const list = (as: string | null, query: string) =>
  call<TaskListResponse>(api.tasks.GET, 'GET', `/api/tasks?${query}`, { as });
const patch = (as: string, id: string, input: unknown, origin?: string) =>
  call<{ id: string; done: boolean; documentVersion: number }>(
    api.task.PATCH,
    'PATCH',
    `/api/tasks/${id}`,
    { as, body: input, params: { id }, ...(origin ? { origin } : {}) },
  );
const assignees = (as: string | null, documentId: string, q = '') =>
  call<TaskAssigneesResponse>(
    api.assignees.GET,
    'GET',
    `/api/tasks/assignees?documentId=${documentId}&q=${encodeURIComponent(q)}`,
    { as },
  );

async function itemId(blockId: string): Promise<string> {
  const [row] = await db.select().from(actionItem).where(eq(actionItem.blockId, blockId));
  return row!.id;
}

describe('GET /api/tasks', () => {
  it('lists my assigned items (by user id or email) from notes I can read', async () => {
    const res = await list(users.bob.id, `view=assigned&status=all&workspaceId=${team}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.text)).toEqual(['Send the deck', 'Bob by email']);
    expect(res.body.truncated).toBe(false);
    const [first] = res.body.items;
    expect(first).toMatchObject({
      blockId: 't-bob',
      done: false,
      due: '2026-11-20',
      owner: { name: 'bob', userId: users.bob.id, isMe: true },
      document: {
        id: sharedDoc,
        title: 'Pricing sync',
        kind: 'meeting',
        version: 3,
        date: '2026-11-18T16:00:00.000Z',
        canEdit: true,
      },
    });
  });

  it('created by me / all in workspace / status and due filters', async () => {
    const created = await list(users.alice.id, 'view=created&status=all');
    expect(created.body.items.map((i) => i.text)).toEqual(
      expect.arrayContaining(['Send the deck', 'Secret for Bob']),
    );
    const all = await list(users.bob.id, `view=all&status=open&workspaceId=${team}`);
    expect(all.body.items.map((i) => i.text)).toEqual([
      'Send the deck',
      'Book the room',
      'Bob by email',
    ]);
    const done = await list(users.bob.id, 'view=all&status=done');
    expect(done.body.items.map((i) => i.text)).toEqual(['Unassigned']);
    const overdue = await list(users.bob.id, 'view=all&status=open&due=overdue&today=2026-11-25');
    expect(overdue.body.items.map((i) => i.text)).toEqual(['Send the deck']);
    const soon = await list(users.bob.id, 'view=all&status=open&due=soon&today=2026-11-25');
    expect(soon.body.items).toEqual([]);
    // A viewer sees shared items but can't tick them.
    const viewer = await list(users.viewer.id, 'view=all&status=all');
    expect(viewer.body.items.every((i) => i.document.canEdit === false)).toBe(true);
    expect(viewer.body.items.map((i) => i.text)).not.toContain('Secret for Bob');
  });

  it('denies other workspaces and hides private notes', async () => {
    denies('GET /api/tasks');
    const outsider = await list(users.outsider.id, `view=all&status=all&workspaceId=${team}`);
    expect(outsider.status).toBe(404);
    const everywhere = await list(users.outsider.id, 'view=all&status=all');
    expect(everywhere.body.items).toEqual([]);
    const bob = await list(users.bob.id, 'view=assigned&status=all');
    expect(bob.body.items.map((i) => i.text)).not.toContain('Secret for Bob');
    expect((await list(null, 'view=all')).status).toBe(401);
    expect((await list(users.bob.id, 'view=everything')).status).toBe(400);
    expect((await list(users.bob.id, 'today=tomorrow')).status).toBe(400);
  });
});

describe('PATCH /api/tasks/:id', () => {
  it('ticks the item in its note at baseVersion, then the list follows', async () => {
    const id = await itemId('t-bob');
    const res = await patch(users.bob.id, id, { done: true, baseVersion: 3 });
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    expect(res.body).toEqual({ id, done: true, documentVersion: 4 });

    const [doc] = await db.select().from(document).where(eq(document.id, sharedDoc));
    expect(doc!.version).toBe(4);
    const items = (doc!.contentJson as JSONContent).content![1]!.content!;
    expect(items.find((i) => i.attrs?.id === 't-bob')?.attrs).toMatchObject({
      checked: true,
      owner: { name: 'bob', userId: users.bob.id },
    });
    expect(doc!.contentMd).toContain('- [x] Send the deck (@bob, due 2026-11-20)');

    const [row] = await db.select().from(actionItem).where(eq(actionItem.id, id));
    expect(row).toMatchObject({ done: true, documentVersion: 4 });
  });

  it('refuses a stale baseVersion with 409 and the server copy', async () => {
    const id = await itemId('t-alice');
    const res = await patch(users.alice.id, id, { done: true, baseVersion: 3 });
    expect(res.status).toBe(409);
    expect(res.error?.code).toBe('stale_version');
    expect((res.body as unknown as ApiErrorBody).document?.version).toBe(4);
    const retry = await patch(users.alice.id, id, { done: true, baseVersion: 4 });
    expect(retry.status).toBe(200);
  });

  it('viewers get 403, outsiders and other people’s private notes 404', async () => {
    denies('PATCH /api/tasks/[id]');
    const shared = await itemId('t-email');
    expect((await patch(users.viewer.id, shared, { done: true, baseVersion: 5 })).status).toBe(403);
    expect((await patch(users.outsider.id, shared, { done: true, baseVersion: 5 })).status).toBe(
      404,
    );
    const secret = await itemId('t-secret');
    expect((await patch(users.bob.id, secret, { done: true, baseVersion: 3 })).status).toBe(404);
    expect((await patch(users.bob.id, 'nope', { done: true, baseVersion: 3 })).status).toBe(404);
    // Cross-site cookie writes are refused before anything else.
    expect(
      (await patch(users.bob.id, shared, { done: true, baseVersion: 5 }, 'https://evil.test'))
        .status,
    ).toBe(403);
    // Nothing changed.
    const [doc] = await db.select().from(document).where(eq(document.id, privateDoc));
    expect(doc!.version).toBe(3);
  });

  it('validates the body', async () => {
    const id = await itemId('t-none');
    expect((await patch(users.bob.id, id, { done: 'yes', baseVersion: 1 })).status).toBe(400);
    expect((await patch(users.bob.id, id, { done: true })).status).toBe(400);
  });

  it('404s an item whose block left the note (and drops the stale row)', async () => {
    const id = await itemId('t-none');
    const [doc] = await db.select().from(document).where(eq(document.id, sharedDoc));
    await db
      .update(document)
      .set({
        contentJson: body(task('t-bob', 'Send the deck')),
        version: doc!.version + 1,
      })
      .where(eq(document.id, sharedDoc));
    const res = await patch(users.bob.id, id, { done: false, baseVersion: doc!.version + 1 });
    expect(res.status).toBe(404);
    expect(await db.select().from(actionItem).where(eq(actionItem.id, id))).toEqual([]);
  });
});

describe('GET /api/tasks/assignees', () => {
  it('lists workspace members (me first) and the meeting’s participants', async () => {
    const res = await assignees(users.bob.id, sharedDoc);
    expect(res.status).toBe(200);
    expect(res.body.people[0]).toEqual({
      name: 'bob',
      email: users.bob.email,
      userId: users.bob.id,
    });
    expect(res.body.people.map((p) => p.name)).toEqual(
      expect.arrayContaining(['alice', 'viewer', 'Riley Client']),
    );
    expect(res.body.people.map((p) => p.name)).not.toContain('outsider');
    const filtered = await assignees(users.bob.id, sharedDoc, 'RIL');
    expect(filtered.body.people).toEqual([{ name: 'Riley Client', email: 'riley@client.test' }]);
  });

  it('needs read access to the note', async () => {
    denies('GET /api/tasks/assignees');
    expect((await assignees(users.outsider.id, sharedDoc)).status).toBe(404);
    expect((await assignees(users.bob.id, privateDoc)).status).toBe(404);
    expect((await assignees(null, sharedDoc)).status).toBe(401);
  });
});
