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
  /**
   * I can only view the active workspace and there is no other one to put new notes in (D-36): the sidebar
   * asks me to create a workspace.
   */
  needsWorkspace: boolean;
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
        setSnapshot(undoSwitch(before, workspaceId));
        throw e;
      }
    },
  };
}

/**
 * Undo a failed switch to `workspaceId`: back to `before`, unless the user has switched again since
 * (then the later switch stands).
 */
export function undoSwitch(before: WorkspacesSnapshot | null, workspaceId: string) {
  return (current: WorkspacesSnapshot | null) =>
    current?.activeId === workspaceId ? before : current;
}

/** `snapshot` with `workspaceId` active (the optimistic half of a switch). */
export function withActive(
  snapshot: WorkspacesSnapshot | null,
  workspaceId: string,
): WorkspacesSnapshot | null {
  if (!snapshot) return snapshot;
  const active = snapshot.workspaces.find((w) => w.id === workspaceId);
  // The rule main applies (`newNoteTarget`): here when I can create here, else the first one where I can.
  const target = active?.canCreate ? active : snapshot.workspaces.find((w) => w.canCreate);
  return { ...snapshot, activeId: workspaceId, targetId: target?.id ?? null };
}

/** The active workspace and, when new notes can't go there, where they go instead (if anywhere). */
export function activeAndFallback(snapshot: WorkspacesSnapshot | null): {
  active: DesktopWorkspace | null;
  fallback: DesktopWorkspace | null;
  needsWorkspace: boolean;
} {
  const find = (id: string | null) => snapshot?.workspaces.find((w) => w.id === id) ?? null;
  const active = find(snapshot?.activeId ?? null);
  const target = find(snapshot?.targetId ?? null);
  return {
    active,
    fallback: active && target && target.id !== active.id ? target : null,
    needsWorkspace: active !== null && target === null,
  };
}

/** The second line under a workspace's name in the switcher. */
export function roleLabel(w: DesktopWorkspace): string {
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
      return 'Workspace';
  }
}
