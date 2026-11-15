/**
 * Action items (8.4) end to end: document writes → change_log → worker → `action_item` rows. Throwaway database;
 * the shared compose Redis with a unique key prefix per queue.
 */
import { createMockEmbeddingModel } from '@oat/ai/testing';
import { listActionItems, replaceDocumentActionItems, schema as s } from '@oat/db';
import type { JSONContent } from '@oat/editor';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractActionItems, syncActionItems } from './action-items.ts';
import {
  type Env,
  makeDocument,
  makeUser,
  makeWorkspace,
  setupEnv,
  sync,
  teardownEnv,
  testQueue,
} from './int-fixtures.ts';
import { createIndexWorker, type IndexWorker } from './worker.ts';

let env: Env;
let alice: string;
let bob: string;
let outsider: string;
let ws: string;
let worker: IndexWorker;

const task = (id: string, text: string, attrs: Record<string, unknown> = {}): JSONContent => ({
  type: 'taskItem',
  attrs: { id, checked: false, ...attrs },
  content: [{ type: 'paragraph', attrs: { id: `${id}-p` }, content: [{ type: 'text', text }] }],
});
const doc = (...items: JSONContent[]): JSONContent => ({
  type: 'doc',
  content: [{ type: 'taskList', attrs: { id: 'list' }, content: items }],
});

const itemsOf = (documentId: string) =>
  env.db
    .select()
    .from(s.actionItem)
    .where(eq(s.actionItem.documentId, documentId))
    .orderBy(asc(s.actionItem.ordinal));

beforeAll(async () => {
  env = await setupEnv();
  [alice, bob, outsider] = await Promise.all([
    makeUser(env.db, 'Alice'),
    makeUser(env.db, 'Bob'),
    makeUser(env.db, 'Outsider'),
  ]);
  ws = await makeWorkspace(env.db, alice, [[bob, 'member']]);
  worker = createIndexWorker({
    db: env.db,
    queue: testQueue(env),
    embeddingModel: createMockEmbeddingModel(),
  });
});
afterAll(() => teardownEnv(env));

describe('extractActionItems', () => {
  it('takes every task item in order (nested too), with owner/due/done; skips empty ones', () => {
    const body: JSONContent = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'not a task' }] },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { id: 't1', checked: true, owner: { name: 'Dana' }, due: '2026-11-20' },
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: 'Ping ' },
                    { type: 'mention', attrs: { id: 'u1', label: 'Sam' } },
                    { type: 'hardBreak' },
                    { type: 'text', text: '  today' },
                  ],
                },
                { type: 'taskList', content: [task('t2', 'Nested')] },
              ],
            },
            task('t3', '   '),
            task('t4', 'Bad attrs', { owner: { name: '' }, due: 'Friday' }),
          ],
        },
      ],
    };
    expect(extractActionItems(body)).toEqual([
      {
        blockId: 't1',
        ordinal: 0,
        text: 'Ping @Sam today',
        owner: { name: 'Dana' },
        due: '2026-11-20',
        done: true,
      },
      { blockId: 't2', ordinal: 1, text: 'Nested', owner: null, due: null, done: false },
      { blockId: 't4', ordinal: 2, text: 'Bad attrs', owner: null, due: null, done: false },
    ]);
    expect(extractActionItems(null)).toEqual([]);
  });
});

