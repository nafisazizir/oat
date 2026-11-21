import { describe, expect, it } from 'vitest';

import {
  SECTION_INFO,
  sectionTree,
  SIDEBAR_SECTIONS,
  sidebarSection,
  splitSections,
  visibilityBadge,
  visibilityLabel,
} from './sections.ts';

const ME = 'me';
const item = (
  id: string,
  visibility: 'private' | 'workspace' | 'link',
  ownerId = ME,
  parentId: string | null = null,
) => ({ id, visibility, ownerId, parentId });

describe('sidebarSection', () => {
  it('Private is what is mine and private', () => {
    expect(sidebarSection(item('a', 'private'), ME)).toBe('private');
  });

  it('everything else I can read is Shared, whoever owns it', () => {
    expect(sidebarSection(item('a', 'workspace'), ME)).toBe('shared');
    expect(sidebarSection(item('a', 'link'), ME)).toBe('shared');
    expect(sidebarSection(item('a', 'workspace', 'other'), ME)).toBe('shared');
    expect(sidebarSection(item('a', 'link', 'other'), ME)).toBe('shared');
  });

  it('never files someone else’s private item under my Private', () => {
    expect(sidebarSection(item('a', 'private', 'other'), ME)).toBe('shared');
  });
});

describe('splitSections', () => {
  it('splits a list in two and keeps its order', () => {
    const items = [
      item('1', 'private'),
      item('2', 'workspace'),
      item('3', 'private'),
      item('4', 'link', 'other'),
    ];
    const split = splitSections(items, ME);
    expect(split.private.map((i) => i.id)).toEqual(['1', '3']);
    expect(split.shared.map((i) => i.id)).toEqual(['2', '4']);
  });

  it('an item changes section when its visibility changes, and only then', () => {
    const before = splitSections([item('1', 'private')], ME);
    expect(before.private).toHaveLength(1);
    const after = splitSections([item('1', 'workspace')], ME);
    expect(after.private).toHaveLength(0);
    expect(after.shared.map((i) => i.id)).toEqual(['1']);
    expect(splitSections([item('1', 'private')], ME).private).toHaveLength(1);
  });

  it('gives empty sections for an empty list', () => {
    expect(splitSections([], ME)).toEqual({ private: [], shared: [] });
  });
});

describe('sectionTree', () => {
  const items = [
    item('private-folder', 'private'),
    item('in-private-folder', 'private', ME, 'private-folder'),
    item('shared-folder', 'workspace', 'other'),
    item('theirs', 'workspace', 'other', 'shared-folder'),
    item('mine-in-shared-folder', 'private', ME, 'shared-folder'),
    item('in-a-folder-i-cannot-see', 'workspace', 'other', 'hidden'),
  ];

  it('Private holds my private folders and what is inside them', () => {
    const tree = sectionTree(items, 'private', ME);
    expect(tree.items.map((i) => i.id)).toEqual([
      'private-folder',
      'in-private-folder',
      'mine-in-shared-folder',
    ]);
    // My private note in a shared folder is a top-level item: its folder is not in this section.
    expect(tree.roots.map((i) => i.id)).toEqual(['private-folder', 'mine-in-shared-folder']);
  });

  it('Shared holds the rest; an item whose folder I can’t see is still reachable', () => {
    const tree = sectionTree(items, 'shared', ME);
    expect(tree.items.map((i) => i.id)).toEqual([
      'shared-folder',
      'theirs',
      'in-a-folder-i-cannot-see',
    ]);
    expect(tree.roots.map((i) => i.id)).toEqual(['shared-folder', 'in-a-folder-i-cannot-see']);
  });

  it('every item is in exactly one section', () => {
    const all = SIDEBAR_SECTIONS.flatMap((s) => sectionTree(items, s, ME).items.map((i) => i.id));
    expect(all.toSorted()).toEqual(items.map((i) => i.id).toSorted());
  });
});

describe('visibilityLabel', () => {
  it('says who the item reaches, from its visibility alone', () => {
    expect(visibilityLabel('private', 'Acme')).toBe('Only you');
    expect(visibilityLabel('workspace', 'Acme')).toBe('Everyone in Acme');
    expect(visibilityLabel('link', 'Acme')).toBe('Everyone in Acme + link');
  });

  it('has no wording for "a workspace of one": it takes no member count', () => {
    // A workspace-visible note is readable by whoever joins next, so it never reads "Only you".
    expect(visibilityLabel.length).toBe(2);
    expect(visibilityLabel('workspace', 'Ada’s workspace')).not.toMatch(/only you/i);
  });

  it('falls back when the workspace name is not known', () => {
    expect(visibilityLabel('workspace', ' ')).toBe('Everyone in the workspace');
  });
});

describe('visibilityBadge', () => {
  it('names a private item after its section and anything else after who it reaches', () => {
    expect(visibilityBadge('private', 'Acme')).toBe('Private');
    expect(visibilityBadge('workspace', 'Acme')).toBe('Everyone in Acme');
    expect(visibilityBadge('link', 'Acme')).toBe('Everyone in Acme + link');
  });
});

describe('SECTION_INFO', () => {
  it('names both sections and says what goes in each', () => {
    expect(SIDEBAR_SECTIONS.map((s) => SECTION_INFO[s].label)).toEqual(['Private', 'Shared']);
    for (const s of SIDEBAR_SECTIONS) expect(SECTION_INFO[s].empty.length).toBeGreaterThan(10);
  });
});
