/**
 * Templates API against a throwaway migrated database: the exact route handlers, called the way Next.js
 * calls them. Sessions are faked (`x-test-user` header → user id): Better Auth's own session handling is
 * covered by `@oat/auth`; what matters here is authorization by workspace role.
 */
import { BUILTIN_TEMPLATES, getBuiltinTemplate } from '@oat/ai/templates';
import { createDb, type Db, membership, migrate, newId, template, user, workspace } from '@oat/db';
import { createTestDatabase, type TestDatabase } from '@oat/testkit';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiErrorBody } from '@/lib/api-types';
import type { TemplateDetail, TemplateDto, TemplateList } from '@/lib/templates';

import { denies } from '../api/authz-markers';
import type { RouteHandler } from '../api/route';
import { createTemplatesApi, type TemplatesApi } from './api';

const BASE = 'http://localhost:3000';

let testDb: TestDatabase;
let db: Db;
let api: TemplatesApi;

type Role = 'owner' | 'admin' | 'member' | 'viewer';
const users = {} as Record<'owner' | 'member' | 'viewer' | 'outsider', string>;
let teamId: string;
let otherTeamId: string;

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

beforeAll(async () => {
  testDb = await createTestDatabase();
  await migrate(testDb.url);
  db = createDb(testDb.url, { max: 4 });
  api = createTemplatesApi({
    db: () => db,
    getSession: async (headers) => {
      const id = headers.get('x-test-user');
      return id ? { user: { id } } : null;
    },
    allowedOrigins: () => [BASE],
  });
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

afterAll(async () => {
  await db?.$client.end();
  await testDb?.drop();
});

type Call = {
  as: string | null;
  body?: unknown;
  params?: Record<string, string>;
  origin?: string | null;
  bearer?: boolean;
  raw?: string;
};
type Result<T> = { status: number; body: T; error?: ApiErrorBody['error'] };

async function call<T = unknown>(
  handler: RouteHandler<never>,
  method: string,
  path: string,
  options: Call,
): Promise<Result<T>> {
  const headers = new Headers();
  const origin = options.origin === undefined ? BASE : options.origin;
  if (origin !== null) headers.set('origin', origin);
  if (options.as) headers.set('x-test-user', options.as);
  if (options.bearer) headers.set('authorization', 'Bearer test');
  let body: string | undefined;
  if (options.raw !== undefined || options.body !== undefined) {
    body = options.raw ?? JSON.stringify(options.body);
    headers.set('content-type', 'application/json');
  }
  const res = await (handler as RouteHandler<Record<string, string>>)(
    new Request(`${BASE}${path}`, { method, headers, body }),
    { params: Promise.resolve(options.params ?? {}) },
  );
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : undefined;
  const error = (json as Partial<ApiErrorBody> | undefined)?.error;
  return { status: res.status, body: json as T, ...(error ? { error } : {}) };
}

const list = (as: string | null, workspaceId = teamId) =>
  call<TemplateList>(api.templates.GET, 'GET', `/api/templates?workspaceId=${workspaceId}`, { as });
const create = (as: string, body: unknown, extra: Partial<Call> = {}) =>
  call<TemplateDetail>(api.templates.POST, 'POST', '/api/templates', { as, body, ...extra });
const get = (as: string, id: string, workspaceId?: string) =>
  call<TemplateDetail>(
    api.template.GET,
    'GET',
    `/api/templates/${id}${workspaceId ? `?workspaceId=${workspaceId}` : ''}`,
    { as, params: { id } },
  );
const patch = (as: string, id: string, body: unknown, extra: Partial<Call> = {}) =>
  call<TemplateDetail>(api.template.PATCH, 'PATCH', `/api/templates/${id}`, {
    as,
    body,
    params: { id },
    ...extra,
  });
const remove = (as: string, id: string) =>
  call(api.template.DELETE, 'DELETE', `/api/templates/${id}`, { as, params: { id } });

const retro = {
  name: 'Retro',
  instructions: 'Blameless.',
  sections: [
    { heading: 'Went well', instructions: 'Wins.' },
    { heading: 'To change', instructions: 'What to try next time.' },
    { heading: 'Actions', instructions: '' },
  ],
};

const general = getBuiltinTemplate('general')!;

describe('built-ins', () => {
  it('are seeded on first use and listed in their fixed order for any member', async () => {
    const res = await list(users.viewer);
    expect(res.status).toBe(200);
    expect(res.body.builtins.map((t) => t.id)).toEqual(BUILTIN_TEMPLATES.map((t) => t.id));
    expect(res.body.builtins[0]).toMatchObject({
      name: general.name,
      instructions: general.instructions,
      sections: general.sections,
      isBuiltin: true,
      workspaceId: null,
    });
    const rows = await db.select().from(template).where(eq(template.isBuiltin, true));
    expect(rows).toHaveLength(BUILTIN_TEMPLATES.length);
  });

  it('are readable by anyone signed in, never editable', async () => {
    const res = await get(users.outsider, general.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ canEdit: false, canDuplicate: false });
    expect((await get(users.member, general.id, teamId)).body.canDuplicate).toBe(true);
    expect((await get(users.viewer, general.id, teamId)).body.canDuplicate).toBe(false);
    // A workspace the caller isn't in grants nothing.
    expect((await get(users.member, general.id, otherTeamId)).body.canDuplicate).toBe(false);

    for (const as of [users.owner, users.member]) {
      const edit = await patch(as, general.id, { name: 'Mine now' });
      expect(edit.status).toBe(403);
      expect(edit.error?.code).toBe('builtin_read_only');
      expect((await remove(as, general.id)).error?.code).toBe('builtin_read_only');
    }
    const [row] = await db.select().from(template).where(eq(template.id, general.id));
    expect(row!.name).toBe(general.name);
  });
});

describe('session and CSRF', () => {
  it('401 without a session', async () => {
    expect((await list(null)).status).toBe(401);
    expect(
      (await call(api.template.GET, 'GET', '/x', { as: null, params: { id: general.id } })).status,
    ).toBe(401);
  });

  it('refuses cookie writes from other origins, allows bearer clients', async () => {
    const cross = await create(
      users.member,
      { workspaceId: teamId, ...retro },
      { origin: 'https://evil.test' },
    );
    expect(cross.status).toBe(403);
    expect(cross.error?.code).toBe('cross_site');
    expect(
      (await create(users.member, { workspaceId: teamId, ...retro }, { origin: null })).status,
    ).toBe(403);
    const bearer = await create(
      users.member,
      { workspaceId: teamId, ...retro, name: 'Via desktop' },
      { origin: null, bearer: true },
    );
    expect(bearer.status).toBe(201);
  });
});

describe('custom templates', () => {
  let created: TemplateDto;

  it('members create them in their workspace', async () => {
    const res = await create(users.member, { workspaceId: teamId, ...retro });
    expect(res.status).toBe(201);
    created = res.body.template;
    expect(created).toMatchObject({ ...retro, workspaceId: teamId, isBuiltin: false });
    expect(res.body.canEdit).toBe(true);
    const listed = await list(users.viewer);
    expect(listed.body.custom.map((t) => t.id)).toContain(created.id);
  });

  it('viewers and outsiders cannot create', async () => {
    denies('POST /api/templates');
    const viewer = await create(users.viewer, { workspaceId: teamId, ...retro });
    expect(viewer.status).toBe(403);
    const outsider = await create(users.outsider, { workspaceId: teamId, ...retro });
    expect(outsider.status).toBe(404);
    expect((await list(users.viewer)).body.canCreate).toBe(false);
    expect((await list(users.member)).body.canCreate).toBe(true);
  });

  it('outsiders cannot see them at all (404, not 403)', async () => {
    denies(
      'GET /api/templates',
      'GET /api/templates/[id]',
      'PATCH /api/templates/[id]',
      'DELETE /api/templates/[id]',
    );
    expect((await list(users.outsider)).status).toBe(404);
    expect((await get(users.outsider, created.id)).status).toBe(404);
    expect((await patch(users.outsider, created.id, { name: 'x' })).status).toBe(404);
    expect((await remove(users.outsider, created.id)).status).toBe(404);
    expect((await get(users.member, newId())).status).toBe(404);
  });

  it('viewers read but cannot edit or delete', async () => {
    const res = await get(users.viewer, created.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ canEdit: false, canDuplicate: false });
    expect((await patch(users.viewer, created.id, { name: 'x' })).status).toBe(403);
    expect((await remove(users.viewer, created.id)).status).toBe(403);
  });

  it('members edit: rename and reorder sections', async () => {
    const reordered = [retro.sections[2]!, retro.sections[0]!, retro.sections[1]!];
    const res = await patch(users.owner, created.id, {
      name: '  Sprint retro ',
      sections: reordered,
    });
    expect(res.status).toBe(200);
    expect(res.body.template).toMatchObject({
      name: 'Sprint retro',
      instructions: retro.instructions,
      sections: reordered,
    });
    expect((await get(users.member, created.id)).body.template.sections).toEqual(reordered);
  });

  it.each([
    ['an empty patch', {}, /Nothing to update/],
    ['no sections', { sections: [] }, /at least one section/],
    [
      'duplicate headings',
      {
        sections: [
          { heading: 'A', instructions: '' },
          { heading: 'a', instructions: '' },
        ],
      },
      /unique/,
    ],
    ['a long name', { name: 'x'.repeat(81) }, /80 characters/],
  ])('rejects %s with 400', async (_label, body, message) => {
    const res = await patch(users.member, created.id, body);
    expect(res.status).toBe(400);
    expect(res.error?.message).toMatch(message);
  });

  it('rejects malformed and non-JSON bodies', async () => {
    const malformed = await call(api.templates.POST, 'POST', '/api/templates', {
      as: users.member,
      raw: '{',
    });
    expect(malformed.status).toBe(400);
    expect((await create(users.member, { workspaceId: teamId })).status).toBe(400);
    expect((await list(users.member, '')).status).toBe(400);
  });

  it('members delete them', async () => {
    expect((await remove(users.member, created.id)).status).toBe(204);
    expect((await get(users.member, created.id)).status).toBe(404);
  });
});

