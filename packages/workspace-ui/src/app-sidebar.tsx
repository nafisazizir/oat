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
} from '@oat/ui/components/sidebar';
import {
  IconCheck,
  IconChecklist,
  IconDoorEnter,
  IconHome,
  IconLayoutGrid,
  IconLogout,
  IconPlus,
  IconSearch,
  IconSelector,
  IconSettings,
  IconSparkles,
  IconTrash,
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
import { Button } from '@oat/ui/components/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@oat/ui/components/tooltip';

function WorkspaceTile({ workspace, className }: { workspace: Workspace; className?: string }) {
  return <WorkspaceAvatar workspace={workspace} {...(className ? { className } : {})} />;
}

function memberLabel(workspace: Workspace) {
  return workspace.members === 1 ? '1 member' : `${workspace.members} members`;
}

export function WorkspaceSwitcher({ accountItems }: { accountItems?: React.ReactNode }) {
  const host = useWorkspaceHost();
  const { Link } = host;
  const { workspace: loadedWorkspace, workspaces, canJoin } = useShellData();
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
        if (host.switchWorkspace) await host.switchWorkspace(workspace.id);
        else await host.client.workspaces.switchActive(workspace.id);
        host.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Couldn’t switch workspace.');
      }
    });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuButton
              size="lg"
              className="data-popup-open:bg-gray-alpha-100 group-data-[collapsible=icon]:ps-1!"
              tooltip={currentWorkspace.name}
              data-testid="workspace-switcher"
              data-switchable={canSwitch}
              aria-busy={pending || undefined}
            />
          }
        >
          <WorkspaceTile workspace={currentWorkspace} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-button-14 text-gray-1000">{currentWorkspace.name}</span>
            <span className="truncate text-label-12 text-gray-900">
              {memberLabel(currentWorkspace)}
            </span>
          </div>
          {canSwitch && <IconSelector className="ms-auto text-gray-900" />}
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-(--anchor-width) min-w-56">
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
            {!canSwitch && <DropdownMenuLabel>Workspace</DropdownMenuLabel>}
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
                Leave {currentWorkspace.name}
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
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
  top,
  primaryAction,
  beforeTree,
  footerExtra,
  accountItems,
  onSearch,
}: {
  top?: React.ReactNode;
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

  return (
    <Sidebar
      collapsible="icon"
      data-testid="app-sidebar"
      data-workspace-id={workspace.id}
      // Sidebar changes show before the server confirms them; e2e waits for this before navigating.
      data-saving={saving || undefined}
    >
      {top}
      <SidebarHeader>
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

      <SidebarContent>
        {beforeTree}
        {/* D-36: the two places a note can be. New notes start in Private. */}
        <TreeSection area="private" />
        <TreeSection area="shared" />
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col">
          <Tooltip>
            <TooltipTrigger
              role="link"
              render={
                <Button
                  nativeButton={false}
                  role="link"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Templates"
                  render={<Link route={routeOf(sections.templates.href)} />}
                />
              }
            >
              <IconLayoutGrid />
            </TooltipTrigger>
            <TooltipContent>Templates</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="relative"
                  aria-label={trash.length ? `Trash (${trash.length})` : 'Trash'}
                  onClick={openTrash}
                  data-testid="open-trash"
                />
              }
            >
              <IconTrash />
              {trash.length > 0 && (
                <span
                  aria-hidden
                  className="absolute end-1 top-1 size-1.5 rounded-full bg-brand-900"
                />
              )}
            </TooltipTrigger>
            <TooltipContent>Trash{trash.length > 0 ? ` (${trash.length})` : ''}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              role="link"
              render={
                <Button
                  nativeButton={false}
                  role="link"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Settings"
                  render={<Link route={routeOf(sections.settings.href)} />}
                />
              }
            >
              <IconSettings />
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
          {footerExtra}
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <WorkspaceSwitcher accountItems={accountItems} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
