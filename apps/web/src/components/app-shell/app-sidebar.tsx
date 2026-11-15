'use client';

import { cn } from '@oat/ui';
import { Avatar, AvatarFallback } from '@oat/ui/components/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@oat/ui/components/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from '@oat/ui/components/sidebar';
import {
  CheckIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  HomeIcon,
  LayoutTemplateIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  UsersIcon,
} from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { sections } from '@/lib/navigation';
import { childrenOf, type DocumentNode, type Workspace } from '@/lib/tree';
import { switchWorkspace } from '@/server/actions/workspaces';

import { useCommandMenu } from './command-menu';
import { CreateWorkspaceDialog } from './create-workspace-dialog';
import { useShellData } from './shell-data';
import { useNewNote } from './use-new-note';
import { UserMenu } from './user-menu';

const docHref = (doc: DocumentNode) => `/d/${doc.id}` as Route;

function WorkspaceTile({ workspace, className }: { workspace: Workspace; className?: string }) {
  return (
    <Avatar className={cn('rounded-md after:rounded-md', className)} size="sm">
      <AvatarFallback
        className={cn(
          'rounded-md text-xs font-semibold',
          workspace.kind === 'personal'
            ? 'bg-primary text-primary-foreground'
            : 'bg-secondary text-secondary-foreground',
        )}
      >
        {workspace.name.charAt(0)}
      </AvatarFallback>
    </Avatar>
  );
}

function memberLabel(workspace: Workspace) {
  if (workspace.kind === 'personal') return 'Personal space';
  return workspace.members === 1 ? '1 member' : `${workspace.members} members`;
}

function WorkspaceSwitcher() {
  const { workspace: currentWorkspace, workspaces } = useShellData();
  const [createOpen, setCreateOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const switchTo = (workspace: Workspace) =>
    startTransition(async () => {
      const result = await switchWorkspace(workspace.id);
      if (!result.ok) toast.error(result.error);
    });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            size="lg"
            className="data-[state=open]:bg-sidebar-accent group-data-[collapsible=icon]:pl-1!"
            data-testid="workspace-switcher"
            aria-busy={pending || undefined}
          >
            <WorkspaceTile workspace={currentWorkspace} />
            <div className="flex min-w-0 flex-col gap-0.5 leading-none">
              <span className="truncate font-medium">{currentWorkspace.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {memberLabel(currentWorkspace)}
              </span>
            </div>
            <ChevronsUpDownIcon className="ml-auto text-muted-foreground" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
        >
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Workspaces
          </DropdownMenuLabel>
          {workspaces.map((workspace) => (
            <DropdownMenuItem
              key={workspace.id}
              className="gap-2 py-1.5"
              data-testid="workspace-option"
              onSelect={() => {
                if (workspace.id !== currentWorkspace.id) switchTo(workspace);
              }}
            >
              <WorkspaceTile workspace={workspace} className="size-5" />
              <div className="flex min-w-0 flex-col">
                <span className="truncate">{workspace.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {memberLabel(workspace)}
                </span>
              </div>
              {workspace.id === currentWorkspace.id && <CheckIcon className="ml-auto" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem className="gap-2" onSelect={() => setCreateOpen(true)}>
            <PlusIcon />
            Create workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}

/** One row of the page tree. Folders expand in place; nesting goes one level deep for now. */
function TreeItem({ doc, pathname }: { doc: DocumentNode; pathname: string }) {
  const { documents } = useShellData();
  const children = childrenOf(documents, doc.id, doc.visibility);
  const childActive = children.some((child) => pathname === `/d/${child.id}`);
  const [expanded, setExpanded] = useState(true);
  const open = expanded || childActive;
  const FolderGlyph = open ? FolderOpenIcon : FolderIcon;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={pathname === `/d/${doc.id}`} tooltip={doc.title}>
        <Link href={docHref(doc)}>
          {doc.kind === 'folder' ? <FolderGlyph /> : <FileTextIcon />}
          <span>{doc.title}</span>
        </Link>
      </SidebarMenuButton>
      {children.length > 0 && (
        <>
          <SidebarMenuAction
            aria-label={open ? `Collapse ${doc.title}` : `Expand ${doc.title}`}
            aria-expanded={open}
            onClick={() => setExpanded(!open)}
          >
            <ChevronRightIcon
              className={cn('transition-transform duration-fast', open && 'rotate-90')}
            />
          </SidebarMenuAction>
          {open && (
            <SidebarMenuSub>
              {children.map((child) => (
                <SidebarMenuSubItem key={child.id}>
                  <SidebarMenuSubButton asChild isActive={pathname === `/d/${child.id}`}>
                    <Link href={docHref(child)}>
                      <span>{child.title}</span>
                    </Link>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              ))}
            </SidebarMenuSub>
          )}
        </>
      )}
    </SidebarMenuItem>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="ml-auto rounded-sm border bg-background px-1.5 font-sans text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
      {children}
    </kbd>
  );
}

export function AppSidebar() {
  const pathname = usePathname();
  const { setOpen: openCommandMenu } = useCommandMenu();
  const newNote = useNewNote();
  const { documents } = useShellData();
  const shared = childrenOf(documents, null, 'workspace');
  const privateRoots = childrenOf(documents, null, 'private');

  return (
    <Sidebar collapsible="icon" data-testid="app-sidebar">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <WorkspaceSwitcher />
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarMenu className="gap-0.5">
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="New note"
              onClick={newNote}
              className="font-medium text-primary hover:text-primary"
            >
              <SquarePenIcon />
              <span>New note</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Search · ⌘K" onClick={() => openCommandMenu(true)}>
              <SearchIcon />
              <span>Search</span>
              <Kbd>⌘K</Kbd>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname === sections.home.href}
              tooltip={sections.home.label}
            >
              <Link href={sections.home.href}>
                <HomeIcon />
                <span>{sections.home.label}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Shared</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {shared.map((doc) => (
                <SidebarMenuItem key={doc.id}>
                  <SidebarMenuButton
                    asChild
                    isActive={pathname === `/d/${doc.id}`}
                    tooltip={doc.title}
                  >
                    <Link href={docHref(doc)}>
                      <UsersIcon />
                      <span>{doc.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Private</SidebarGroupLabel>
          <SidebarGroupAction title="New page" onClick={newNote}>
            <PlusIcon />
            <span className="sr-only">New page</span>
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu data-testid="page-tree">
              {privateRoots.map((doc) => (
                <TreeItem key={doc.id} doc={doc} pathname={pathname} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          {[
            { ...sections.templates, Icon: LayoutTemplateIcon },
            { ...sections.settings, Icon: SettingsIcon },
          ].map(({ href, label, Icon }) => (
            <SidebarMenuItem key={href}>
              <SidebarMenuButton asChild isActive={pathname === href} tooltip={label}>
                <Link href={href}>
                  <Icon />
                  <span>{label}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          <SidebarMenuItem>
            <UserMenu />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
