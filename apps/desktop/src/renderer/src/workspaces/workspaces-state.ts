/**
 * Renderer side of the workspace switcher (3.9): my workspaces on this Mac, the active one and where new notes
 * go, from main (`workspaces:list`), reloaded whenever main announces changes (`meetings:changed`: sync pulled
 * a new workspace or a role change, the active workspace changed).
 */
import type { DesktopWorkspace, WorkspacesSnapshot } from '@oat/core/bridge';
import { useEffect, useState } from 'react';

import { call } from '../bridge.ts';
import { useMeetingsVersion } from '../meetings/meetings-state.ts';

export interface WorkspacesView {
  snapshot: WorkspacesSnapshot | null;
  active: DesktopWorkspace | null;
  /** Where new notes go when that isn't the active workspace (I can only view it), else `null`. */
  fallback: DesktopWorkspace | null;
  setActive(workspaceId: string): Promise<void>;
}

export function useWorkspaces(): WorkspacesView {
  const v = useMeetingsVersion();
  const [snapshot, setSnapshot] = useState<WorkspacesSnapshot | null>(null);
  useEffect(() => {
    let live = true;
    call('workspaces:list')
      .then((s) => live && setSnapshot(s))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [v]);
  return {
    snapshot,
    ...activeAndFallback(snapshot),
    async setActive(workspaceId) {
      // Switch at once; main answers with what it saved, or the switch is undone and the caller shows why.
      const before = snapshot;
      setSnapshot((s) => withActive(s, workspaceId));
      try {
        setSnapshot(await call('workspaces:set-active', { workspaceId }));
      } catch (e) {
        setSnapshot((s) => (s?.activeId === workspaceId ? before : s));
        throw e;
      }
    },
  };
}

/** `snapshot` with `workspaceId` active (the optimistic half of a switch). */
export function withActive(
  snapshot: WorkspacesSnapshot | null,
  workspaceId: string,
): WorkspacesSnapshot | null {
  if (!snapshot) return snapshot;
  const target = snapshot.workspaces.find((w) => w.id === workspaceId);
  const personal = snapshot.workspaces.find((w) => w.kind === 'personal');
  return {
    ...snapshot,
    activeId: workspaceId,
    targetId: target?.canCreate ? workspaceId : (personal?.id ?? snapshot.targetId),
  };
}

/** The active workspace and, when new notes can't go there, where they go instead. */
export function activeAndFallback(snapshot: WorkspacesSnapshot | null): {
  active: DesktopWorkspace | null;
  fallback: DesktopWorkspace | null;
} {
  const find = (id: string | null) => snapshot?.workspaces.find((w) => w.id === id) ?? null;
  const active = find(snapshot?.activeId ?? null);
  const target = find(snapshot?.targetId ?? null);
  return { active, fallback: active && target && target.id !== active.id ? target : null };
}

/** The second line under a workspace's name in the switcher. */
export function roleLabel(w: DesktopWorkspace): string {
  if (w.kind === 'personal') return 'Personal space';
  switch (w.role) {
    case 'owner':
      return 'Owner';
    case 'admin':
      return 'Admin';
    case 'member':
      return 'Member';
    case 'viewer':
      return 'View only';
    default:
      return 'Team';
  }
}
