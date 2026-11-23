'use client';

import { useOptimistic, useState, useTransition, type ReactNode } from 'react';
import { cn } from '@oat/ui/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@oat/ui/components/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@oat/ui/components/dropdown-menu';
import { Kbd } from '@oat/ui/components/kbd';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
} from '@oat/ui/components/sidebar';
import {
  IconCheck,
  IconChevronDown,
  IconChecklist,
  IconDoorEnter,
  IconLayoutGrid,
  IconPlus,
  IconSearch,
  IconSettings,
  IconTrash,
} from '@tabler/icons-react';
import { toast } from 'sonner';
import { useWorkspaceHost } from './host';
import type { Workspace } from './tree';
import { WorkspaceAvatar } from './workspace-avatar';
import { CreateWorkspaceDialog } from './create-workspace-dialog';
import { TreeSection } from './page-tree';
import { ChatsSection } from './sidebar-chats';
import { useOptimisticTree, useShellData } from './shell-data';
import { useTreeActions } from './tree-actions';

function MenuIcon({ children }: { children: ReactNode }) {
  return <span className="flex size-6 shrink-0 items-center justify-center">{children}</span>;
}

export function WorkspaceSwitcher({
  accountItems,
  status,
}: {
  accountItems?: ReactNode;
  status?: ReactNode;
}) {
  const host = useWorkspaceHost();
  const { Link } = host;
  const { workspace: loadedWorkspace, workspaces, canJoin, user, trash } = useShellData();
  const { openTrash } = useTreeActions();
  const [currentWorkspace, showWorkspace] = useOptimistic(loadedWorkspace);
  const [createOpen, setCreateOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const canSwitch = workspaces.length > 1;
  const switchTo = (workspace: Workspace) =>
    startTransition(async () => {
      showWorkspace(workspace);
      try {
        if (host.switchWorkspace) await host.switchWorkspace(workspace.id);
        else await host.client.workspaces.switchActive(workspace.id);
        host.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Couldn’t switch workspace.');
      }
    });
  return (
    <>
      <DropdownMenu size="sm">
        <DropdownMenuTrigger
          render={
            <SidebarMenuButton
              className="data-popup-open:bg-gray-alpha-100 group-data-[collapsible=icon]:ps-1!"
              tooltip={currentWorkspace.name}
              data-testid="workspace-switcher"
              data-switchable={canSwitch}
              aria-busy={pending || undefined}
            />
          }
        >
          <WorkspaceAvatar workspace={currentWorkspace} className="size-4" />
          <span className="min-w-0 flex-1 truncate group-data-[collapsible=icon]:sr-only">
            {currentWorkspace.name}
          </span>
          <IconChevronDown className="ms-auto text-gray-900 group-data-[collapsible=icon]:hidden" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-64">
          <div className="flex items-start gap-2 px-2 py-2">
            <Avatar size="sm" className="rounded-md after:rounded-md">
              <AvatarImage src={user.image ?? undefined} alt="" className="rounded-md" />
              <AvatarFallback className="rounded-md bg-gray-200 text-label-12 text-gray-1000">
                {(user.name || user.email).slice(0, 1).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-copy-14 text-gray-1000">
                <strong>
                  {user.name && user.name !== user.email ? user.name : user.email.split('@')[0]}
                </strong>
              </p>
              <p className="truncate text-label-12 text-gray-900">{user.email}</p>
            </div>
          </div>
          <DropdownMenuGroup>
            <DropdownMenuItem nativeButton={false} render={<Link route={{ view: 'settings' }} />}>
              <MenuIcon>
                <IconSettings />
              </MenuIcon>
              <span>Settings</span>
              <Kbd className="ms-auto">⌘,</Kbd>
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup data-testid={canSwitch ? 'workspace-list' : undefined}>
            {canSwitch && (
              <>
                <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
                {workspaces.map((workspace) => (
                  <DropdownMenuItem
                    key={workspace.id}
                    data-testid="workspace-option"
                    onClick={() => {
                      if (workspace.id !== currentWorkspace.id) switchTo(workspace);
                    }}
                  >
                    <WorkspaceAvatar workspace={workspace} />
                    <span className="min-w-0 truncate">{workspace.name}</span>
                    {workspace.id === currentWorkspace.id && <IconCheck className="ms-auto" />}
                  </DropdownMenuItem>
                ))}
              </>
            )}
            <DropdownMenuItem onClick={() => setCreateOpen(true)}>
              <MenuIcon>
                <IconPlus />
              </MenuIcon>
              <span>Create workspace</span>
            </DropdownMenuItem>
            {canJoin && (
              <DropdownMenuItem
                nativeButton={false}
                render={<Link route={{ view: 'join' }} data-testid="join-workspace" />}
              >
                <MenuIcon>
                  <IconDoorEnter />
                </MenuIcon>
                <span>Join a workspace</span>
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Library</DropdownMenuLabel>
            <DropdownMenuItem
              nativeButton={false}
              render={<Link route={{ view: 'tasks' }} data-testid="nav-tasks" />}
            >
              <MenuIcon>
                <IconChecklist />
              </MenuIcon>
              <span>Tasks</span>
            </DropdownMenuItem>
            <DropdownMenuItem nativeButton={false} render={<Link route={{ view: 'templates' }} />}>
              <MenuIcon>
                <IconLayoutGrid />
              </MenuIcon>
              <span>Templates</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={openTrash}
              data-testid="open-trash"
              aria-label={trash.length ? `Trash (${trash.length})` : 'Trash'}
            >
              <MenuIcon>
                <IconTrash />
              </MenuIcon>
              <span>Trash</span>
              {trash.length > 0 && (
                <span className="ms-auto text-label-12 text-gray-900">{trash.length}</span>
              )}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          {status && (
            <>
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5">{status}</div>
            </>
          )}
          {accountItems}
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}

export function AppSidebar({
  primaryAction,
  beforeTree,
  footerExtra,
  accountItems,
  onSearch,
  headerClassName,
  headerRowClassName,
}: {
  primaryAction?: ReactNode;
  beforeTree?: ReactNode;
  footerExtra?: ReactNode;
  accountItems?: ReactNode;
  onSearch?: () => void;
  headerClassName?: string;
  headerRowClassName?: string;
}) {
  const host = useWorkspaceHost();
  const { Link } = host;
  const { workspace } = useShellData();
  const { saving } = useOptimisticTree();
  return (
    <Sidebar
      collapsible="icon"
      data-testid="app-sidebar"
      data-workspace-id={workspace.id}
      data-saving={saving || undefined}
    >
      <SidebarHeader className={cn('gap-3 px-2 pt-2', headerClassName)}>
        <div className={cn('flex h-8 items-center gap-2', headerRowClassName)}>
          <SidebarTrigger data-testid="sidebar-header-trigger" />
          <Link
            route={{ view: 'home' }}
            className="text-button-14 text-gray-1000 hover:underline group-data-[collapsible=icon]:hidden"
          >
            Oat
          </Link>
        </div>
        <SidebarMenu className="gap-0.5">
          {primaryAction}
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Search · ⌘K"
              onClick={() => (onSearch ? onSearch() : host.navigate({ view: 'search' }))}
            >
              <IconSearch />
              <span>Search</span>
            </SidebarMenuButton>
            <SidebarMenuBadge>
              <Kbd>⌘K</Kbd>
            </SidebarMenuBadge>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="gap-0">
        {beforeTree}
        <TreeSection area="private" />
        <TreeSection area="shared" />
        <ChatsSection key={workspace.id} />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <WorkspaceSwitcher accountItems={accountItems} status={footerExtra} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
