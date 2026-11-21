/**
 * The desktop's workspaces (task 3.9; one kind of workspace since D-36): the signed-in user's workspaces as
 * sync brought them to this Mac (with my role in each, pull scope 3), which one the sidebar shows, and where
 * new meeting notes go.
 *
 * - The active workspace is remembered in the user's own local database (one file per account, D-28), so each
 *   account on this Mac keeps its own choice. Nothing chosen yet, or the chosen one is gone (left, deleted):
 *   the first workspace I can create in, else the first one listed.
 * - New notes ("New meeting note", calendar / detection "Start notes") go to the active workspace when I may
 *   create there (`canCreateInWorkspace` — never as a viewer), else to the first workspace (by name) where I
 *   may; the snapshot's `targetId` says which, so the sidebar can tell. When I can only view every workspace
 *   I am in there is no target (`null`): the sidebar and the refused start ask me to create a workspace, and
 *   nothing is recorded that would have nowhere to go. The server re-checks every push (sync push authz).
 * - Notes never move between workspaces afterwards (D-18): the choice is made when the note is created.
 */
import { canCreateInWorkspace, createPermissionContext } from '@oat/core';
import type { DesktopWorkspace, WorkspacesSnapshot } from '@oat/core/bridge';
import type { LocalStore } from '@oat/local-store';

/** `sync_state` key of the active workspace (per account: the database is the account's). */
export const ACTIVE_WORKSPACE_KEY = 'desktop.activeWorkspace';

/** Nothing is known about the account's workspaces yet (a fresh database that never synced). */
export const CONNECT_ONCE_MESSAGE =
  'Oat needs to connect once to set up your notes on this Mac. Check your connection and try again.';

/** Every workspace on this Mac is view-only for me: there is nowhere to put a new note. */
export const CREATE_WORKSPACE_MESSAGE =
  'You can only view the workspaces you’re in, so there’s nowhere to save a new note. Create a workspace of your own in Oat on the web, then try again.';

/**
 * Why a new note has nowhere to go (`newNoteWorkspace()` answered `null`), in words for the user: either
 * sync hasn't brought any workspace yet, or I can't create in any of mine (D-36: create one).
 */
export function noNoteWorkspaceMessage(store: LocalStore | null): string {
  return store && store.workspaces().length > 0 ? CREATE_WORKSPACE_MESSAGE : CONNECT_ONCE_MESSAGE;
}

export interface WorkspacesOptions {
  /** The signed-in user's local database (`null` while it isn't open). */
  store: () => LocalStore | null;
  /** The signed-in user (`null` when signed out). */
  userId: () => string | null;
  /** Waits for the first pull on a fresh database (SyncService): whether any workspace is known now. */
  sync: { awaitWorkspaces(timeoutMs?: number): Promise<boolean> };
  /** The active workspace changed: windows reload their lists. */
  onChange: () => void;
}

export class WorkspacesError extends Error {
  override name = 'WorkspacesError';
}

const EMPTY: WorkspacesSnapshot = { workspaces: [], activeId: null, targetId: null };

/**
 * Where new notes go: `active` when I can create there, else the first workspace (as listed: by name) where
 * I can, else `null`. The renderer's optimistic switch uses the same rule.
 */
export function newNoteTarget(
  workspaces: readonly DesktopWorkspace[],
  active: DesktopWorkspace | null | undefined,
): DesktopWorkspace | null {
  return active?.canCreate ? active : (workspaces.find((w) => w.canCreate) ?? null);
}

export class Workspaces {
  readonly #o: WorkspacesOptions;

  constructor(options: WorkspacesOptions) {
    this.#o = options;
  }

  snapshot(): WorkspacesSnapshot {
    const store = this.#o.store();
    const userId = this.#o.userId();
    if (!store || !userId) return EMPTY;
    const local = store.workspaces(); // by name
    const ctx = createPermissionContext({
      userId,
      memberships: local.flatMap((w) =>
        w.role ? [{ workspaceId: w.id, userId, role: w.role }] : [],
      ),
    });
    const workspaces: DesktopWorkspace[] = local.map((w) => ({
      id: w.id,
      name: w.name,
      role: w.role,
      // A workspace pulled before roles were synced (`role: null`) is not mine to write in until sync says.
      canCreate: canCreateInWorkspace(ctx, { id: w.id }),
    }));
    const stored = store.getState(ACTIVE_WORKSPACE_KEY);
    const active =
      workspaces.find((w) => w.id === stored) ??
      workspaces.find((w) => w.canCreate) ??
      workspaces[0] ??
      null;
    const target = newNoteTarget(workspaces, active);
    return { workspaces, activeId: active?.id ?? null, targetId: target?.id ?? null };
  }

  setActive(workspaceId: string): WorkspacesSnapshot {
    const store = this.#o.store();
    if (!store || !this.#o.userId()) {
      throw new WorkspacesError('Your workspaces on this Mac aren’t available right now.');
    }
    if (!store.workspace(workspaceId)) {
      throw new WorkspacesError('That workspace isn’t on this Mac.');
    }
    if (store.getState(ACTIVE_WORKSPACE_KEY) !== workspaceId) {
      store.setState(ACTIVE_WORKSPACE_KEY, workspaceId);
      this.#o.onChange();
    }
    return this.snapshot();
  }

  /**
   * Where a new meeting note goes now (see the module comment). On a fresh database, waits for sync to bring
   * my workspaces (bounded). `null` when there is nowhere: it still can't be known (offline on first launch),
   * or I can't create in any workspace I am in — `noNoteWorkspaceMessage` says which.
   */
  async newNoteWorkspace(timeoutMs?: number): Promise<string | null> {
    const now = this.snapshot();
    if (now.targetId || now.workspaces.length > 0) return now.targetId;
    await this.#o.sync.awaitWorkspaces(timeoutMs);
    return this.snapshot().targetId;
  }
}
