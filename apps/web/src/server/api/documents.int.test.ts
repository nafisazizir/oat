/**
 * Documents API (3.3) against a throwaway database and a real in-process Better Auth: every route,
 * including the deny cases (anonymous, non-member, viewer write, another member's private document → 404,
 * cross-workspace move), optimistic concurrency (409 on a stale version) and the CSRF guard.
 */
import { findPersonalWorkspaceId } from '@oat/auth';
import { document } from '@oat/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DocumentDetail, DocumentSummary, FolderSummary } from '@/lib/api-types';

import { call, type CallOptions, createHarness, type Harness, type TestUser } from './test-harness';

let h: Harness;
let owner: TestUser; // owner of the team workspace
let admin: TestUser;
let member: TestUser;
let viewer: TestUser;
let outsider: TestUser; // not in the team workspace
let team: string;
let ownerPersonal: string;

beforeAll(async () => {
  h = await createHarness();
  [owner, admin, member, viewer, outsider] = await Promise.all([
    h.signUp('owner'),
    h.signUp('admin'),
    h.signUp('member'),
    h.signUp('viewer'),
    h.signUp('outsider'),
  ]);
  team = await h.teamWorkspace(owner, [
    [admin, 'admin'],
    [member, 'member'],
    [viewer, 'viewer'],
  ]);
  ownerPersonal = (await findPersonalWorkspaceId(h.db, owner.id))!;
}, 60_000);

afterAll(async () => {
  await h?.close();
});

const docs = () => h.api.documents;
const doc = () => h.api.document;

function create(as: TestUser, body: Record<string, unknown>, opts: Partial<CallOptions> = {}) {
  return call<DocumentDetail>(docs().POST, 'POST', '/api/documents', { as, body, ...opts });
}
async function created(as: TestUser, body: Record<string, unknown>): Promise<DocumentDetail> {
  const res = await create(as, body);
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.body;
}
const get = (as: TestUser | null, id: string) =>
  call<DocumentDetail>(doc().GET, 'GET', `/api/documents/${id}`, { as, params: { id } });
const patch = (as: TestUser | null, id: string, body: unknown, opts: Partial<CallOptions> = {}) =>
  call<DocumentDetail>(doc().PATCH, 'PATCH', `/api/documents/${id}`, {
    as,
    body,
    params: { id },
    ...opts,
  });
const trash = (as: TestUser, id: string, permanent = false) =>
  call<DocumentDetail>(
    doc().DELETE,
    'DELETE',
    `/api/documents/${id}${permanent ? '?permanent=1' : ''}`,
    { as, params: { id } },
  );
const restore = (as: TestUser, id: string) =>
  call<DocumentDetail>(h.api.documentRestore.POST, 'POST', `/api/documents/${id}/restore`, {
    as,
    params: { id },
  });
const move = (as: TestUser, id: string, body: unknown) =>
  call<DocumentDetail>(h.api.documentMove.POST, 'POST', `/api/documents/${id}/move`, {
    as,
    body,
    params: { id },
  });
const list = (as: TestUser | null, workspaceId: string, trashed = false) =>
  call<DocumentSummary[]>(
    docs().GET,
    'GET',
    `/api/documents?workspaceId=${workspaceId}${trashed ? '&trash=1' : ''}`,
    { as },
  );
async function folderOf(as: TestUser, body: Record<string, unknown>): Promise<FolderSummary> {
  const res = await call<FolderSummary>(h.api.folders.POST, 'POST', '/api/folders', { as, body });
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.body;
}

