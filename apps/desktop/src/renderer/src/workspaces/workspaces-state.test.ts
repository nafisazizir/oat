import type { DesktopWorkspace } from '@oat/core/bridge';
import { describe, expect, it } from 'vitest';

import { activeAndFallback, roleLabel } from './workspaces-state.ts';

const ws = (id: string, kind: 'personal' | 'team', role: DesktopWorkspace['role']) => ({
  id,
  name: id,
  kind,
  role,
  canCreate: role !== 'viewer',
});
const all = [
  ws('me', 'personal', 'owner'),
  ws('team', 'team', 'member'),
  ws('board', 'team', 'viewer'),
];

describe('workspace switcher state', () => {
  it('names the fallback only when new notes can’t go to the active workspace', () => {
    expect(activeAndFallback(null)).toEqual({ active: null, fallback: null });
    expect(
      activeAndFallback({ workspaces: all, activeId: 'team', targetId: 'team' }),
    ).toMatchObject({ active: { id: 'team' }, fallback: null });
    expect(activeAndFallback({ workspaces: all, activeId: 'board', targetId: 'me' })).toMatchObject(
      { active: { id: 'board' }, fallback: { id: 'me' } },
    );
  });

  it('labels personal and team roles', () => {
    expect(all.map(roleLabel)).toEqual(['Personal space', 'Member', 'View only']);
    expect(roleLabel(ws('x', 'team', null))).toBe('Team');
  });
});
