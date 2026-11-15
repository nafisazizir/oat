/**
 * Folders API (3.3, D-18) against a throwaway database and a real in-process Better Auth: create, list,
 * rename, move (cycles, private conversion of a whole subtree, cross-workspace) and delete (documents go
 * to the trash), with deny cases for anonymous users, non-members, viewers and other people's private
 * folders.
 */
import { findPersonalWorkspaceId } from '@oat/auth';
import { document, folder } from '@oat/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DocumentDetail, FolderSummary } from '@/lib/api-types';

import { call, createHarness, denies, type Harness, type TestUser } from './test-harness';

let h: Harness;
let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let viewer: TestUser;
let outsider: TestUser;
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

const createFolder = (as: TestUser | null, body: Record<string, unknown>) =>
  call<FolderSummary>(h.api.folders.POST, 'POST', '/api/folders', { as, body });
async function folderOf(as: TestUser, body: Record<string, unknown>): Promise<FolderSummary> {
  const res = await createFolder(as, body);
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.body;
}
const listFolders = (as: TestUser | null, workspaceId: string) =>
  call<FolderSummary[]>(h.api.folders.GET, 'GET', `/api/folders?workspaceId=${workspaceId}`, {
    as,
  });
const rename = (as: TestUser | null, id: string, name: string) =>
  call<FolderSummary>(h.api.folder.PATCH, 'PATCH', `/api/folders/${id}`, {
    as,
    body: { name },
    params: { id },
  });
const remove = (as: TestUser | null, id: string) =>
  call<{ trashedDocumentIds: string[] }>(h.api.folder.DELETE, 'DELETE', `/api/folders/${id}`, {
    as,
    params: { id },
  });
const moveFolder = (as: TestUser | null, id: string, body: unknown) =>
  call<FolderSummary>(h.api.folderMove.POST, 'POST', `/api/folders/${id}/move`, {
    as,
    body,
    params: { id },
  });
async function docIn(
  as: TestUser,
  folderId: string | null,
  extra: Record<string, unknown> = {},
): Promise<DocumentDetail> {
  const res = await call<DocumentDetail>(h.api.documents.POST, 'POST', '/api/documents', {
    as,
    body: { workspaceId: team, folderId, ...extra },
  });
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.body;
}