const paragraph = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('authentication and CSRF', () => {
  it('anonymous requests get 401 on every route', async () => {
    const id = 'whatever';
    expect((await list(null, team)).status).toBe(401);
    expect((await get(null, id)).status).toBe(401);
    expect((await patch(null, id, { baseVersion: 0, title: 'x' })).status).toBe(401);
    const anon = { as: null, params: { id } };
    expect((await call(docs().POST, 'POST', '/api/documents', { ...anon, body: {} })).status).toBe(
      401,
    );
    expect((await call(doc().DELETE, 'DELETE', `/api/documents/${id}`, anon)).status).toBe(401);
    expect((await call(h.api.documentMove.POST, 'POST', '/x', { ...anon, body: {} })).status).toBe(
      401,
    );
    expect((await call(h.api.documentRestore.POST, 'POST', '/x', anon)).status).toBe(401);
  });

  it('refuses cookie writes from another origin or without an Origin', async () => {
    const body = { workspaceId: ownerPersonal, title: 'csrf' };
    const evil = await create(owner, body, { origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    expect(evil.error?.code).toBe('cross_site');
    expect((await create(owner, body, { origin: null })).status).toBe(403);
    // Reads are not affected.
    expect((await list(owner, ownerPersonal)).status).toBe(200);
  });

  it('a bearer header doesn’t exempt a cookie request from the Origin check', async () => {
    const res = await call(docs().POST, 'POST', '/api/documents', {
      as: owner,
      body: { workspaceId: ownerPersonal },
      origin: 'https://evil.example',
      extraHeaders: { authorization: 'Bearer forged' },
    });
    expect(res.status).toBe(403);
  });

  it('bearer tokens (desktop) authenticate and need no Origin', async () => {
    expect(owner.bearer).not.toBe('');
    const res = await create(
      owner,
      { workspaceId: ownerPersonal, title: 'via bearer' },
      {
        bearer: true,
        origin: null,
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.ownerId).toBe(owner.id);
  });
});

describe('create + read', () => {
  it('creates an empty private page with derived Markdown and version 0', async () => {
    const d = await created(owner, { workspaceId: ownerPersonal, title: '  Hello \n world ' });
    expect(d).toMatchObject({
      title: 'Hello world',
      kind: 'page',
      visibility: 'private',
      folderId: null,
      version: 0,
      deletedAt: null,
      access: { edit: true, delete: true },
    });
    expect(d.contentJson.type).toBe('doc');
    const fetched = await get(owner, d.id);
    expect(fetched.status).toBe(200);
    expect(fetched.body.id).toBe(d.id);
  });

  it('validates content, assigns block ids and stores content_md', async () => {
    const d = await created(owner, {
      workspaceId: ownerPersonal,
      kind: 'meeting',
      contentJson: paragraph('Ship **it**'),
    });
    expect(d.kind).toBe('meeting');
    const block = d.contentJson.content![0]!;
    expect(typeof block.attrs?.id).toBe('string');
    const [row] = await h.db.select().from(document).where(eq(document.id, d.id));
    expect(row!.contentMd).toContain('Ship');

    const unknownNode = await create(owner, {
      workspaceId: ownerPersonal,
      contentJson: { type: 'doc', content: [{ type: 'iframe' }] },
    });
    expect(unknownNode.status).toBe(400);
    expect(unknownNode.error?.code).toBe('invalid_content');

    const badLink = await create(owner, {
      workspaceId: ownerPersonal,
      contentJson: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'x',
                marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
              },
            ],
          },
        ],
      },
    });
    expect(badLink.status).toBe(400);
  });

  it('rejects malformed input', async () => {
    const raw = await create(owner, {}, { raw: { body: 'title=x', type: 'text/plain' } });
    expect(raw.status).toBe(400);
    const notJson = await create(owner, {}, { raw: { body: '{', type: 'application/json' } });
    expect(notJson.status).toBe(400);
    const extra = await create(owner, { workspaceId: ownerPersonal, ownerId: member.id });
    expect(extra.status).toBe(400);
    const linkOnCreate = await create(owner, { workspaceId: ownerPersonal, visibility: 'link' });
    expect(linkOnCreate.status).toBe(400);
    const noWorkspace = await call(docs().GET, 'GET', '/api/documents', { as: owner });
    expect(noWorkspace.status).toBe(400);
  });

  it('non-members get 404 for the workspace; viewers can read but not create', async () => {
    expect((await create(outsider, { workspaceId: team })).status).toBe(404);
    expect((await list(outsider, team)).status).toBe(404);
    const v = await create(viewer, { workspaceId: team });
    expect(v.status).toBe(403);
    expect((await list(viewer, team)).status).toBe(200);
  });

  it('hides another member’s private document as 404 (read, write, trash, move)', async () => {
    const secret = await created(owner, { workspaceId: team, title: 'Secret' });
    expect(secret.visibility).toBe('private');
    for (const user of [member, admin, viewer, outsider]) {
      expect((await get(user, secret.id)).status).toBe(404);
      expect((await patch(user, secret.id, { baseVersion: 0, title: 'x' })).status).toBe(404);
      expect((await trash(user, secret.id)).status).toBe(404);
      expect((await move(user, secret.id, { folderId: null })).status).toBe(404);
      expect((await restore(user, secret.id)).status).toBe(404);
    }
    expect((await list(member, team)).body.map((d) => d.id)).not.toContain(secret.id);
    expect((await list(owner, team)).body.map((d) => d.id)).toContain(secret.id);
    // Unknown ids look the same.
    expect((await get(member, '0190f0f0-0000-7000-8000-000000000000')).status).toBe(404);
  });

  it('workspace documents: members edit, viewers read only, outsiders 404', async () => {
    const shared = await created(owner, { workspaceId: team, visibility: 'workspace' });
    const asMember = await get(member, shared.id);
    expect(asMember.body.access).toEqual({ edit: true, delete: false });
    const asViewer = await get(viewer, shared.id);
    expect(asViewer.status).toBe(200);
    expect(asViewer.body.access).toEqual({ edit: false, delete: false });
    expect((await patch(viewer, shared.id, { baseVersion: 0, title: 'v' })).status).toBe(403);
    expect((await get(outsider, shared.id)).status).toBe(404);
    const edited = await patch(member, shared.id, { baseVersion: 0, title: 'By member' });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ title: 'By member', version: 1 });
  });
});

