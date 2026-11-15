'use client';

import type { DocumentKind as ApiDocumentKind } from '@oat/core';
import { Button } from '@oat/ui/components/button';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@oat/ui/components/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@oat/ui/components/dialog';
import { FolderIcon, LockIcon, UsersIcon } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';

import {
  announceDocumentChange,
  ApiRequestError,
  DOCUMENT_CHANGED_EVENT,
  type DocumentChangedDetail,
  documentsApi,
  foldersApi,
  isApiError,
} from '@/lib/api-client';
import { canRebase } from '@/lib/json-equal';
import {
  type Area,
  areaOf,
  childrenOf,
  type DocumentNode,
  pathOf,
  subtreeIds,
  titleOf,
} from '@/lib/tree';

import { useShellData } from './shell-data';
import { TrashDialog } from './trash-dialog';

/*
 * Every sidebar mutation (create, rename, move, trash, restore, delete) goes through here: one place
 * that calls the API (`src/lib/api-client.ts`), refreshes the server-rendered shell (`router.refresh()`)
 * and shows the dialogs (Move to…, the D-18 "this becomes private" confirmation, folder delete, trash).
 */

type NewPageOptions = { area?: Area; folderId?: string | null; kind?: ApiDocumentKind };

type TreeActions = {
  newPage(options?: NewPageOptions): Promise<void>;
  newFolder(options: { area?: Area; parentId?: string | null }): Promise<void>;
  /** The node whose name is being edited inline in the sidebar. */
  renamingId: string | null;
  startRename(id: string): void;
  cancelRename(): void;
  rename(node: DocumentNode, name: string): Promise<void>;
  openMoveDialog(node: DocumentNode): void;
  /** Move into `folderId` (`null` = root). Asks first when the item would become private. */
  move(node: DocumentNode, folderId: string | null): Promise<void>;
  /** Documents go to the trash; folders ask for confirmation, then trash their documents. */
  remove(node: DocumentNode): void;
  restore(node: DocumentNode): Promise<void>;
  deleteForever(node: DocumentNode): Promise<void>;
  openTrash(): void;
  /** Whether the user may create items in the active workspace (not a viewer). */
  canCreate: boolean;
};

const TreeActionsContext = createContext<TreeActions | null>(null);

export function useTreeActions(): TreeActions {
  const context = useContext(TreeActionsContext);
  if (!context) throw new Error('useTreeActions must be used within TreeActionsProvider.');
  return context;
}

function errorToast(error: unknown, fallback: string) {
  const message = error instanceof ApiRequestError ? error.message : fallback;
  toast.error(fallback, message !== fallback ? { description: message } : undefined);
}

type Confirm = {
  title: string;
  description: string;
  action: string;
  destructive?: boolean;
  run: () => Promise<void>;
};

