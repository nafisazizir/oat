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
  useSidebar,
} from '@oat/ui/components/sidebar';
import { Spinner } from '@oat/ui/components/spinner';
import { SECTION_INFO } from '@oat/core/sections';
import {
  IconChevronRight,
  IconDots,
  IconFilePlus,
  IconFileText,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconFolderSymlink,
  IconNotes,
  IconPencil,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { useWorkspaceHost } from './host';
import { hrefOf } from './routes';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import {
  type Area,
  areaOf,
  childrenOf,
  type DocumentNode,
  findDocument,
  sectionOf,
  titleOf,
} from './tree';

import { isPendingId } from './optimistic-tree';
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
 * One sidebar section of the page tree (D-36): "Private" — what is mine and private, folders and their
 * contents included — or "Shared" — everything else I can read. Which section an item is in follows its
 * visibility (`@oat/core` `sidebarSection`), so it changes section as soon as that changes. Shows its top
 * level and, recursively, the contents of expanded folders. Rows can be dragged onto folders (or onto the
 * section label, for the top level); every row has a "…" menu with Rename, Move to…, New page/folder
 * inside and Delete.
 */
export function TreeSection({ area }: { area: Area }) {
  const host = useWorkspaceHost();
  const pathname = hrefOf(host.route).split('?')[0]!;
  const { documents, user } = useShellData();
  const actions = useTreeActions();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [open, setOpen] = useState(true);
  const { state, isMobile } = useSidebar();
  const iconOnly = state === 'collapsed' && !isMobile;
  const { label } = SECTION_INFO[area];
  // Only this section's items: a shared folder never lists my private page (it is under Private).
  const { items, roots } = sectionOf(documents, area, user.id);
  const rows = visibleRows(items, roots, collapsed, activeAncestorsOf(items, pathname));

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
    if (areaOf(node, user.id) !== area) {
      // Dropping is for arranging, never for changing who can see something.
      toast(area === 'shared' ? 'This is private' : 'This is shared', {
        description: 'To change who can see it, open it and use Share.',
      });
      return;
    }
    void actions.move(node, null);
  }, actions.canCreate);

  return (
    <SidebarGroup className="group/tree-section py-1" data-testid={`tree-section-${area}`}>
      <SidebarGroupLabel
        {...rootDrop.handlers}
        render={
          <button
            type="button"
            tabIndex={iconOnly ? -1 : 0}
            aria-hidden={iconOnly || undefined}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          />
        }
        className={cn(
          'group-data-[collapsible=icon]:hidden',
          rootDrop.over && 'bg-brand-100 text-brand-1000',
        )}
      >
        {label}
        <IconChevronRight className={cn('ms-1 size-3.5', open && 'rotate-90')} />
      </SidebarGroupLabel>
      {actions.canCreate && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarGroupAction
                className="opacity-0 group-hover/tree-section:opacity-100 group-focus-within/tree-section:opacity-100 data-popup-open:opacity-100"
                title={`Add to ${label}`}
                aria-label={`Add to ${label}`}
              />
            }
          >
            <IconPlus />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start">
            <DropdownMenuItem
              onClick={() => {
                setOpen(true);
                void actions.newPage({ area });
              }}
            >
              <IconFilePlus />
              New page
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                setOpen(true);
                void actions.newFolder({ area });
              }}
            >
              <IconFolderPlus />
              New folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {open && (
        <SidebarGroupContent>
          <SidebarMenu data-testid={area === 'private' ? 'page-tree' : 'shared-tree'}>
            {rows.map((row) => (
              <TreeRow
                key={row.node.id}
                row={row}
                active={pathname === `/d/${row.node.id}`}
                onToggle={() => toggle(row.node.id)}
              />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  );
}

function NodeIcon({ node, open }: { node: DocumentNode; open: boolean }) {
  if (isPendingId(node.id)) return <Spinner />;
  if (node.kind === 'folder') return open ? <IconFolderOpen /> : <IconFolder />;
  if (node.kind === 'meeting') return <IconNotes />;
  return <IconFileText />;
}

function TreeRow({ row, active, onToggle }: { row: Row; active: boolean; onToggle: () => void }) {
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
  const indent = { paddingInlineStart: `calc(0.5rem + ${depth} * 0.875rem)` };
  const { Link } = useWorkspaceHost();
  const pending = isPendingId(node.id);

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
      aria-busy={pending || undefined}
      className={cn(drop.over && 'rounded-md bg-brand-100 ring-1 ring-brand-500 ring-inset')}
    >
      {renaming ? (
        <RenameInput node={node} style={indent} />
      ) : (
        <SidebarMenuButton
          // Not openable until the server has created it (a moment after it appears).
          render={
            pending ? <span aria-disabled /> : <Link route={{ view: 'document', id: node.id }} />
          }
          isActive={active}
          tooltip={title}
          style={indent}
          className={cn(isFolder && hasChildren ? 'pe-14' : 'pe-8')}
        >
          <NodeIcon node={node} open={open} />
          <span className={cn(!node.title.trim() && 'text-gray-900')}>{title}</span>
        </SidebarMenuButton>
      )}
      {isFolder && hasChildren && !renaming && (
        <SidebarMenuAction
          className="end-7 opacity-0 group-hover/menu-item:opacity-100 group-focus-within/menu-item:opacity-100 aria-expanded:bg-transparent aria-expanded:text-gray-1000"
          aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
          aria-expanded={open}
          onClick={onToggle}
        >
          <IconChevronRight
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
        <IconDots />
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
              <IconPencil />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => actions.openMoveDialog(node)}>
              <IconFolderSymlink />
              Move to…
            </DropdownMenuItem>
          </>
        )}
        {isFolder && edit && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void actions.newPage({ folderId: node.id })}>
              <IconFilePlus />
              New page inside
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void actions.newFolder({ parentId: node.id })}>
              <IconFolderPlus />
              New folder inside
            </DropdownMenuItem>
          </>
        )}
        {canDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => actions.remove(node)}>
              <IconTrash />
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
