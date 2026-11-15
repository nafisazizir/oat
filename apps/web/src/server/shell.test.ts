import { describe, expect, it } from 'vitest';

import { breadcrumbsFor } from '@/lib/navigation';

import {
  getDocument,
  getShellData,
  listChildren,
  listRecentMeetings,
  listRecentPages,
} from './shell';

describe('shell loader (in-memory until 3.3)', () => {
  it('returns the current workspace, the workspace list and a consistent tree', async () => {
    const data = await getShellData();
    expect(data.workspaces).toContainEqual(data.workspace);
    const ids = data.documents.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const doc of data.documents) {
      if (!doc.parentId) continue;
      const parent = data.documents.find((d) => d.id === doc.parentId);
      expect(parent?.visibility, `${doc.id}'s parent`).toBe(doc.visibility);
    }
  });

  it('getters agree with the shell tree', async () => {
    const data = await getShellData();
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
