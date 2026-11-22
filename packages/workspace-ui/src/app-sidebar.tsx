'use client';

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
  IconHome,
  IconLayoutGrid,
  IconLogout,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconTrash,
  IconUser,
  IconUserPlus,
} from '@tabler/icons-react';
import { useWorkspaceHost } from './host';
import { useOptimistic, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { hrefOf, routeOf, inSection, sections } from './routes';
import type { Workspace } from './tree';
import { LeaveWorkspaceDialog } from './leave-workspace-dialog';
import { WorkspaceAvatar } from './workspace-avatar';

import { CreateWorkspaceDialog } from './create-workspace-dialog';
import { TreeSection } from './page-tree';
import { useOptimisticTree, useShellData } from './shell-data';
import { useTreeActions } from './tree-actions';
import { Avatar, AvatarFallback, AvatarImage } from '@oat/ui/components/avatar';
import { ThemeMenu, useTheme } from '@oat/settings-ui';

function WorkspaceTile({ workspace, className }: { workspace: Workspace; className?: string }) {
  return <WorkspaceAvatar workspace={workspace} {...(className ? { className } : {})} />;
}

function memberLabel(workspace: Workspace) {
  return workspace.members === 1 ? '1 member' : `${workspace.members} members`;
}

export function WorkspaceSwitcher({
  accountItems,
  status,
  compact = false,
}: {
  accountItems?: React.ReactNode;
  status?: React.ReactNode;
  compact?: boolean;
}) {
  const host = useWorkspaceHost();
  const { Link } = host;
  const { workspace: loadedWorkspace, workspaces, canJoin, user } = useShellData();
  // The picked workspace shows in the switcher right away; the rest of the shell follows the refresh.
  const [currentWorkspace, showWorkspace] = useOptimistic(loadedWorkspace);
  const [createOpen, setCreateOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  // D-36: with one workspace there is nothing to switch between, so the button is just "where I am" and
  // the menu has no workspace list. Settings, inviting and "Create workspace" stay in it either way.
  const canSwitch = workspaces.length > 1;
  // The last workspace can't be left, so the menu only offers it when there is another one.
  const canLeave = canSwitch;
  const canInvite = currentWorkspace.role === 'owner' || currentWorkspace.role === 'admin';

  const switchTo = (workspace: Workspace) =>
    startTransition(async () => {
      showWorkspace(workspace);
      try {
        await host.client.workspaces.switchActive(workspace.id);
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
              size="default"
              className="data-popup-open:bg-gray-alpha-100 group-data-[collapsible=icon]:ps-1!"
              tooltip={currentWorkspace.name}
              data-testid={compact ? 'workspace-switcher' : 'account-switcher'}
              data-switchable={canSwitch}
              aria-busy={pending || undefined}
            />
          }
        >
          {compact && <WorkspaceTile workspace={currentWorkspace} className="size-4" />}
          {!compact && (
            <Avatar className="size-7">
              <AvatarImage src={user.image ?? undefined} alt="" />
              <AvatarFallback className="text-label-12">
                {(user.name || user.email).slice(0, 1).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-button-14 text-gray-1000">
              {compact ? currentWorkspace.name : user.name || user.email}
            </span>
            {compact && <span className="sr-only">{memberLabel(currentWorkspace)}</span>}
          </div>
          <IconChevronDown className="ms-auto text-gray-900" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side={compact ? 'bottom' : 'top'} align="start" className="w-64">
          <div className="min-w-0 px-2 py-2">
            <p className="truncate text-copy-14 text-gray-1000">
              <strong>
                {user.name && user.name !== user.email ? user.name : user.email.split('@')[0]}
              </strong>
            </p>
            <p className="truncate text-label-12 text-gray-900">{user.email}</p>
          </div>
          <DropdownMenuGroup>
            <DropdownMenuItem
              nativeButton={false}
              render={<Link route={routeOf('/settings/profile')} />}
            >
              <IconUser />
              Profile
            </DropdownMenuItem>
            <DropdownMenuItem nativeButton={false} render={<Link route={routeOf('/settings')} />}>
              <IconSettings />
              Settings
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          {canSwitch && (
            <>
              <DropdownMenuGroup data-testid="workspace-list">
                <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
                {workspaces.map((workspace) => (
                  <DropdownMenuItem
                    key={workspace.id}
                    data-testid="workspace-option"
                    onClick={() => {
                      if (workspace.id !== currentWorkspace.id) switchTo(workspace);
                    }}
                  >
                    <WorkspaceTile workspace={workspace} className="size-5" />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate">{workspace.name}</span>
                      <span className="truncate text-label-12 text-gray-900">
                        {memberLabel(workspace)}
                      </span>
                    </div>
                    {workspace.id === currentWorkspace.id && <IconCheck className="ms-auto" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuGroup>
            <DropdownMenuLabel>Workspace</DropdownMenuLabel>
            <DropdownMenuItem
              nativeButton={false}
              render={<Link route={routeOf('/settings/workspace')} />}
            >
              <IconSettings />
              Workspace settings
            </DropdownMenuItem>
            {canInvite && (
              <DropdownMenuItem
                nativeButton={false}
                render={<Link route={routeOf('/settings/workspace/members')} />}
              >
                <IconUserPlus />
                Invite members
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => setCreateOpen(true)}>
              <IconPlus />
              Create workspace
            </DropdownMenuItem>
            {canJoin && (
              // Only while something is open to me: an invitation, or a workspace on my email domain.
              <DropdownMenuItem
                nativeButton={false}
                render={<Link route={routeOf('/join')} data-testid="join-workspace" />}
              >
                <IconDoorEnter />
                Join a workspace
              </DropdownMenuItem>
            )}
            {canLeave && (
              <DropdownMenuItem onClick={() => setLeaveOpen(true)}>
                <IconLogout />
                <span className="truncate">Leave {currentWorkspace.name}</span>
              </DropdownMenuItem>
            )}
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
      {canLeave && (
        <LeaveWorkspaceDialog
          workspace={currentWorkspace}
          open={leaveOpen}
          onOpenChange={setLeaveOpen}
        />
      )}
    </>
  );
}

export function AppSidebar({
  primaryAction,
  beforeTree,
  footerExtra,
  accountItems,
  onSearch,
}: {
  primaryAction?: React.ReactNode;
  beforeTree?: React.ReactNode;
  footerExtra?: React.ReactNode;
  accountItems?: React.ReactNode;
  onSearch?: () => void;
}) {
  const host = useWorkspaceHost();
  const { Link } = host;
  const pathname = hrefOf(host.route).split('?')[0]!;
  const { workspace, trash } = useShellData();
  const { openTrash } = useTreeActions();
  const { saving } = useOptimisticTree();
  const { theme, setTheme } = useTheme();

  return (
    <Sidebar
      collapsible="icon"
      data-testid="app-sidebar"
      data-workspace-id={workspace.id}
      // Sidebar changes show before the server confirms them; e2e waits for this before navigating.
      data-saving={saving || undefined}
    >
      <SidebarHeader className="gap-3 px-2 pt-2">
        <div className="flex h-8 items-center gap-2">
          <SidebarTrigger data-testid="sidebar-header-trigger" />
          <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
            <WorkspaceSwitcher compact accountItems={accountItems} status={footerExtra} />
          </div>
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
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link route={routeOf(sections.home.href)} />}
              isActive={pathname === sections.home.href}
              tooltip={sections.home.label}
            >
              <IconHome />
              <span>{sections.home.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link route={routeOf(sections.tasks.href)} data-testid="nav-tasks" />}
              isActive={pathname === sections.tasks.href}
              tooltip={sections.tasks.label}
            >
              <IconChecklist />
              <span>{sections.tasks.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link route={routeOf(sections.assistant.href)} data-testid="nav-assistant" />}
              isActive={inSection(pathname, sections.assistant.href)}
              tooltip={sections.assistant.label}
            >
              <IconSparkles />
              <span>{sections.assistant.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="gap-0">
        {beforeTree}
        {/* D-36: the two places a note can be. New notes start in Private. */}
        <TreeSection area="private" />
        <TreeSection area="shared" />
        <div className="mt-auto p-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link route={routeOf(sections.templates.href)} />}
                tooltip="Templates"
                isActive={inSection(pathname, sections.templates.href)}
              >
                <IconLayoutGrid />
                <span>Templates</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Trash"
                aria-label={trash.length ? `Trash (${trash.length})` : 'Trash'}
                onClick={openTrash}
                data-testid="open-trash"
              >
                <IconTrash />
                <span>Trash</span>
                {trash.length > 0 && (
                  <span className="ms-auto text-label-12 text-gray-900">{trash.length}</span>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </div>
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center gap-1 border-t border-gray-alpha-400 pt-2 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:items-start">
          <SidebarMenu className="min-w-0 flex-1">
            <SidebarMenuItem>
              <WorkspaceSwitcher accountItems={accountItems} status={footerExtra} />
            </SidebarMenuItem>
          </SidebarMenu>
          <ThemeMenu theme={theme} setTheme={setTheme} />
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
