import type { UserWorkspace } from '@oat/auth';
import { describe, expect, it } from 'vitest';

import type { DocumentSummary, FolderSummary } from '@/lib/api-types';
import { breadcrumbsFor } from '@/lib/navigation';
import { childrenOf, rootsOf } from '@/lib/tree';

import { buildShellData } from './shell';

const workspaces: UserWorkspace[] = [
  {
    id: 'p1',
    name: 'Personal',
    slug: 'personal-u1',
    kind: 'personal',
    logo: null,
    role: 'owner',
    memberCount: 1,
  },
  {
    id: 't1',
    name: 'Acme',
    slug: 'acme-1',
    kind: 'team',
    logo: '🌾',
    role: 'member',
    memberCount: 6,
  },
];
const user = { id: 'u1', name: '', email: 'ada@example.test', image: null };
const access = { edit: true, delete: true };
const at = '2026-11-12T09:30:00.000Z';

const folder = (id: string, name: string, parentId: string | null = null): FolderSummary => ({
  id,
  workspaceId: 'p1',
  parentId,
  ownerId: 'u1',
  name,
  visibility: 'private',
  createdAt: at,
  updatedAt: at,
  access,
});
const doc = (
  id: string,
  title: string,
  folderId: string | null,
  extra: Partial<DocumentSummary> = {},
): DocumentSummary => ({
  id,
  workspaceId: 'p1',
  folderId,
  ownerId: 'u1',
  kind: 'page',
  title,
  visibility: 'private',
  version: 3,
  createdAt: at,
  updatedAt: at,
  deletedAt: null,
  access,
  ...extra,
});

describe('buildShellData (session + memberships + tree → shell)', () => {
  it('uses the session’s active workspace when the user is a member of it', () => {
    const data = buildShellData({ user, workspaces, activeWorkspaceId: 't1' });
    expect(data.workspace).toEqual({
      id: 't1',
      name: 'Acme',
      kind: 'team',
      members: 6,
      icon: '🌾',
      role: 'member',
    });
    expect(data.workspaces.map((w) => w.id)).toEqual(['p1', 't1']);
    expect(data.user).toEqual({ id: 'u1', name: 'ada', email: 'ada@example.test', image: null });
    expect(data.documents).toEqual([]);
    expect(data.trash).toEqual([]);
  });

  it('falls back to the personal workspace for a stale or missing active id', () => {
    for (const activeWorkspaceId of ['gone', null, undefined]) {
      const data = buildShellData({ user, workspaces, activeWorkspaceId });
      expect(data.workspace.id).toBe('p1');
    }
  });

  it('refuses a user without workspaces (the loader heals that case first)', () => {
    expect(() => buildShellData({ user, workspaces: [], activeWorkspaceId: null })).toThrow(
      /no workspace/,
    );
  });

  it('maps folders and documents into one tree the sidebar and breadcrumbs agree on', () => {
    const data = buildShellData({
      user,
      workspaces,
      activeWorkspaceId: 'p1',
      folders: [folder('f1', 'Ideas')],
      documents: [
        doc('d1', 'Getting started', null),
        doc('d2', 'Reading list', 'f1', { kind: 'meeting' }),
        doc('d3', 'Team handbook', null, { visibility: 'workspace' }),
      ],
      trash: [doc('d4', 'Old', null, { deletedAt: at })],
    });
    expect(rootsOf(data.documents, 'private').map((d) => d.id)).toEqual(['f1', 'd1']);
    expect(rootsOf(data.documents, 'shared').map((d) => d.id)).toEqual(['d3']);
    const [reading] = childrenOf(data.documents, 'f1');
    expect(reading).toMatchObject({ id: 'd2', kind: 'meeting', parentId: 'f1', version: 3 });
    expect(data.trash.map((d) => d.id)).toEqual(['d4']);
    expect(breadcrumbsFor(data, '/d/d2').map((c) => c.label)).toEqual([
      'Personal',
      'Private',
      'Ideas',
      'Reading list',
    ]);
  });
});
