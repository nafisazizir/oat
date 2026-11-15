import type { UserWorkspace } from '@oat/auth';
import { describe, expect, it } from 'vitest';

import { breadcrumbsFor } from '@/lib/navigation';

import {
  buildShellData,
  getDocument,
  listChildren,
  listRecentMeetings,
  listRecentPages,
  mockDocuments,
} from './shell';

const workspaces: UserWorkspace[] = [
  {
    id: 'p1',
    name: 'Personal',
    slug: 'personal-u1',
    kind: 'personal',
    role: 'owner',
    memberCount: 1,
  },
  { id: 't1', name: 'Acme', slug: 'acme-1', kind: 'team', role: 'member', memberCount: 6 },
];
const user = { id: 'u1', name: '', email: 'ada@example.test', image: null };

describe('buildShellData (session + memberships → shell)', () => {
  it('uses the session’s active workspace when the user is a member of it', () => {
    const data = buildShellData({ user, workspaces, activeWorkspaceId: 't1', documents: [] });
    expect(data.workspace).toEqual({ id: 't1', name: 'Acme', kind: 'team', members: 6 });
    expect(data.workspaces.map((w) => w.id)).toEqual(['p1', 't1']);
    expect(data.user).toEqual({ id: 'u1', name: 'ada', email: 'ada@example.test', image: null });
  });

  it('falls back to the personal workspace for a stale or missing active id', () => {
    for (const activeWorkspaceId of ['gone', null, undefined]) {
      const data = buildShellData({ user, workspaces, activeWorkspaceId, documents: [] });
      expect(data.workspace.id).toBe('p1');
    }
  });

  it('refuses a user without workspaces (the loader heals that case first)', () => {
    expect(() =>
      buildShellData({ user, workspaces: [], activeWorkspaceId: null, documents: [] }),
    ).toThrow(/no workspace/);
  });
});

describe('document getters (in-memory until 3.3)', () => {
  it('the mock tree is consistent', () => {
    const ids = mockDocuments.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const doc of mockDocuments) {
      if (!doc.parentId) continue;
      const parent = mockDocuments.find((d) => d.id === doc.parentId);
      expect(parent?.visibility, `${doc.id}'s parent`).toBe(doc.visibility);
    }
  });

  it('getters agree with the shell tree', async () => {
    const data = buildShellData({
      user,
      workspaces,
      activeWorkspaceId: 'p1',
      documents: mockDocuments,
    });
    const folder = await getDocument('ideas');
    expect(folder?.kind).toBe('folder');
    expect((await listChildren(folder!)).map((d) => d.id)).toEqual([
      'reading-list',
      'side-projects',
    ]);
    expect(await getDocument('nope')).toBeUndefined();
    expect(breadcrumbsFor(data, '/d/reading-list').map((c) => c.label)).toEqual([
      'Personal',
      'Private',
      'Ideas',
      'Reading list',
    ]);
  });

  it('home lists: no meetings yet, recent pages newest first', async () => {
    expect(await listRecentMeetings()).toEqual([]);
    const pages = await listRecentPages(3);
    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.updatedAt)).toEqual(
      pages
        .map((p) => p.updatedAt)
        .toSorted()
        .reverse(),
    );
  });
});
