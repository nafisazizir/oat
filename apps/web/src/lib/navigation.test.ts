import { describe, expect, it } from 'vitest';

import { inSection } from './navigation';
import {
  ancestorsOf,
  childrenOf,
  type DocumentNode,
  pathOf,
  rootsOf,
  sectionOf,
  type ShellData,
  subtreeIds,
  titleOf,
} from './tree';

const node = (
  id: string,
  parentId: string | null,
  visibility: DocumentNode['visibility'] = 'private',
  kind: DocumentNode['kind'] = 'page',
): DocumentNode => ({
  id,
  title: id.replace(/-/g, ' '),
  kind,
  visibility,
  parentId,
  ownerId: 'u',
  updatedAt: '2026-11-01T00:00:00.000Z',
  access: { edit: true, delete: true },
});

/** Fixture tree. */
const tree: Pick<ShellData, 'workspace' | 'documents' | 'trash'> = {
  workspace: { id: 'w', name: 'Studio', kind: 'team', members: 3, role: 'member' },
  documents: [
    node('root-page', null),
    node('folder', null, 'private', 'folder'),
    node('child', 'folder', 'private', 'folder'),
    node('grandchild', 'child'),
    node('shared-page', null, 'link'),
    node('shared-folder', null, 'workspace', 'folder'),
    // My private page inside a shared folder: shows under Shared, inside the folder.
    node('mine-in-shared', 'shared-folder', 'private'),
    // Folder not visible to me (someone else's): the page becomes a root of its own area.
    node('orphan', 'invisible-folder', 'workspace'),
    // Corrupt data must not hang breadcrumbs.
    node('loop-a', 'loop-b'),
    node('loop-b', 'loop-a'),
  ],
  trash: [{ ...node('binned', null), deletedAt: '2026-11-02T00:00:00.000Z' }],
};

describe('sections', () => {
  it('matches a section and its sub-pages only', () => {
    expect(inSection('/templates', '/templates')).toBe(true);
    expect(inSection('/templates/abc', '/templates')).toBe(true);
    expect(inSection('/templatesx', '/templates')).toBe(false);
    expect(inSection('/home', '/templates')).toBe(false);
  });
});

describe('tree helpers', () => {
  it('rootsOf: root items per area (folders first) plus items whose folder I can’t see', () => {
    expect(rootsOf(tree.documents, 'private').map((d) => d.id)).toEqual(['folder', 'root-page']);
    expect(rootsOf(tree.documents, 'shared').map((d) => d.id)).toEqual([
      'shared-folder',
      'shared-page',
      'orphan',
    ]);
  });

  it('childrenOf lists a folder’s items regardless of their visibility', () => {
    expect(childrenOf(tree.documents, 'shared-folder').map((d) => d.id)).toEqual([
      'mine-in-shared',
    ]);
    expect(childrenOf(tree.documents, 'folder').map((d) => d.id)).toEqual(['child']);
  });

  it('ancestorsOf, sectionOf, subtreeIds, pathOf', () => {
    expect(ancestorsOf(tree.documents, 'grandchild').map((d) => d.id)).toEqual(['folder', 'child']);
    expect(ancestorsOf(tree.documents, 'root-page')).toEqual([]);
    expect(sectionOf(tree.documents, 'mine-in-shared')).toBe('shared');
    expect(sectionOf(tree.documents, 'orphan')).toBe('shared');
    expect(sectionOf(tree.documents, 'nope')).toBeUndefined();
    expect([...subtreeIds(tree.documents, 'folder')].toSorted()).toEqual([
      'child',
      'folder',
      'grandchild',
    ]);
    expect(pathOf(tree.documents, 'child')).toBe('folder / child');
  });

  it('titleOf falls back for empty titles', () => {
    expect(titleOf({ title: '  ', kind: 'page' })).toBe('Untitled');
    expect(titleOf({ title: '', kind: 'folder' })).toBe('Untitled folder');
    expect(titleOf({ title: 'Plan', kind: 'meeting' })).toBe('Plan');
  });
});