describe('update + optimistic concurrency (D-19)', () => {
  it('bumps the version on every accepted write and refuses a stale base with 409 + server copy', async () => {
    const d = await created(owner, { workspaceId: ownerPersonal });
    const first = await patch(owner, d.id, { baseVersion: 0, contentJson: paragraph('one') });
    expect(first.status).toBe(200);
    expect(first.body.version).toBe(1);

    const stale = await patch(owner, d.id, { baseVersion: 0, contentJson: paragraph('stale') });
    expect(stale.status).toBe(409);
    expect(stale.error?.code).toBe('stale_version');
    const server = (stale.body as unknown as { document: DocumentDetail }).document;
    expect(server.version).toBe(1);
    expect(JSON.stringify(server.contentJson)).toContain('one');

    const [row] = await h.db.select().from(document).where(eq(document.id, d.id));
    expect(row!.contentMd.trim()).toBe('one');
    expect(row!.version).toBe(1);
  });

  it('two racing writers on the same base: exactly one wins', async () => {
    const d = await created(owner, { workspaceId: ownerPersonal });
    const results = await Promise.all(
      ['a', 'b', 'c'].map((t) => patch(owner, d.id, { baseVersion: 0, title: t })),
    );
    expect(results.map((r) => r.status).toSorted()).toEqual([200, 409, 409]);
  });

  it('rejects an empty update and invalid content', async () => {
    const d = await created(owner, { workspaceId: ownerPersonal });
    expect((await patch(owner, d.id, { baseVersion: 0 })).status).toBe(400);
    const bad = await patch(owner, d.id, {
      baseVersion: 0,
      contentJson: { type: 'doc', content: [{ type: 'paragraph', attrs: { origin: 'robot' } }] },
    });
    expect(bad.status).toBe(400);
    expect(bad.error?.code).toBe('invalid_content');
  });
});