describe('action items via the worker', () => {
  it('follows document writes: insert, update, delete missing, idempotent', async () => {
    const [bobRow] = await env.db.select().from(s.user).where(eq(s.user.id, bob));
    const id = await makeDocument(env.db, {
      workspaceId: ws,
      ownerId: alice,
      visibility: 'workspace',
      content: doc(
        task('a', 'Send the deck', { owner: { name: 'Bob', userId: bob }, due: '2026-11-20' }),
        task('b', 'Book a room', { owner: { name: 'Bob B', email: bobRow!.email.toUpperCase() } }),
        task('c', 'Fake owner', { owner: { name: 'Mallory', userId: outsider } }),
        task('d', 'External', { owner: { name: 'Riley', email: 'riley@client.test' } }),
      ),
    });
    await sync(worker, id);
    const rows = await itemsOf(id);
    expect(
      rows.map((r) => [r.blockId, r.text, r.ownerUserId, r.ownerName, r.ownerEmail, r.due, r.done]),
    ).toEqual([
      // A member's email is filled in from their account.
      ['a', 'Send the deck', bob, 'Bob', bobRow!.email, '2026-11-20', false],
      // Matched by email (case-insensitive) to a member.
      ['b', 'Book a room', bob, 'Bob B', bobRow!.email.toUpperCase(), null, false],
      // A user id that isn't a member of the workspace is not trusted.
      ['c', 'Fake owner', null, 'Mallory', null, null, false],
      ['d', 'External', null, 'Riley', 'riley@client.test', null, false],
    ]);
    const firstIds = rows.map((r) => r.id);

    // Tick one, drop one, add one.
    await env.db
      .update(s.document)
      .set({
        contentJson: doc(
          task('a', 'Send the deck', { checked: true, owner: { name: 'Bob', userId: bob } }),
          task('b', 'Book a room'),
          task('e', 'New one'),
        ),
        version: 1,
      })
      .where(eq(s.document.id, id));
    await sync(worker, id);
    const next = await itemsOf(id);
    expect(next.map((r) => [r.blockId, r.done, r.ownerUserId, r.due])).toEqual([
      ['a', true, bob, null],
      ['b', false, null, null],
      ['e', false, null, null],
    ]);
    // Row ids are stable per block.
    expect(next[0]!.id).toBe(firstIds[0]);
    expect(next.every((r) => r.documentVersion === 1)).toBe(true);

    // Unchanged content: nothing written.
    const again = await syncActionItems(env.db, id);
    expect(again).toMatchObject({
      status: 'written',
      inserted: 0,
      updated: 0,
      deleted: 0,
      unchanged: 3,
    });
  });

  it('never lets an older extraction overwrite a newer one', async () => {
    const id = await makeDocument(env.db, {
      workspaceId: ws,
      ownerId: alice,
      content: doc(task('a', 'Task')),
    });
    await env.db.update(s.document).set({ version: 5 }).where(eq(s.document.id, id));
    await syncActionItems(env.db, id);
    const stale = await replaceDocumentActionItems(
      env.db,
      { documentId: id, workspaceId: ws, documentVersion: 4 },
      [],
    );
    expect(stale.status).toBe('stale');
    expect(await itemsOf(id)).toHaveLength(1);
  });

  it('rows go with their document', async () => {
    const id = await makeDocument(env.db, {
      workspaceId: ws,
      ownerId: alice,
      content: doc(task('a', 'Gone soon')),
    });
    await syncActionItems(env.db, id);
    expect(await itemsOf(id)).toHaveLength(1);
    await env.db.delete(s.document).where(eq(s.document.id, id));
    expect(await itemsOf(id)).toHaveLength(0);
    expect(await syncActionItems(env.db, id)).toEqual({ status: 'missing' });
  });

  it('lists only what the reader may read', async () => {
    const shared = await makeDocument(env.db, {
      workspaceId: ws,
      ownerId: alice,
      visibility: 'workspace',
      title: 'Shared',
      content: doc(task('s1', 'Shared for Bob', { owner: { name: 'Bob', userId: bob } })),
    });
    const secret = await makeDocument(env.db, {
      workspaceId: ws,
      ownerId: alice,
      visibility: 'private',
      title: 'Private',
      content: doc(task('p1', 'Private for Bob', { owner: { name: 'Bob', userId: bob } })),
    });
    await syncActionItems(env.db, shared);
    await syncActionItems(env.db, secret);

    const bobAssigned = await listActionItems(env.db, {
      userId: bob,
      workspaceIds: [ws],
      scope: 'assigned',
      status: 'all',
    });
    const texts = bobAssigned.map((r) => r.text);
    expect(texts).toContain('Shared for Bob');
    // Assigned to Bob, but in Alice's private note: Bob can't read it.
    expect(texts).not.toContain('Private for Bob');

    const aliceCreated = await listActionItems(env.db, {
      userId: alice,
      workspaceIds: [ws],
      scope: 'created',
      status: 'open',
    });
    expect(aliceCreated.map((r) => r.text)).toEqual(
      expect.arrayContaining(['Shared for Bob', 'Private for Bob']),
    );

    // Not a member: nothing, whatever the workspace list says.
    expect(
      await listActionItems(env.db, {
        userId: outsider,
        workspaceIds: [],
        scope: 'all',
        status: 'all',
      }),
    ).toEqual([]);

    // Trash hides them.
    await env.db.update(s.document).set({ deletedAt: new Date() }).where(eq(s.document.id, shared));
    const afterTrash = await listActionItems(env.db, {
      userId: bob,
      workspaceIds: [ws],
      scope: 'assigned',
      status: 'all',
    });
    expect(afterTrash.map((r) => r.text)).not.toContain('Shared for Bob');
  });

  it('filters by due date and email ownership', async () => {
    const id = await makeDocument(env.db, {
      workspaceId: ws,
      ownerId: bob,
      visibility: 'workspace',
      content: doc(
        task('o', 'Overdue', { owner: { name: 'X', email: 'x@client.test' }, due: '2026-11-10' }),
        task('t', 'Today', { owner: { name: 'X', email: 'x@client.test' }, due: '2026-11-18' }),
        task('w', 'Next week', { owner: { name: 'X', email: 'x@client.test' }, due: '2026-11-25' }),
        task('l', 'Later', { owner: { name: 'X', email: 'x@client.test' }, due: '2026-12-25' }),
      ),
    });
    await syncActionItems(env.db, id);
    const base = {
      userId: alice,
      emails: ['X@client.test'],
      workspaceIds: [ws],
      scope: 'assigned' as const,
      status: 'open' as const,
      today: '2026-11-18',
    };
    const texts = async (due: 'any' | 'overdue' | 'soon') =>
      (await listActionItems(env.db, { ...base, due })).map((r) => r.text);
    expect(await texts('any')).toEqual(['Overdue', 'Today', 'Next week', 'Later']);
    expect(await texts('overdue')).toEqual(['Overdue']);
    expect(await texts('soon')).toEqual(['Today', 'Next week']);
  });
});
