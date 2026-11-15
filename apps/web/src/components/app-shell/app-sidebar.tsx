'use client';

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
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@oat/ui/components/sidebar';
import {
  CheckIcon,
  ChevronsUpDownIcon,
  HomeIcon,
  LayoutTemplateIcon,
  LogOutIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  Trash2Icon,
  UserPlusIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { sections } from '@/lib/navigation';
import { rootsOf, type Workspace } from '@/lib/tree';
import { switchWorkspace } from '@/server/actions/workspaces';
import { LeaveWorkspaceDialog } from '@/components/workspace/leave-workspace-dialog';
import { WorkspaceAvatar } from '@/components/workspace/workspace-avatar';

import { useCommandMenu } from './command-menu';
import { CreateWorkspaceDialog } from './create-workspace-dialog';
import { TreeSection } from './page-tree';
import { useShellData } from './shell-data';
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
  const { workspace: currentWorkspace, workspaces } = useShellData();
  const [createOpen, setCreateOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const isTeam = currentWorkspace.kind === 'team';
  const canInvite =
    isTeam && (currentWorkspace.role === 'owner' || currentWorkspace.role === 'admin');

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
          <DropdownMenuItem asChild className="gap-2">
            <Link href="/settings/workspace">
              <SettingsIcon />
              Workspace settings
            </Link>
          </DropdownMenuItem>
          {canInvite && (
            <DropdownMenuItem asChild className="gap-2">
              <Link href="/settings/workspace/members">
                <UserPlusIcon />
                Invite members
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem className="gap-2" onSelect={() => setCreateOpen(true)}>
            <PlusIcon />
            Create workspace
          </DropdownMenuItem>
          {isTeam && (
            <DropdownMenuItem className="gap-2" onSelect={() => setLeaveOpen(true)}>
              <LogOutIcon />
              Leave {currentWorkspace.name}
            </DropdownMenuItem>
          )}
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
  const { documents, workspace, trash } = useShellData();
  const { openTrash } = useTreeActions();
  // A personal workspace has nobody to share with: show "Shared" only if something is in it.
  const showShared = workspace.kind === 'team' || rootsOf(documents, 'shared').length > 0;

  return (
    <Sidebar collapsible="icon" data-testid="app-sidebar" data-workspace-id={workspace.id}>
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
        {showShared && <TreeSection area="shared" label="Shared" />}
        <TreeSection area="private" label="Private" />
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Trash" onClick={openTrash} data-testid="open-trash">
              <Trash2Icon />
              <span>Trash</span>
              {trash.length > 0 && (
                <span className="ml-auto text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                  {trash.length}
                </span>
              )}
            </SidebarMenuButton>
          </SidebarMenuItem>
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