describe('move (D-18)', () => {
  it('into a private folder: needs confirmation, then the document becomes private', async () => {
    const privateFolder = await folderOf(owner, { workspaceId: team, name: 'Mine' });
    expect(privateFolder.visibility).toBe('private');
    const shared = await created(owner, { workspaceId: team, visibility: 'workspace' });

    const unconfirmed = await move(owner, shared.id, { folderId: privateFolder.id });
    expect(unconfirmed.status).toBe(422);
    expect(unconfirmed.error?.code).toBe('confirm_private');

    const moved = await move(owner, shared.id, { folderId: privateFolder.id, makePrivate: true });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      folderId: privateFolder.id,
      visibility: 'private',
      version: 1,
    });
    expect((await get(member, shared.id)).status).toBe(404);

    // Back to the root: stays private, no confirmation needed.
    const back = await move(owner, shared.id, { folderId: null });
    expect(back.body).toMatchObject({ folderId: null, visibility: 'private' });
  });

  it('refuses moving someone else’s document into your private folder', async () => {
    const shared = await created(owner, { workspaceId: team, visibility: 'workspace' });
    const memberFolder = await folderOf(member, { workspaceId: team, name: 'Member private' });
    const res = await move(member, shared.id, { folderId: memberFolder.id, makePrivate: true });
    expect(res.status).toBe(403);
    // …and the owner can't see the member's private folder at all.
    expect((await move(owner, shared.id, { folderId: memberFolder.id })).status).toBe(404);
  });

  it('refuses cross-workspace moves (the other workspace’s folder is “not found”)', async () => {
    const personalDoc = await created(owner, { workspaceId: ownerPersonal });
    const teamFolder = await folderOf(owner, {
      workspaceId: team,
      name: 'Team folder',
      visibility: 'workspace',
    });
    const res = await move(owner, personalDoc.id, { folderId: teamFolder.id });
    expect(res.status).toBe(404);
    const [row] = await h.db.select().from(document).where(eq(document.id, personalDoc.id));
    expect(row!.workspaceId).toBe(ownerPersonal);
  });

  it('viewers can’t move; members move shared documents between shared folders', async () => {
    const shared = await created(owner, { workspaceId: team, visibility: 'workspace' });
    const folder = await folderOf(owner, { workspaceId: team, name: 'F', visibility: 'workspace' });
    expect((await move(viewer, shared.id, { folderId: folder.id })).status).toBe(403);
    const ok = await move(member, shared.id, { folderId: folder.id });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ folderId: folder.id, visibility: 'workspace' });
  });

  it('a page created in a shared folder is shared; in a private folder always private', async () => {
    const sharedFolder = await folderOf(owner, {
      workspaceId: team,
      name: 'Shared',
      visibility: 'workspace',
    });
    const privateFolder = await folderOf(owner, { workspaceId: team, name: 'Private' });
    const inShared = await created(member, { workspaceId: team, folderId: sharedFolder.id });
    expect(inShared.visibility).toBe('workspace');
    const inPrivate = await created(owner, {
      workspaceId: team,
      folderId: privateFolder.id,
      visibility: 'workspace',
    });
    expect(inPrivate.visibility).toBe('private');
    // Only the owner adds to a private folder (it's 404 for everyone else).
    expect((await create(member, { workspaceId: team, folderId: privateFolder.id })).status).toBe(
      404,
    );
    // A folder from another workspace is refused like an unknown one.
    const res = await create(owner, { workspaceId: ownerPersonal, folderId: sharedFolder.id });
    expect(res.status).toBe(404);
  });
});

describe('trash, restore, permanent delete', () => {
  it('owner trashes, restores and permanently deletes; lists reflect it', async () => {
    const d = await created(owner, { workspaceId: ownerPersonal, title: 'To trash' });
    expect((await trash(owner, d.id, true)).error?.code).toBe('not_in_trash');

    const trashed = await trash(owner, d.id);
    expect(trashed.status).toBe(200);
    expect(trashed.body.deletedAt).not.toBeNull();
    expect((await list(owner, ownerPersonal)).body.map((x) => x.id)).not.toContain(d.id);
    expect((await list(owner, ownerPersonal, true)).body.map((x) => x.id)).toContain(d.id);
    // Readable in the trash, but not editable.
    expect((await get(owner, d.id)).status).toBe(200);
    expect(
      (await patch(owner, d.id, { baseVersion: trashed.body.version, title: 'x' })).status,
    ).toBe(403);

    const restored = await restore(owner, d.id);
    expect(restored.status).toBe(200);
    expect(restored.body.deletedAt).toBeNull();
    expect((await list(owner, ownerPersonal)).body.map((x) => x.id)).toContain(d.id);

    await trash(owner, d.id);
    const gone = await trash(owner, d.id, true);
    expect(gone.status).toBe(204);
    expect((await get(owner, d.id)).status).toBe(404);
  });

  it('shared documents: only the doc owner or a workspace owner/admin may trash; members and viewers can’t', async () => {
    const shared = await created(member, { workspaceId: team, visibility: 'workspace' });
    const byOwnersDoc = await created(owner, { workspaceId: team, visibility: 'workspace' });
    expect((await trash(viewer, shared.id)).status).toBe(403);
    expect((await trash(member, byOwnersDoc.id)).status).toBe(403);
    expect((await trash(admin, byOwnersDoc.id)).status).toBe(200);
    // Admin sees it in the trash and can restore it; the member who doesn't own it can't.
    expect((await list(admin, team, true)).body.map((x) => x.id)).toContain(byOwnersDoc.id);
    expect((await restore(member, byOwnersDoc.id)).status).toBe(404);
    expect((await restore(admin, byOwnersDoc.id)).status).toBe(200);
    // A member may trash their own shared document.
    expect((await trash(member, shared.id)).status).toBe(200);
  });

  it('nobody but the owner sees a trashed private document', async () => {
    const d = await created(owner, { workspaceId: team });
    await trash(owner, d.id);
    expect((await list(admin, team, true)).body.map((x) => x.id)).not.toContain(d.id);
    expect((await get(admin, d.id)).status).toBe(404);
    expect((await trash(admin, d.id, true)).status).toBe(404);
  });
});