export function TreeActionsProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { workspace, documents, user } = useShellData();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [moving, setMoving] = useState<DocumentNode | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const canCreate = workspace.role !== 'viewer';
  const busy = useRef(false);

  const refresh = useCallback(() => router.refresh(), [router]);

  const newPage = useCallback(
    async ({ area = 'private', folderId = null, kind = 'page' }: NewPageOptions = {}) => {
      if (busy.current) return;
      busy.current = true;
      try {
        const doc = await documentsApi.create({
          workspaceId: workspace.id,
          folderId,
          kind,
          ...(folderId ? {} : { visibility: area === 'shared' ? 'workspace' : 'private' }),
        });
        router.push(`/d/${doc.id}`);
        refresh();
      } catch (error) {
        errorToast(
          error,
          kind === 'meeting' ? 'Couldn’t create the note' : 'Couldn’t create the page',
        );
      } finally {
        busy.current = false;
      }
    },
    [workspace.id, router, refresh],
  );

  const newFolder = useCallback(
    async ({ area = 'private', parentId = null }: { area?: Area; parentId?: string | null }) => {
      try {
        const folder = await foldersApi.create({
          workspaceId: workspace.id,
          parentId,
          name: 'New folder',
          ...(parentId ? {} : { visibility: area === 'shared' ? 'workspace' : 'private' }),
        });
        refresh();
        setRenamingId(folder.id);
      } catch (error) {
        errorToast(error, 'Couldn’t create the folder');
      }
    },
    [workspace.id, refresh],
  );

  // Newest version seen per document in this tab (autosaves, moves, restores announce theirs), so a
  // sidebar rename doesn't send the stale version the server-rendered tree was loaded with.
  const knownVersions = useRef(new Map<string, number>());
  useEffect(() => {
    const listener = (event: Event) => {
      const { id, version } = (event as CustomEvent<DocumentChangedDetail>).detail;
      if (version > (knownVersions.current.get(id) ?? -1)) knownVersions.current.set(id, version);
    };
    window.addEventListener(DOCUMENT_CHANGED_EVENT, listener);
    return () => window.removeEventListener(DOCUMENT_CHANGED_EVENT, listener);
  }, []);

  const renameDocument = useCallback(async (node: DocumentNode, title: string) => {
    const baseVersion = Math.max(node.version ?? 0, knownVersions.current.get(node.id) ?? 0);
    try {
      return await documentsApi.update(node.id, { baseVersion, title });
    } catch (error) {
      // A title-only patch can't clobber content: if the title on the server is still the one the
      // user saw, only other fields changed (e.g. the body was edited elsewhere) — re-send once.
      const server = isApiError(error, 'stale_version') ? error.body?.document : undefined;
      if (server && canRebase({ title }, { title: node.title, contentJson: null }, server)) {
        return documentsApi.update(node.id, { baseVersion: server.version, title });
      }
      throw error;
    }
  }, []);

  const rename = useCallback(
    async (node: DocumentNode, name: string) => {
      setRenamingId(null);
      const next = name.trim();
      if (next === node.title.trim() || (!next && node.kind === 'folder')) return;
      try {
        if (node.kind === 'folder') {
          await foldersApi.rename(node.id, next);
        } else {
          announceDocumentChange(await renameDocument(node, next));
        }
        refresh();
      } catch (error) {
        if (isApiError(error, 'stale_version')) {
          toast.error('This page was renamed elsewhere', {
            description: 'Reload to get the latest version, then rename it again.',
            action: { label: 'Reload', onClick: () => window.location.reload() },
          });
          refresh();
          return;
        }
        errorToast(error, 'Couldn’t rename');
      }
    },
    [refresh, renameDocument],
  );

  const doMove = useCallback(
    async (node: DocumentNode, folderId: string | null, makePrivate: boolean) => {
      if (node.kind === 'folder') {
        await foldersApi.move(node.id, { parentId: folderId, makePrivate });
      } else {
        announceDocumentChange(await documentsApi.move(node.id, { folderId, makePrivate }));
      }
      refresh();
      const target = folderId ? pathOf(documents, folderId) : null;
      toast.success(`Moved ${titleOf(node)}`, target ? { description: `Now in ${target}` } : {});
    },
    [documents, refresh],
  );

  const move = useCallback(
    async (node: DocumentNode, folderId: string | null) => {
      if (folderId === node.parentId) return;
      if (folderId && subtreeIds(documents, node.id).has(folderId)) {
        toast.error('A folder can’t be moved into itself');
        return;
      }
      const target = folderId ? documents.find((d) => d.id === folderId) : undefined;
      const denied = (): void => {
        toast.error('You can’t move this there', {
          description:
            'Only the owner can file items into a private folder, and only items they own.',
        });
      };
      const askPrivate = () =>
        setConfirm({
          title: `Make “${titleOf(node)}” private?`,
          description: `“${titleOf(target ?? { title: '', kind: 'folder' })}” is a private folder, so ${
            node.kind === 'folder' ? 'this folder and everything in it' : 'this page'
          } will only be visible to you. Workspace members lose access.`,
          action: 'Move and make private',
          run: () => doMove(node, folderId, true),
        });
      // D-18, mirrored from @oat/core so the common cases need no failing round-trip; the server
      // decides (403 / 422 confirm_private) either way.
      if (target?.visibility === 'private') {
        if (target.ownerId !== user.id || node.ownerId !== user.id) return denied();
        if (node.visibility !== 'private') return askPrivate();
      }
      try {
        await doMove(node, folderId, false);
      } catch (error) {
        if (isApiError(error, 'confirm_private')) return askPrivate();
        if (isApiError(error, 'forbidden')) return denied();
        errorToast(error, 'Couldn’t move');
      }
    },
    [documents, doMove, user.id],
  );

  const trashDocument = useCallback(
    async (node: DocumentNode) => {
      try {
        announceDocumentChange(await documentsApi.trash(node.id));
        refresh();
        toast.success(`Moved ${titleOf(node)} to the trash`, {
          action: {
            label: 'Undo',
            onClick: () => {
              void documentsApi.restore(node.id).then(announceDocumentChange).then(refresh);
            },
          },
        });
      } catch (error) {
        errorToast(error, 'Couldn’t move to the trash');
      }
    },
    [refresh],
  );

  const remove = useCallback(
    (node: DocumentNode) => {
      if (node.kind !== 'folder') {
        void trashDocument(node);
        return;
      }
      const inside = subtreeIds(documents, node.id).size - 1;
      setConfirm({
        title: `Delete “${titleOf(node)}”?`,
        description:
          inside > 0
            ? 'The folder and its subfolders are deleted. Pages inside go to the trash, where you can restore them.'
            : 'The empty folder is deleted.',
        action: 'Delete folder',
        destructive: true,
        run: async () => {
          await foldersApi.delete(node.id);
          refresh();
          toast.success(`Deleted ${titleOf(node)}`);
          if (pathname === `/d/${node.id}`) router.push('/home');
        },
      });
    },
    [documents, trashDocument, refresh, pathname, router],
  );

  const restore = useCallback(
    async (node: DocumentNode) => {
      try {
        announceDocumentChange(await documentsApi.restore(node.id));
        refresh();
        toast.success(`Restored ${titleOf(node)}`);
      } catch (error) {
        errorToast(error, 'Couldn’t restore');
      }
    },
    [refresh],
  );

  const deleteForever = useCallback(
    async (node: DocumentNode) => {
      try {
        await documentsApi.deleteForever(node.id);
        if (pathname === `/d/${node.id}`) router.push('/home');
        refresh();
        toast.success(`Deleted ${titleOf(node)} forever`);
      } catch (error) {
        errorToast(error, 'Couldn’t delete');
      }
    },
    [pathname, router, refresh],
  );

  const value = useMemo<TreeActions>(
    () => ({
      newPage,
      newFolder,
      renamingId,
      startRename: setRenamingId,
      cancelRename: () => setRenamingId(null),
      rename,
      openMoveDialog: setMoving,
      move,
      remove,
      restore,
      deleteForever,
      openTrash: () => setTrashOpen(true),
      canCreate,
    }),
    [newPage, newFolder, renamingId, rename, move, remove, restore, deleteForever, canCreate],
  );

  return (
    <TreeActionsContext.Provider value={value}>
      {children}
      <MoveDialog
        node={moving}
        onClose={() => setMoving(null)}
        onPick={(folderId) => {
          const node = moving;
          setMoving(null);
          if (node) void move(node, folderId);
        }}
      />
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !confirmPending) setConfirm(null);
        }}
      >
        <DialogContent data-testid="confirm-dialog" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{confirm?.title}</DialogTitle>
            <DialogDescription>{confirm?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)} disabled={confirmPending}>
              Cancel
            </Button>
            <Button
              variant={confirm?.destructive ? 'destructive' : 'default'}
              disabled={confirmPending}
              onClick={async () => {
                if (!confirm) return;
                setConfirmPending(true);
                try {
                  await confirm.run();
                  setConfirm(null);
                } catch (error) {
                  errorToast(error, 'That didn’t work');
                  setConfirm(null);
                } finally {
                  setConfirmPending(false);
                }
              }}
            >
              {confirm?.action}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <TrashDialog open={trashOpen} onOpenChange={setTrashOpen} />
    </TreeActionsContext.Provider>
  );
}

