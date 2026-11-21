/**
 * "Export my notes" (D-36) against a throwaway database and a real in-process Better Auth: what the
 * archive holds, and — the point — what it never holds: nothing for an anonymous caller or a non-member,
 * no other member's note (shared or private), nothing from another workspace, nothing from the trash; and
 * after leaving, neither the export nor any of the exported notes can be read.
 */
import { findFirstWorkspaceId, leaveWorkspace } from '@oat/auth';
import { document } from '@oat/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DocumentDetail } from '@/lib/api-types';

import {
  BASE,
  call,
  createHarness,
  denies,
  type Harness,
  type TestUser,
} from '../api/test-harness';
import { loadActor } from '../actor';
import { exportOwnNotes, INCOMPLETE_NOTE } from './notes';
import { readAll, readZip, type ZipFile } from './read-zip';

let h: Harness;
let owner: TestUser;
let member: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let team: string;
let memberOwnWs: string;

const text = (line: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: line }] }],
});

async function createDoc(as: TestUser, body: Record<string, unknown>): Promise<DocumentDetail> {
  const res = await call<DocumentDetail>(h.api.documents.POST, 'POST', '/api/documents', {
    as,
    body,
  });
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.body;
}

/** Calls the export route as Next.js does (a GET with the session cookie, or none). */
async function exportAs(as: TestUser | null, workspaceId: string): Promise<Response> {
  const headers = new Headers();
  if (as) headers.set('cookie', as.cookie);
  return h.api.workspaceExport.GET(
    new Request(`${BASE}/api/workspaces/${workspaceId}/export`, { headers }),
    { params: Promise.resolve({ id: workspaceId }) },
  );
}

async function filesOf(res: Response): Promise<ZipFile[]> {
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/zip');
  return readZip(await readAll(res.body!));
}

const getDoc = (as: TestUser, id: string) =>
  call<DocumentDetail>(h.api.document.GET, 'GET', `/api/documents/${id}`, {
    as,
    params: { id },
  });