describe('duplicate', () => {
  it('copies a built-in into the workspace as a custom template', async () => {
    const first = await create(users.member, { workspaceId: teamId, fromTemplateId: general.id });
    expect(first.status).toBe(201);
    expect(first.body.template).toMatchObject({
      name: 'General (copy)',
      instructions: general.instructions,
      sections: general.sections,
      workspaceId: teamId,
      isBuiltin: false,
    });
    expect(first.body.template.id).not.toBe(general.id);
    const second = await create(users.member, { workspaceId: teamId, fromTemplateId: general.id });
    expect(second.body.template.name).toBe('General (copy 2)');
  });

  it('copies a custom template', async () => {
    const source = await create(users.member, { workspaceId: teamId, ...retro, name: 'Source' });
    const copy = await create(users.owner, {
      workspaceId: teamId,
      fromTemplateId: source.body.template.id,
    });
    expect(copy.body.template).toMatchObject({ name: 'Source (copy)', sections: retro.sections });
  });

  it('needs create rights in the target and read access to the source', async () => {
    expect(
      (await create(users.viewer, { workspaceId: teamId, fromTemplateId: general.id })).status,
    ).toBe(403);
    const theirs = await create(users.outsider, {
      workspaceId: otherTeamId,
      ...retro,
      name: 'Private to them',
    });
    expect(theirs.status).toBe(201);
    const steal = await create(users.member, {
      workspaceId: teamId,
      fromTemplateId: theirs.body.template.id,
    });
    expect(steal.status).toBe(404);
    expect(
      (await create(users.member, { workspaceId: otherTeamId, fromTemplateId: general.id })).status,
    ).toBe(404);
  });
});
