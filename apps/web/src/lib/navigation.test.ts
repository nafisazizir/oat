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
  ownerId = 'u',
): DocumentNode => ({
  id,
  title: id.replace(/-/g, ' '),
  kind,
  visibility,
  parentId,
  ownerId,
  updatedAt: '2026-11-01T00:00:00.000Z',
  access: { edit: true, delete: true },
});

/** Fixture tree. */
const tree: Pick<ShellData, 'workspace' | 'documents' | 'trash'> = {
  workspace: { id: 'w', name: 'Studio', members: 3, role: 'member' },
  documents: [
    node('root-page', null),
    node('folder', null, 'private', 'folder'),
    node('child', 'folder', 'private', 'folder'),
    node('grandchild', 'child'),
    node('shared-page', null, 'link'),
    node('shared-folder', null, 'workspace', 'folder'),
    // My private page inside a shared folder: nobody else sees it, so it shows under Private.
    node('mine-in-shared', 'shared-folder', 'private'),
    node('theirs-in-shared', 'shared-folder', 'workspace', 'page', 'someone-else'),
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
  it('rootsOf: Private is what is mine and private, Shared everything else (folders first)', () => {
    expect(rootsOf(tree.documents, 'private', 'u').map((d) => d.id)).toEqual([
      'folder',
      'root-page',
      // Its folder is shared, so in Private it sits at the top level.
      'mine-in-shared',
      // Corrupt data (a parent loop) has no top-level item; nothing hangs.
    ]);
    expect(rootsOf(tree.documents, 'shared', 'u').map((d) => d.id)).toEqual([
      'shared-folder',
      'shared-page',
      // Folder not visible to me: a top-level item, never unreachable.
      'orphan',
    ]);
  });

  it('sectionOf: a section holds its own items only, so a shared folder never lists my private page', () => {
    const shared = sectionOf(tree.documents, 'shared', 'u').items;
    expect(childrenOf(shared, 'shared-folder').map((d) => d.id)).toEqual(['theirs-in-shared']);
    const mine = sectionOf(tree.documents, 'private', 'u').items;
    expect(childrenOf(mine, 'folder').map((d) => d.id)).toEqual(['child']);
    expect(mine.some((d) => d.visibility !== 'private' || d.ownerId !== 'u')).toBe(false);
  });

  it('a private item that is not mine is never put under Private', () => {
    const leaked = [node('not-mine', null, 'private', 'page', 'someone-else')];
    expect(rootsOf(leaked, 'private', 'u')).toEqual([]);
    expect(rootsOf(leaked, 'shared', 'u').map((d) => d.id)).toEqual(['not-mine']);
  });

  it('childrenOf lists a folder’s items regardless of their visibility', () => {
    expect(childrenOf(tree.documents, 'shared-folder').map((d) => d.id)).toEqual([
      'mine-in-shared',
      'theirs-in-shared',
    ]);
    expect(childrenOf(tree.documents, 'folder').map((d) => d.id)).toEqual(['child']);
  });

  it('ancestorsOf, subtreeIds, pathOf', () => {
    expect(ancestorsOf(tree.documents, 'grandchild').map((d) => d.id)).toEqual(['folder', 'child']);
    expect(ancestorsOf(tree.documents, 'root-page')).toEqual([]);
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