beforeAll(async () => {
  h = await createHarness();
  [owner, member, viewer, outsider] = await Promise.all([
    h.signUp('owner'),
    h.signUp('member'),
    h.signUp('viewer'),
    h.signUp('outsider'),
  ]);
  team = await h.teamWorkspace(owner, [
    [member, 'member'],
    [viewer, 'viewer'],
  ]);
  memberOwnWs = (await findFirstWorkspaceId(h.db, member.id))!;
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('GET /api/workspaces/:id/export', () => {
  let mine: { private: DocumentDetail; shared: DocumentDetail; meeting: DocumentDetail };

  beforeAll(async () => {
    // The member's own notes in the team workspace…
    mine = {
      private: await createDoc(member, {
        workspaceId: team,
        title: 'My private plan',
        contentJson: text('Only I know this.'),
      }),
      shared: await createDoc(member, {
        workspaceId: team,
        title: 'Team handbook',
        visibility: 'workspace',
        contentJson: text('Everyone can read this.'),
      }),
      meeting: await createDoc(member, {
        workspaceId: team,
        kind: 'meeting',
        title: '',
        contentJson: text('Meeting notes.'),
      }),
    };
    // …one they threw away…
    const binned = await createDoc(member, {
      workspaceId: team,
      title: 'Thrown away',
      contentJson: text('In the trash.'),
    });
    await call(h.api.document.DELETE, 'DELETE', `/api/documents/${binned.id}`, {
      as: member,
      params: { id: binned.id },
    });
    // …other people's notes in the same workspace…
    await createDoc(owner, {
      workspaceId: team,
      title: 'Owner secret',
      contentJson: text('The owner’s private note.'),
    });
    await createDoc(owner, {
      workspaceId: team,
      title: 'Owner shared',
      visibility: 'workspace',
      contentJson: text('The owner’s shared note.'),
    });
    // …and the member's note in another workspace.
    await createDoc(member, {
      workspaceId: memberOwnWs,
      title: 'Elsewhere',
      contentJson: text('In my other workspace.'),
    });
  });

  it('gives me my own live notes of that workspace as Markdown, private and shared alike', async () => {
    const res = await exportAs(member, team);
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="oat-notes-team-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-oat-export-count')).toBe('3');
    const files = await filesOf(res);
    expect(files.map((f) => f.name).toSorted()).toEqual([
      'My private plan.md',
      'Team handbook.md',
      'Untitled.md',
    ]);
    const byName = new Map(files.map((f) => [f.name, f.text]));
    expect(byName.get('My private plan.md')).toBe('# My private plan\n\nOnly I know this.\n');
    expect(byName.get('Team handbook.md')).toBe('# Team handbook\n\nEveryone can read this.\n');
    expect(byName.get('Untitled.md')).toBe('# Untitled meeting\n\nMeeting notes.\n');
    expect(files.some((f) => f.name === INCOMPLETE_NOTE)).toBe(false);
  });

  it('holds nobody else’s notes, nothing from the trash, nothing from another workspace', async () => {
    const all = (await filesOf(await exportAs(member, team))).map((f) => `${f.name}\n${f.text}`);
    const joined = all.join('\n');
    for (const leaked of [
      'Owner secret',
      'owner’s private note',
      // Readable by the member, but not theirs to take.
      'Owner shared',
      'owner’s shared note',
      'Thrown away',
      'In the trash',
      'Elsewhere',
      'other workspace',
    ]) {
      expect(joined, leaked).not.toContain(leaked);
    }
    // The other workspace's export is its own, and has only that note.
    const other = await filesOf(await exportAs(member, memberOwnWs));
    expect(other.map((f) => f.name)).toEqual(['Elsewhere.md']);
  });

  it('refuses anyone who is not a signed-in member of that workspace', async () => {
    denies('GET /api/workspaces/[id]/export');
    const anonymous = await exportAs(null, team);
    expect(anonymous.status).toBe(401);
    // A signed-in stranger: 404, exactly as for a workspace that doesn't exist (no existence leak).
    const stranger = await exportAs(outsider, team);
    expect(stranger.status).toBe(404);
    const unknown = await exportAs(outsider, '00000000-0000-4000-8000-000000000000');
    expect(unknown.status).toBe(404);
    expect(await stranger.text()).toBe(await unknown.text());
    // Nor someone else's own workspace.
    expect((await exportAs(owner, memberOwnWs)).status).toBe(404);
    expect((await exportAs(member, 'x'.repeat(200))).status).toBe(400);
  });

  it('a member who owns nothing gets an empty archive, not other people’s notes', async () => {
    // A viewer can read the shared notes but owns none.
    const res = await exportAs(viewer, team);
    expect(res.headers.get('x-oat-export-count')).toBe('0');
    expect(await filesOf(res)).toEqual([]);
  });

  it('titles can’t choose a path: hostile and duplicate titles become safe, distinct file names', async () => {
    const ws = await h.teamWorkspace(owner, [[member, 'member']]);
    for (const title of [
      '../../etc/passwd',
      '..\\..\\evil',
      'Same',
      'Same',
      'same',
      '.hidden',
      '',
    ]) {
      await createDoc(member, { workspaceId: ws, title, contentJson: text(`was: ${title}`) });
    }
    const files = await filesOf(await exportAs(member, ws));
    expect(files.map((f) => f.name)).toEqual([
      'etc passwd.md',
      'evil.md',
      'Same.md',
      'Same (2).md',
      'same (3).md',
      'hidden.md',
      'Untitled.md',
    ]);
    for (const { name } of files) {
      expect(name).not.toMatch(/[\\/]|^\.|\.\./);
    }
    // The title itself is kept inside the file, where it is only text.
    expect(files[0]!.text).toContain('# ../../etc/passwd');
  });

  it('does not export a note that stopped being mine between listing and reading', async () => {
    const ws = await h.teamWorkspace(owner, [[member, 'member']]);
    const kept = await createDoc(member, { workspaceId: ws, title: 'Kept' });
    const gone = await createDoc(member, { workspaceId: ws, title: 'Handed over' });
    const res = await exportAs(member, ws);
    // The response is created (ids listed) but nothing was read yet: the stream pulls lazily.
    await h.db.update(document).set({ ownerId: owner.id }).where(eq(document.id, gone.id));
    const files = await filesOf(res);
    expect(files.map((f) => f.name)).toEqual(['Kept.md']);
    expect(kept.id).toBeTruthy();
  });

  it('is bounded: beyond the limit the archive says it is incomplete; a batch of skipped notes doesn’t stall it', async () => {
    const ws = await h.teamWorkspace(owner, [[member, 'member']]);
    const made: DocumentDetail[] = [];
    for (let i = 1; i <= 45; i++) {
      made.push(await createDoc(member, { workspaceId: ws, title: `Note ${i}` }));
    }
    const actor = await loadActor(h.db, member.id);
    const limited = await exportOwnNotes(h.db, actor, ws, { max: 42 });
    expect(limited).toMatchObject({ count: 42, truncated: true });
    // The first two batches (40 notes) go to the trash before anything is read.
    for (const note of made.slice(0, 40)) {
      await h.db.update(document).set({ deletedAt: new Date() }).where(eq(document.id, note.id));
    }
    const files = readZip(await readAll(limited.stream));
    expect(files.map((f) => f.name)).toEqual(['Note 41.md', 'Note 42.md', INCOMPLETE_NOTE]);
    expect(files.at(-1)!.text).toContain('first 42 notes');
  });

  it('after leaving, I can read neither the export nor any note I exported', async () => {
    const before = await filesOf(await exportAs(member, team));
    expect(before).toHaveLength(3);
    await leaveWorkspace(h.db, { actorId: member.id, workspaceId: team });

    expect((await exportAs(member, team)).status).toBe(404);
    for (const note of Object.values(mine)) {
      expect((await getDoc(member, note.id)).status, note.title).toBe(404);
    }
    const list = await call(h.api.documents.GET, 'GET', `/api/documents?workspaceId=${team}`, {
      as: member,
    });
    expect(list.status).toBe(404);
    // The notes stay in the workspace: the shared one is still there for the others; the private one
    // is readable by nobody else (admins can't read a member's private notes, D-36).
    expect((await getDoc(owner, mine.shared.id)).status).toBe(200);
    expect((await getDoc(owner, mine.private.id)).status).toBe(404);
  });
});