/**
 * "Move to…": a searchable list of the workspace root and every folder the user can add to, minus the
 * item itself and (for folders) everything inside it. Private folders are marked, since moving into
 * one makes the item private (D-18).
 */
function MoveDialog({
  node,
  onClose,
  onPick,
}: {
  node: DocumentNode | null;
  onClose: () => void;
  onPick: (folderId: string | null) => void;
}) {
  const { documents, workspace } = useShellData();
  const excluded = node ? subtreeIds(documents, node.id) : new Set<string>();
  const folders = documents
    .filter((d) => d.kind === 'folder' && d.access.edit && !excluded.has(d.id))
    .map((folder) => ({ folder, path: pathOf(documents, folder.id) }))
    .toSorted((a, b) => a.path.localeCompare(b.path));
  const root = node ? areaOf(node) : 'private';

  return (
    <CommandDialog
      open={node !== null}
      onOpenChange={(open) => !open && onClose()}
      title={node ? `Move ${titleOf(node)}` : 'Move'}
      description="Pick a folder to move it into."
    >
      <Command>
        <CommandInput placeholder="Move to…" />
        <CommandList data-testid="move-dialog">
          <CommandEmpty>No folders match.</CommandEmpty>
          <CommandGroup heading={node ? `Move “${titleOf(node)}” to` : 'Move to'}>
            {node?.parentId !== null && (
              <CommandItem value={`root ${workspace.name}`} onSelect={() => onPick(null)}>
                {root === 'private' ? <LockIcon /> : <UsersIcon />}
                {root === 'private' ? 'Private (top level)' : 'Shared (top level)'}
              </CommandItem>
            )}
            {folders.map(({ folder, path }) => (
              <CommandItem
                key={folder.id}
                value={`${path} ${folder.id}`}
                disabled={folder.id === node?.parentId}
                onSelect={() => onPick(folder.id)}
              >
                <FolderIcon />
                <span className="min-w-0 flex-1 truncate">{path}</span>
                {folder.visibility === 'private' && (
                  <LockIcon className="text-muted-foreground" aria-label="Private" />
                )}
                {childrenOf(documents, folder.id).length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {childrenOf(documents, folder.id).length}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
