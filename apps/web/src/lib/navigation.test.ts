import { describe, expect, it } from 'vitest';

import { breadcrumbsFor } from './navigation';
import { ancestorsOf, childrenOf, type DocumentNode, type ShellData } from './tree';

const doc = (
  id: string,
  parentId: string | null,
  visibility: DocumentNode['visibility'] = 'private',
): DocumentNode => ({
  id,
  title: id.replace(/-/g, ' '),
  kind: 'page',
  visibility,
  parentId,
  updatedAt: '2026-11-01T00:00:00.000Z',
});

/** Fixture tree, independent of the server loader's mock data. */
const tree: Pick<ShellData, 'workspace' | 'documents'> = {
  workspace: { id: 'w', name: 'Studio', kind: 'team', members: 3 },
  documents: [
    doc('root-page', null),
    doc('folder', null),
    doc('child', 'folder'),
    doc('grandchild', 'child'),
    doc('shared-page', null, 'workspace'),
    // Corrupt data must not hang breadcrumbs.
    doc('loop-a', 'loop-b'),
    doc('loop-b', 'loop-a'),
  ],
};

describe('breadcrumbsFor(tree, pathname)', () => {
  it('section pages: workspace › section', () => {
    expect(breadcrumbsFor(tree, '/home')).toEqual([
      { label: 'Studio', href: '/home' },
      { label: 'Home' },
    ]);
    expect(breadcrumbsFor(tree, '/settings').at(-1)).toEqual({ label: 'Settings' });
  });

  it('nested private page: workspace › Private › ancestors › page', () => {
    expect(breadcrumbsFor(tree, '/d/grandchild')).toEqual([
      { label: 'Studio', href: '/home' },
      { label: 'Private' },
      { label: 'folder', href: '/d/folder' },
      { label: 'child', href: '/d/child' },
      { label: 'grandchild' },
    ]);
  });

  it('shared page sits under Shared', () => {
    expect(breadcrumbsFor(tree, '/d/shared-page').map((c) => c.label)).toEqual([
      'Studio',
      'Shared',
      'shared page',
    ]);
  });

  it('unknown document, unknown paths and cycles', () => {
    expect(breadcrumbsFor(tree, '/d/nope').at(-1)).toEqual({ label: 'Not found' });
    expect(breadcrumbsFor(tree, '/home/extra')).toEqual([{ label: 'Studio', href: '/home' }]);
    expect(breadcrumbsFor(tree, '/')).toEqual([{ label: 'Studio', href: '/home' }]);
    expect(breadcrumbsFor(tree, '/d/loop-a').map((c) => c.label)).toEqual([
      'Studio',
      'Private',
      'loop a',
      'loop b',
      'loop a',
    ]);
  });
});

describe('tree helpers', () => {
  it('childrenOf filters by parent and visibility', () => {
    expect(childrenOf(tree.documents, null, 'private').map((d) => d.id)).toEqual([
      'root-page',
      'folder',
    ]);
    expect(childrenOf(tree.documents, null, 'workspace').map((d) => d.id)).toEqual(['shared-page']);
  });

  it('ancestorsOf walks to the root', () => {
    expect(ancestorsOf(tree.documents, 'grandchild').map((d) => d.id)).toEqual(['folder', 'child']);
    expect(ancestorsOf(tree.documents, 'root-page')).toEqual([]);
  });
});
