import { describe, expect, it } from 'vitest';

import { personalWorkspaceSlug, pickActiveWorkspace, teamWorkspaceSlug } from './workspaces.ts';

describe('workspace helpers', () => {
  it('personal slug is deterministic per user', () => {
    expect(personalWorkspaceSlug('u1')).toBe('personal-u1');
  });

  it('team slugs are url-safe, bounded and suffixed', () => {
    const fixed = () => 'abcd1234';
    expect(teamWorkspaceSlug('Acme Design', fixed)).toBe('acme-design-abcd1234');
    expect(teamWorkspaceSlug('  Café — Ops!! ', fixed)).toBe('cafe-ops-abcd1234');
    expect(teamWorkspaceSlug('🙂', fixed)).toBe('workspace-abcd1234');
    expect(teamWorkspaceSlug('x'.repeat(100), fixed)).toBe(`${'x'.repeat(40)}-abcd1234`);
    expect(teamWorkspaceSlug('Acme')).toMatch(/^acme-[0-9a-f]{8}$/);
  });

  it('active workspace: session choice if still a member, else personal, else first', () => {
    const list = [
      { id: 'p', kind: 'personal' as const },
      { id: 't', kind: 'team' as const },
    ];
    expect(pickActiveWorkspace(list, 't')?.id).toBe('t');
    expect(pickActiveWorkspace(list, 'gone')?.id).toBe('p');
    expect(pickActiveWorkspace(list, null)?.id).toBe('p');
    expect(pickActiveWorkspace([{ id: 't', kind: 'team' as const }], undefined)?.id).toBe('t');
    expect(pickActiveWorkspace([], 'x')).toBeUndefined();
  });
});
