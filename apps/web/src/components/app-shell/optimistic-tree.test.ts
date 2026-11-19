import { describe, expect, it } from 'vitest';

import type { DocumentNode } from '@/lib/tree';

import { applyTreeOps } from './optimistic-tree';

const access: DocumentNode['access'] = { edit: true, delete: true };
const node = (id: string, patch: Partial<DocumentNode> = {}): DocumentNode => ({
  id,
  title: id,
  kind: 'page',
  visibility: 'private',
  parentId: null,
  ownerId: 'u1',
  updatedAt: '2026-01-01T00:00:00.000Z',
  access,
  ...patch,
});

const base = {
  documents: [
    node('f1', { kind: 'folder' }),
    node('f2', { kind: 'folder', parentId: 'f1' }),
    node('a', { parentId: 'f1' }),
    node('b', { parentId: 'f2' }),
    node('c'),
  ],
  trash: [node('t1', { parentId: 'gone', deletedAt: '2026-01-02T00:00:00.000Z' })],
};

describe('applyTreeOps', () => {
  it('returns the same object without ops', () => {
    expect(applyTreeOps(base, [])).toBe(base);
  });

  it('creates, renames and moves', () => {
    const out = applyTreeOps(base, [
      { type: 'create', node: node('pending:1', { parentId: 'f1' }) },
      { type: 'rename', id: 'c', title: 'Renamed' },
      { type: 'move', id: 'a', parentId: null, visibility: 'workspace' },
    ]);
    expect(out.documents.find((d) => d.id === 'pending:1')?.parentId).toBe('f1');
    expect(out.documents.find((d) => d.id === 'c')?.title).toBe('Renamed');
    expect(out.documents.find((d) => d.id === 'a')).toMatchObject({
      parentId: null,
      visibility: 'workspace',
    });
    expect(base.documents.find((d) => d.id === 'c')?.title).toBe('c');
  });

  it('trashes a page and restores it', () => {
    const trashed = applyTreeOps(base, [{ type: 'trash', id: 'a', deletedAt: 'now' }]);
    expect(trashed.documents.map((d) => d.id)).not.toContain('a');
    expect(trashed.trash[0]).toMatchObject({ id: 'a', deletedAt: 'now' });
    const restored = applyTreeOps(trashed, [{ type: 'restore', id: 'a' }]);
    expect(restored.documents.find((d) => d.id === 'a')?.parentId).toBe('f1');
    expect(restored.trash.map((d) => d.id)).not.toContain('a');
  });

  it('restores to the top level when the folder is gone', () => {
    const out = applyTreeOps(base, [{ type: 'restore', id: 't1' }]);
    expect(out.documents.find((d) => d.id === 't1')?.parentId).toBeNull();
  });

  it('deletes a folder: subfolders vanish, pages go to the trash', () => {
    const out = applyTreeOps(base, [{ type: 'deleteFolder', id: 'f1', deletedAt: 'now' }]);
    expect(out.documents.map((d) => d.id)).toEqual(['c']);
    expect(out.trash.map((d) => d.id).toSorted()).toEqual(['a', 'b', 't1']);
  });

  it('deletes forever from the trash', () => {
    const out = applyTreeOps(base, [{ type: 'deleteForever', id: 't1' }]);
    expect(out.trash).toEqual([]);
  });
});
