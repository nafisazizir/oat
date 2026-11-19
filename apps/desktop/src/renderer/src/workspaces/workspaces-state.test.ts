import type { DesktopWorkspace } from '@oat/core/bridge';
import { describe, expect, it } from 'vitest';

import { activeAndFallback, roleLabel, undoSwitch, withActive } from './workspaces-state.ts';

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

  it('switches optimistically: new notes follow when I can add to the workspace, else go to personal', () => {
    expect(withActive(null, 'team')).toBeNull();
    const snapshot = { workspaces: all, activeId: 'me', targetId: 'me' };
    expect(withActive(snapshot, 'team')).toEqual({
      workspaces: all,
      activeId: 'team',
      targetId: 'team',
    });
    expect(withActive(snapshot, 'board')).toEqual({
      workspaces: all,
      activeId: 'board',
      targetId: 'me',
    });
    expect(snapshot.activeId).toBe('me');
  });

  it('labels personal and team roles', () => {
    expect(all.map(roleLabel)).toEqual(['Personal space', 'Member', 'View only']);
    expect(roleLabel(ws('x', 'team', null))).toBe('Team');
  });
});

describe('undoSwitch', () => {
  const workspaces = [ws('p', 'personal', 'owner'), ws('t', 'team', 'member')];
  const before = { workspaces, activeId: 'p', targetId: 'p' };

  it('restores the snapshot from before a rejected switch', () => {
    const optimistic = withActive(before, 't');
    expect(undoSwitch(before, 't')(optimistic)).toBe(before);
  });

  it('keeps a later switch the user made while the first was pending', () => {
    const later = { workspaces, activeId: 'p', targetId: 'p' };
    expect(undoSwitch(before, 't')(later)).toBe(later);
  });
});
