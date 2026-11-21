import { describe, expect, it } from 'vitest';

import {
  FALLBACK_WORKSPACE_NAME,
  firstWorkspaceName,
  pickActiveWorkspace,
  workspaceSlug,
} from './workspaces.ts';

describe('workspace helpers', () => {
  it('a first workspace is named after the user’s first name, else "My workspace"', () => {
    expect(firstWorkspaceName('Ada Lovelace')).toBe('Ada’s workspace');
    expect(firstWorkspaceName('  Émile   Zola ')).toBe('Émile’s workspace');
    expect(firstWorkspaceName('Cher')).toBe('Cher’s workspace');
    expect(firstWorkspaceName('')).toBe(FALLBACK_WORKSPACE_NAME);
    expect(firstWorkspaceName('   ')).toBe('My workspace');
    expect(firstWorkspaceName(null)).toBe('My workspace');
    expect(firstWorkspaceName(undefined)).toBe('My workspace');
    // Workspace names are at most 60 characters.
    expect(firstWorkspaceName('x'.repeat(100)).length).toBeLessThanOrEqual(60);
  });

  it('slugs are url-safe, bounded and suffixed', () => {
    const fixed = () => 'abcd1234';
    expect(workspaceSlug('Acme Design', fixed)).toBe('acme-design-abcd1234');
    expect(workspaceSlug('  Café — Ops!! ', fixed)).toBe('cafe-ops-abcd1234');
    expect(workspaceSlug('🙂', fixed)).toBe('workspace-abcd1234');
    expect(workspaceSlug('x'.repeat(100), fixed)).toBe(`${'x'.repeat(40)}-abcd1234`);
    expect(workspaceSlug('Acme')).toMatch(/^acme-[0-9a-f]{8}$/);
    expect(workspaceSlug(firstWorkspaceName('Ada Lovelace'), fixed)).toBe(
      'ada-s-workspace-abcd1234',
    );
  });

  it('active workspace: session choice if still a member, else last active, else oldest membership', () => {
    const at = (day: number) => new Date(Date.UTC(2026, 0, day));
    // Listed by name, not by age: "b" is the oldest membership.
    const list = [
      { id: 'a', joinedAt: at(3) },
      { id: 'b', joinedAt: at(1) },
      { id: 'c', joinedAt: at(2) },
    ];
    expect(pickActiveWorkspace(list, 'c')?.id).toBe('c');
    expect(pickActiveWorkspace(list, 'c', 'a')?.id).toBe('c');
    expect(pickActiveWorkspace(list, 'gone', 'a')?.id).toBe('a');
    expect(pickActiveWorkspace(list, null, 'a')?.id).toBe('a');
    expect(pickActiveWorkspace(list, 'gone', 'gone-too')?.id).toBe('b');
    expect(pickActiveWorkspace(list, 'gone')?.id).toBe('b');
    expect(pickActiveWorkspace(list, undefined, null)?.id).toBe('b');
    // Same instant (made in one transaction): the lower id, deterministically.
    expect(
      pickActiveWorkspace(
        [
          { id: 'z', joinedAt: at(1) },
          { id: 'y', joinedAt: at(1) },
        ],
        null,
      )?.id,
    ).toBe('y');
    expect(pickActiveWorkspace([{ id: 't', joinedAt: at(1) }], undefined)?.id).toBe('t');
    expect(pickActiveWorkspace([], 'x', 'y')).toBeUndefined();
    // The input order is left alone.
    expect(list.map((w) => w.id)).toEqual(['a', 'b', 'c']);
  });
});
