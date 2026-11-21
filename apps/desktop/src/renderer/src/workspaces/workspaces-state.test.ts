import type { DesktopWorkspace } from '@oat/core/bridge';
import { describe, expect, it } from 'vitest';

import { activeAndFallback, roleLabel, undoSwitch, withActive } from './workspaces-state.ts';

const ws = (id: string, role: DesktopWorkspace['role']) => ({
  id,
  name: id,
  role,
  canCreate: role !== null && role !== 'viewer',
});
// As main lists them: by name.
const all = [ws('board', 'viewer'), ws('mine', 'owner'), ws('team', 'member')];
const viewOnly = [ws('board', 'viewer'), ws('council', 'viewer')];

describe('workspace switcher state', () => {
  it('names the fallback only when new notes can’t go to the active workspace', () => {
    expect(activeAndFallback(null)).toEqual({
      active: null,
      fallback: null,
      needsWorkspace: false,
    });
    expect(
      activeAndFallback({ workspaces: all, activeId: 'team', targetId: 'team' }),
    ).toMatchObject({ active: { id: 'team' }, fallback: null, needsWorkspace: false });
    expect(
      activeAndFallback({ workspaces: all, activeId: 'board', targetId: 'mine' }),
    ).toMatchObject({ active: { id: 'board' }, fallback: { id: 'mine' }, needsWorkspace: false });
  });

  it('asks for a workspace when I can only view the ones I am in (no target at all)', () => {
    expect(
      activeAndFallback({ workspaces: viewOnly, activeId: 'board', targetId: null }),
    ).toMatchObject({ active: { id: 'board' }, fallback: null, needsWorkspace: true });
    // Nothing known yet (first launch, before sync): nothing to say.
    expect(activeAndFallback({ workspaces: [], activeId: null, targetId: null })).toEqual({
      active: null,
      fallback: null,
      needsWorkspace: false,
    });
  });

  it('switches optimistically: new notes follow when I can add to the workspace, else go to the first one where I can', () => {
    expect(withActive(null, 'team')).toBeNull();
    const snapshot = { workspaces: all, activeId: 'mine', targetId: 'mine' };
    expect(withActive(snapshot, 'team')).toEqual({
      workspaces: all,
      activeId: 'team',
      targetId: 'team',
    });
    expect(withActive(snapshot, 'board')).toEqual({
      workspaces: all,
      activeId: 'board',
      targetId: 'mine',
    });
    expect(snapshot.activeId).toBe('mine');
    // Nowhere to create: no target (never a stale one from before the switch).
    expect(
      withActive({ workspaces: viewOnly, activeId: 'board', targetId: null }, 'council'),
    ).toEqual({ workspaces: viewOnly, activeId: 'council', targetId: null });
  });

  it('labels a workspace by my role in it (every workspace is the same kind)', () => {
    expect(all.map(roleLabel)).toEqual(['View only', 'Owner', 'Member']);
    expect(roleLabel(ws('x', 'admin'))).toBe('Admin');
    expect(roleLabel(ws('x', null))).toBe('Workspace');
  });
});

describe('undoSwitch', () => {
  const workspaces = [ws('p', 'owner'), ws('t', 'member')];
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