describe('folders', () => {
  it('anonymous: 401 everywhere', async () => {
    expect((await createFolder(null, { workspaceId: team, name: 'x' })).status).toBe(401);
    expect((await listFolders(null, team)).status).toBe(401);
    expect((await rename(null, 'x', 'y')).status).toBe(401);
    expect((await remove(null, 'x')).status).toBe(401);
    expect((await moveFolder(null, 'x', { parentId: null })).status).toBe(401);
  });

  it('create: private by default, inherits a shared parent, always private inside a private one', async () => {
    const mine = await folderOf(owner, { workspaceId: team, name: '  Notes  ' });
    expect(mine).toMatchObject({ name: 'Notes', visibility: 'private', parentId: null });
    const shared = await folderOf(owner, {
      workspaceId: team,
      name: 'Shared',
      visibility: 'workspace',
    });
    const child = await folderOf(member, { workspaceId: team, name: 'Child', parentId: shared.id });
    expect(child.visibility).toBe('workspace');
    const forcedPrivate = await folderOf(owner, {
      workspaceId: team,
      name: 'In private',
      parentId: mine.id,
      visibility: 'workspace',
    });
    expect(forcedPrivate.visibility).toBe('private');
    expect((await createFolder(owner, { workspaceId: team, name: '   ' })).status).toBe(400);
  });

  it('deny: non-members 404, viewers 403, other people’s private folders 404', async () => {
    denies(
      'GET /api/folders',
      'POST /api/folders',
      'PATCH /api/folders/[id]',
      'DELETE /api/folders/[id]',
      'POST /api/folders/[id]/move',
    );
    expect((await createFolder(outsider, { workspaceId: team, name: 'x' })).status).toBe(404);
    expect((await listFolders(outsider, team)).status).toBe(404);
    expect((await createFolder(viewer, { workspaceId: team, name: 'x' })).status).toBe(403);

    const secret = await folderOf(owner, { workspaceId: team, name: 'Secret' });
    expect((await listFolders(member, team)).body.map((f) => f.id)).not.toContain(secret.id);
    expect((await listFolders(owner, team)).body.map((f) => f.id)).toContain(secret.id);
    for (const user of [member, admin, viewer, outsider]) {
      expect((await rename(user, secret.id, 'mine now')).status).toBe(404);
      expect((await remove(user, secret.id)).status).toBe(404);
      expect((await moveFolder(user, secret.id, { parentId: null })).status).toBe(404);
      // Viewers are refused before the folder is looked up (they can't create anywhere).
      expect(
        (await createFolder(user, { workspaceId: team, name: 'in', parentId: secret.id })).status,
      ).toBe(user === viewer ? 403 : 404);
    }
  });

  it('rename: editors rename shared folders, viewers can’t', async () => {
    const shared = await folderOf(owner, { workspaceId: team, name: 'A', visibility: 'workspace' });
    expect((await rename(viewer, shared.id, 'B')).status).toBe(403);
    const ok = await rename(member, shared.id, 'B');
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe('B');
    expect(ok.body.access.edit).toBe(true);
  });

  it('move: refuses cycles and cross-workspace targets', async () => {
    const a = await folderOf(owner, { workspaceId: team, name: 'a', visibility: 'workspace' });
    const b = await folderOf(owner, { workspaceId: team, name: 'b', parentId: a.id });
    const c = await folderOf(owner, { workspaceId: team, name: 'c', parentId: b.id });
    expect((await moveFolder(owner, a.id, { parentId: a.id })).status).toBe(400);
    expect((await moveFolder(owner, a.id, { parentId: c.id })).status).toBe(400);
    const elsewhere = await folderOf(owner, { workspaceId: ownerPersonal, name: 'personal' });
    expect((await moveFolder(owner, a.id, { parentId: elsewhere.id })).status).toBe(404);
    const ok = await moveFolder(owner, c.id, { parentId: null });
    expect(ok.status).toBe(200);
    expect(ok.body.parentId).toBeNull();
  });

  it('concurrent moves A→B and B→A: one wins, the other is refused, no cycle', async () => {
    for (let round = 0; round < 5; round++) {
      const a = await folderOf(owner, {
        workspaceId: team,
        name: `A${round}`,
        visibility: 'workspace',
      });
      const b = await folderOf(owner, {
        workspaceId: team,
        name: `B${round}`,
        visibility: 'workspace',
      });
      const results = await Promise.all([
        moveFolder(owner, a.id, { parentId: b.id }),
        moveFolder(owner, b.id, { parentId: a.id }),
      ]);
      expect(results.map((r) => r.status).toSorted()).toEqual([200, 400]);
      const rows = await h.db
        .select()
        .from(folder)
        .where(inArray(folder.id, [a.id, b.id]));
      // Exactly one of them is still at the root.
      expect(rows.filter((r) => r.parentId === null)).toHaveLength(1);
    }
  });

  it('a page created in a subtree while it is moved into a private folder is never swept private', async () => {
    for (let round = 0; round < 5; round++) {
      const shared = await folderOf(owner, {
        workspaceId: team,
        name: `S${round}`,
        visibility: 'workspace',
      });
      const target = await folderOf(owner, { workspaceId: team, name: `P${round}` });
      const [moved, created] = await Promise.all([
        moveFolder(owner, shared.id, { parentId: target.id, makePrivate: true }),
        call<DocumentDetail>(h.api.documents.POST, 'POST', '/api/documents', {
          as: member,
          body: { workspaceId: team, folderId: shared.id },
        }),
      ]);
      if (created.status === 201) {
        // The member's page got in first: the move must have been refused, and the page stays shared.
        expect(moved.status).toBe(403);
        const [row] = await h.db.select().from(document).where(eq(document.id, created.body.id));
        expect(row!.visibility).toBe('workspace');
      } else {
        // The move got in first: the folder is now the owner's private one, invisible to the member.
        expect(moved.status).toBe(200);
        expect(created.status).toBe(404);
      }
    }
  });

  it('move into a private folder converts the whole subtree (after confirmation)', async () => {
    const shared = await folderOf(owner, { workspaceId: team, name: 'S', visibility: 'workspace' });
    const sub = await folderOf(owner, { workspaceId: team, name: 'S/sub', parentId: shared.id });
    const d1 = await docIn(owner, shared.id);
    const d2 = await docIn(owner, sub.id);
    expect([d1.visibility, d2.visibility]).toEqual(['workspace', 'workspace']);
    const target = await folderOf(owner, { workspaceId: team, name: 'Private target' });

    const unconfirmed = await moveFolder(owner, shared.id, { parentId: target.id });
    expect(unconfirmed.status).toBe(422);
    const moved = await moveFolder(owner, shared.id, { parentId: target.id, makePrivate: true });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ parentId: target.id, visibility: 'private' });

    const folders = await h.db.select().from(folder).where(eq(folder.id, sub.id));
    expect(folders[0]!.visibility).toBe('private');
    const docs = await h.db
      .select()
      .from(document)
      .where(inArray(document.id, [d1.id, d2.id]));
    expect(docs.map((d) => d.visibility)).toEqual(['private', 'private']);
    expect(docs.every((d) => d.version === 1)).toBe(true);
  });

  it('move into a private folder is refused when the subtree holds someone else’s items', async () => {
    const shared = await folderOf(owner, {
      workspaceId: team,
      name: 'S2',
      visibility: 'workspace',
    });
    await docIn(member, shared.id);
    const target = await folderOf(owner, { workspaceId: team, name: 'P2' });
    const res = await moveFolder(owner, shared.id, { parentId: target.id, makePrivate: true });
    expect(res.status).toBe(403);
  });

  it('delete: trashes documents inside (they restore to the root); refuses others’ items for members', async () => {
    const shared = await folderOf(member, {
      workspaceId: team,
      name: 'D',
      visibility: 'workspace',
    });
    const sub = await folderOf(member, { workspaceId: team, name: 'D/sub', parentId: shared.id });
    const d1 = await docIn(member, shared.id);
    const d2 = await docIn(member, sub.id);
    const others = await docIn(owner, sub.id);

    // The member can't trash the owner's document, so the folder delete is refused as a whole.
    expect((await remove(member, shared.id)).status).toBe(403);
    expect((await remove(viewer, shared.id)).status).toBe(403);

    const res = await remove(admin, shared.id);
    expect(res.status).toBe(200);
    expect(res.body.trashedDocumentIds.toSorted()).toEqual([d1.id, d2.id, others.id].toSorted());
    expect(
      await h.db
        .select()
        .from(folder)
        .where(inArray(folder.id, [shared.id, sub.id])),
    ).toEqual([]);
    const docs = await h.db
      .select()
      .from(document)
      .where(inArray(document.id, [d1.id, d2.id, others.id]));
    expect(docs.every((d) => d.deletedAt !== null && d.folderId === null)).toBe(true);

    const restored = await call<DocumentDetail>(
      h.api.documentRestore.POST,
      'POST',
      `/api/documents/${d1.id}/restore`,
      { as: member, params: { id: d1.id } },
    );
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ folderId: null, deletedAt: null });
  });
});
