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
  IconEdit,
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
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useOptimistic, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { inSection, sections } from '@/lib/navigation';
import { rootsOf, type Workspace } from '@/lib/tree';
import { switchWorkspace } from '@/server/actions/workspaces';
import { LeaveWorkspaceDialog } from '@/components/workspace/leave-workspace-dialog';
import { WorkspaceAvatar } from '@/components/workspace/workspace-avatar';

import { useCommandMenu } from './command-menu';
import { CreateWorkspaceDialog } from './create-workspace-dialog';
import { TreeSection } from './page-tree';
import { useOptimisticTree, useShellData } from './shell-data';
import { useTreeActions } from './tree-actions';
import { useNewNote } from './use-new-note';
import { UserMenu } from './user-menu';

function WorkspaceTile({ workspace, className }: { workspace: Workspace; className?: string }) {
  return <WorkspaceAvatar workspace={workspace} {...(className ? { className } : {})} />;
}

function memberLabel(workspace: Workspace) {
  if (workspace.kind === 'personal') return 'Personal space';
  return workspace.members === 1 ? '1 member' : `${workspace.members} members`;
}

function WorkspaceSwitcher() {
  const { workspace: loadedWorkspace, workspaces } = useShellData();
  // The picked workspace shows in the switcher right away; the rest of the shell follows the refresh.
  const [currentWorkspace, showWorkspace] = useOptimistic(loadedWorkspace);
  const [createOpen, setCreateOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const isTeam = currentWorkspace.kind === 'team';
  const canInvite =
    isTeam && (currentWorkspace.role === 'owner' || currentWorkspace.role === 'admin');

  const switchTo = (workspace: Workspace) =>
    startTransition(async () => {
      showWorkspace(workspace);
      const result = await switchWorkspace(workspace.id);
      if (!result.ok) toast.error(result.error);
    });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuButton
              size="lg"
              className="data-popup-open:bg-gray-alpha-100 group-data-[collapsible=icon]:ps-1!"
              data-testid="workspace-switcher"
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
          <IconSelector className="ms-auto text-gray-900" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-(--anchor-width) min-w-56">
          <DropdownMenuGroup>
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
            <DropdownMenuSeparator />
            <DropdownMenuItem nativeButton={false} render={<Link href="/settings/workspace" />}>
              <IconSettings />
              Workspace settings
            </DropdownMenuItem>
            {canInvite && (
              <DropdownMenuItem
                nativeButton={false}
                render={<Link href="/settings/workspace/members" />}
              >
                <IconUserPlus />
                Invite members
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => setCreateOpen(true)}>
              <IconPlus />
              Create workspace
            </DropdownMenuItem>
            {isTeam && (
              <DropdownMenuItem onClick={() => setLeaveOpen(true)}>
                <IconLogout />
                Leave {currentWorkspace.name}
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />
      {isTeam && (
        <LeaveWorkspaceDialog
          workspace={currentWorkspace}
          open={leaveOpen}
          onOpenChange={setLeaveOpen}
        />
      )}
    </>
  );
}

export function AppSidebar() {
  const pathname = usePathname();
  const { setOpen: openCommandMenu } = useCommandMenu();
  const newNote = useNewNote();
  const { documents, workspace, trash } = useShellData();
  const { openTrash } = useTreeActions();
  const { saving } = useOptimisticTree();
  // A personal workspace has nobody to share with: show "Shared" only if something is in it.
  const showShared = workspace.kind === 'team' || rootsOf(documents, 'shared').length > 0;

  return (
    <Sidebar
      collapsible="icon"
      data-testid="app-sidebar"
      data-workspace-id={workspace.id}
      // Sidebar changes show before the server confirms them; e2e waits for this before navigating.
      data-saving={saving || undefined}
    >
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
              className="text-brand-900 hover:text-brand-1000"
            >
              <IconEdit />
              <span>New note</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Search · ⌘K" onClick={() => openCommandMenu(true)}>
              <IconSearch />
              <span>Search</span>
            </SidebarMenuButton>
            <SidebarMenuBadge>
              <Kbd>⌘K</Kbd>
            </SidebarMenuBadge>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link href={sections.home.href} />}
              isActive={pathname === sections.home.href}
              tooltip={sections.home.label}
            >
              <IconHome />
              <span>{sections.home.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link href={sections.tasks.href} data-testid="nav-tasks" />}
              isActive={pathname === sections.tasks.href}
              tooltip={sections.tasks.label}
            >
              <IconChecklist />
              <span>{sections.tasks.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link href={sections.assistant.href} data-testid="nav-assistant" />}
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
        {showShared && <TreeSection area="shared" label="Shared" />}
        <TreeSection area="private" label="Private" />
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Trash" onClick={openTrash} data-testid="open-trash">
              <IconTrash />
              <span>Trash</span>
              {trash.length > 0 && (
                <span className="ms-auto text-label-12 text-gray-900 tabular-nums group-data-[collapsible=icon]:hidden">
                  {trash.length}
                </span>
              )}
            </SidebarMenuButton>
          </SidebarMenuItem>
          {[
            { ...sections.templates, Icon: IconLayoutGrid },
            { ...sections.settings, Icon: IconSettings },
          ].map(({ href, label, Icon }) => (
            <SidebarMenuItem key={href}>
              <SidebarMenuButton
                render={<Link href={href} />}
                isActive={inSection(pathname, href)}
                tooltip={label}
              >
                <Icon />
                <span>{label}</span>
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
