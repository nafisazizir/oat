/**
 * The desktop's workspaces (task 3.9): the signed-in user's personal and team workspaces as sync brought them
 * to this Mac (with my role in each, pull scope 3), which one the sidebar shows, and where new meeting notes go.
 *
 * - The active workspace is remembered in the user's own local database (one file per account, D-28), so each
 *   account on this Mac keeps its own choice. A workspace that is gone (left, deleted) falls back to personal.
 * - New notes ("New meeting note", calendar / detection "Start notes") go to the active workspace when I may
 *   create there (`canCreateInWorkspace` — never as a viewer), else to my personal workspace; the snapshot's
 *   `targetId` says which, so the sidebar can tell. The server re-checks every push (sync push authz).
 * - Notes never move between workspaces afterwards (D-18): the choice is made when the note is created.
 */
import { canCreateInWorkspace, createPermissionContext } from '@oat/core';
import type { DesktopWorkspace, WorkspacesSnapshot } from '@oat/core/bridge';
import type { LocalStore } from '@oat/local-store';

/** `sync_state` key of the active workspace (per account: the database is the account's). */
export const ACTIVE_WORKSPACE_KEY = 'desktop.activeWorkspace';

export interface WorkspacesOptions {
  /** The signed-in user's local database (`null` while it isn't open). */
  store: () => LocalStore | null;
  /** The signed-in user (`null` when signed out). */
  userId: () => string | null;
  /** Waits for the first pull on a fresh database (SyncService). */
  sync: { personalWorkspace(timeoutMs?: number): Promise<string | null> };
  /** The active workspace changed: windows reload their lists. */
  onChange: () => void;
}

export class WorkspacesError extends Error {
  override name = 'WorkspacesError';
}

const EMPTY: WorkspacesSnapshot = { workspaces: [], activeId: null, targetId: null };

export class Workspaces {
  readonly #o: WorkspacesOptions;

  constructor(options: WorkspacesOptions) {
    this.#o = options;
  }

  snapshot(): WorkspacesSnapshot {
    const store = this.#o.store();
    const userId = this.#o.userId();
    if (!store || !userId) return EMPTY;
    const local = store.workspaces();
    const ctx = createPermissionContext({
      userId,
      memberships: local.flatMap((w) =>
        w.role ? [{ workspaceId: w.id, userId, role: w.role }] : [],
      ),
    });
    const workspaces: DesktopWorkspace[] = local
      .map((w) => ({
        id: w.id,
        name: w.name,
        kind: w.kind,
        role: w.role,
        // A personal workspace pulled before roles were synced is still mine.
        canCreate:
          (w.kind === 'personal' && w.role === null) ||
          canCreateInWorkspace(ctx, { id: w.id, kind: w.kind }),
      }))
      .sort(byKindThenName);
    const personal = workspaces.find((w) => w.kind === 'personal') ?? null;
    const stored = store.getState(ACTIVE_WORKSPACE_KEY);
    const active = workspaces.find((w) => w.id === stored) ?? personal ?? workspaces[0] ?? null;
    const target = active?.canCreate ? active : (personal ?? null);
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
   * Where a new meeting note goes now (see the module comment). On a fresh database, waits for sync to learn
   * the personal workspace (bounded); `null` when it still can't be known (offline on first launch).
   */
  async newNoteWorkspace(timeoutMs?: number): Promise<string | null> {
    const target = this.snapshot().targetId;
    if (target) return target;
    return this.#o.sync.personalWorkspace(timeoutMs);
  }
}

function byKindThenName(a: DesktopWorkspace, b: DesktopWorkspace) {
  if (a.kind !== b.kind) return a.kind === 'personal' ? -1 : 1;
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}
