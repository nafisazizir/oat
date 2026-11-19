'use client';

import { cn } from '@oat/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@oat/ui/components/dropdown-menu';
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@oat/ui/components/sidebar';
import {
  ChevronRightIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderIcon,
  FolderInputIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  LockIcon,
  MoreHorizontalIcon,
  NotebookPenIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import {
  type Area,
  areaOf,
  childrenOf,
  type DocumentNode,
  findDocument,
  rootsOf,
  titleOf,
} from '@/lib/tree';

import { useShellData } from './shell-data';
import { useTreeActions } from './tree-actions';

/** Drag payload type: the dragged node's id. */
const DRAG_TYPE = 'application/x-oat-node';

const isNodeDrag = (event: React.DragEvent) => event.dataTransfer.types.includes(DRAG_TYPE);

function useDrop(onDrop: (draggedId: string) => void, enabled: boolean) {
  const [over, setOver] = useState(false);
  if (!enabled) return { over: false, handlers: {} };
  return {
    over,
    handlers: {
      onDragOver: (event: React.DragEvent) => {
        if (!isNodeDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (!over) setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (event: React.DragEvent) => {
        if (!isNodeDrag(event)) return;
        event.preventDefault();
        setOver(false);
        const id = event.dataTransfer.getData(DRAG_TYPE);
        if (id) onDrop(id);
      },
    },
  };
}

type Row = { node: DocumentNode; depth: number; hasChildren: boolean; open: boolean };

/** Depth-first list of the visible rows (children of collapsed folders are skipped). */
function visibleRows(
  documents: readonly DocumentNode[],
  roots: readonly DocumentNode[],
  collapsed: ReadonlySet<string>,
  activeAncestors: ReadonlySet<string>,
): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();
  const visit = (node: DocumentNode, depth: number) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    const children = node.kind === 'folder' ? childrenOf(documents, node.id) : [];
    const open = children.length > 0 && (!collapsed.has(node.id) || activeAncestors.has(node.id));
    rows.push({ node, depth, hasChildren: children.length > 0, open });
    if (open) for (const child of children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return rows;
}

function activeAncestorsOf(documents: readonly DocumentNode[], pathname: string): Set<string> {
  const ids = new Set<string>();
  const match = /^\/d\/([^/]+)$/.exec(pathname);
  let current = match ? findDocument(documents, decodeURIComponent(match[1]!)) : undefined;
  while (current?.parentId && !ids.has(current.parentId)) {
    ids.add(current.parentId);
    current = findDocument(documents, current.parentId);
  }
  return ids;
}

/**
 * One sidebar section ("Shared" or "Private") of the page tree: its root items and, recursively, the
 * contents of expanded folders. Rows can be dragged onto folders (or onto the section label, for the
 * top level); every row has a "…" menu with Rename, Move to…, New page/folder inside and Delete.
 */
export function TreeSection({ area, label }: { area: Area; label: string }) {
  const pathname = usePathname();
  const { documents } = useShellData();
  const actions = useTreeActions();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const roots = rootsOf(documents, area);
  const rows = visibleRows(documents, roots, collapsed, activeAncestorsOf(documents, pathname));

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rootDrop = useDrop((id) => {
    const node = findDocument(documents, id);
    if (!node) return;
    if (areaOf(node) !== area) {
      toast(area === 'shared' ? 'Private pages stay in Private' : 'Shared pages stay in Shared', {
        description: 'Changing who can see a page arrives with sharing.',
      });
      return;
    }
    void actions.move(node, null);
  }, actions.canCreate);

  return (
    <SidebarGroup data-testid={`tree-section-${area}`}>
      <SidebarGroupLabel
        {...rootDrop.handlers}
        className={cn(rootDrop.over && 'bg-sidebar-accent text-sidebar-accent-foreground')}
      >
        {label}
      </SidebarGroupLabel>
      {actions.canCreate && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<SidebarGroupAction title={`Add to ${label}`} aria-label={`Add to ${label}`} />}
          >
            <PlusIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start">
            <DropdownMenuItem onClick={() => void actions.newPage({ area })}>
              <FilePlusIcon />
              New page
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void actions.newFolder({ area })}>
              <FolderPlusIcon />
              New folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <SidebarGroupContent>
        <SidebarMenu data-testid={area === 'private' ? 'page-tree' : 'shared-tree'}>
          {rows.length === 0 && (
            <li className="px-2 py-1 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
              {area === 'private' ? 'Pages only you can see.' : 'Pages your workspace can see.'}
            </li>
          )}
          {rows.map((row) => (
            <TreeRow
              key={row.node.id}
              row={row}
              area={area}
              active={pathname === `/d/${row.node.id}`}
              onToggle={() => toggle(row.node.id)}
            />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function NodeIcon({ node, open }: { node: DocumentNode; open: boolean }) {
  if (node.kind === 'folder') return open ? <FolderOpenIcon /> : <FolderIcon />;
  if (node.kind === 'meeting') return <NotebookPenIcon />;
  return <FileTextIcon />;
}

function TreeRow({
  row,
  area,
  active,
  onToggle,
}: {
  row: Row;
  area: Area;
  active: boolean;
  onToggle: () => void;
}) {
  const { node, depth, hasChildren, open } = row;
  const { documents } = useShellData();
  const actions = useTreeActions();
  const title = titleOf(node);
  const isFolder = node.kind === 'folder';
  const renaming = actions.renamingId === node.id;
  const drop = useDrop((id) => {
    const dragged = findDocument(documents, id);
    if (dragged && dragged.id !== node.id) void actions.move(dragged, node.id);
  }, isFolder && node.access.edit);
  // A private item inside a shared folder: marked, since the rest of the workspace can't see it.
  const lockedInShared = area === 'shared' && node.visibility === 'private';
  const indent = { paddingLeft: `calc(0.5rem + ${depth} * 0.875rem)` };

  return (
    <SidebarMenuItem
      data-testid="tree-item"
      data-node-id={node.id}
      data-kind={node.kind}
      draggable={node.access.edit && !renaming}
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, node.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
      {...drop.handlers}
      className={cn(drop.over && 'rounded-md ring-2 ring-sidebar-ring')}
    >
      {renaming ? (
        <RenameInput node={node} style={indent} />
      ) : (
        <SidebarMenuButton
          render={<Link href={`/d/${node.id}` as Route} />}
          isActive={active}
          tooltip={title}
          style={indent}
          className={cn(isFolder && hasChildren ? 'pr-14' : 'pr-8')}
        >
          <NodeIcon node={node} open={open} />
          <span className={cn(!node.title.trim() && 'text-muted-foreground')}>{title}</span>
          {lockedInShared && (
            <LockIcon className="ml-auto text-muted-foreground" aria-label="Only you" />
          )}
        </SidebarMenuButton>
      )}
      {isFolder && hasChildren && !renaming && (
        <SidebarMenuAction
          className="right-7"
          aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
          aria-expanded={open}
          onClick={onToggle}
        >
          <ChevronRightIcon
            className={cn('transition-transform duration-fast', open && 'rotate-90')}
          />
        </SidebarMenuAction>
      )}
      {!renaming && <RowMenu node={node} title={title} />}
    </SidebarMenuItem>
  );
}

function RowMenu({ node, title }: { node: DocumentNode; title: string }) {
  const actions = useTreeActions();
  const isFolder = node.kind === 'folder';
  const { edit, delete: canDelete } = node.access;
  // Rename swaps the row for an input: don't let the closing menu pull focus back to its trigger.
  const keepFocus = useRef(false);
  if (!edit && !canDelete) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<SidebarMenuAction showOnHover aria-label={`More actions for ${title}`} />}
      >
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="start"
        className="min-w-44"
        finalFocus={() => {
          const restoreFocus = !keepFocus.current;
          keepFocus.current = false;
          return restoreFocus;
        }}
      >
        {edit && (
          <>
            <DropdownMenuItem
              onClick={() => {
                keepFocus.current = true;
                actions.startRename(node.id);
              }}
            >
              <PencilIcon />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => actions.openMoveDialog(node)}>
              <FolderInputIcon />
              Move to…
            </DropdownMenuItem>
          </>
        )}
        {isFolder && edit && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void actions.newPage({ folderId: node.id })}>
              <FilePlusIcon />
              New page inside
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void actions.newFolder({ parentId: node.id })}>
              <FolderPlusIcon />
              New folder inside
            </DropdownMenuItem>
          </>
        )}
        {canDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => actions.remove(node)}>
              <Trash2Icon />
              {isFolder ? 'Delete folder' : 'Move to trash'}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Inline rename: Enter or blur saves, Escape cancels. */
function RenameInput({ node, style }: { node: DocumentNode; style: React.CSSProperties }) {
  const actions = useTreeActions();
  const [value, setValue] = useState(node.title);
  const cancelled = useRef(false);
  return (
    <SidebarInput
      autoFocus
      aria-label={`Rename ${titleOf(node)}`}
      value={value}
      maxLength={200}
      style={style}
      className="h-8"
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        if (!cancelled.current) void actions.rename(node, value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancelled.current = true;
          actions.cancelRename();
        }
      }}
    />
  );
}
