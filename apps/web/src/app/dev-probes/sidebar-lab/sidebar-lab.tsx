'use client';

import { useState, type ComponentType, type ReactNode } from 'react';
import { WorkspaceAvatar } from '@oat/settings-ui';
import { Button } from '@oat/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@oat/ui/components/dropdown-menu';
import { Kbd } from '@oat/ui/components/kbd';
import {
  Sidebar,
  SidebarProvider,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuBadge,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarTrigger,
} from '@oat/ui/components/sidebar';
import {
  IconCheck,
  IconArrowRight,
  IconDots,
  IconChevronDown,
  IconChevronRight,
  IconChecklist,
  IconFileText,
  IconFilePlus,
  IconFolder,
  IconFolderPlus,
  IconLayoutGrid,
  IconList,
  IconLogout,
  IconMessageCircle,
  IconMessages,
  IconPlus,
  IconSearch,
  IconSettings,
  IconTrash,
} from '@tabler/icons-react';

type ViewAllIcon = 'none' | 'dots' | 'arrow' | 'list' | 'bubbles';
type Icon = ComponentType<{ className?: string }>;
const viewAllIcons: Record<ViewAllIcon, Icon | null> = {
  none: null,
  dots: IconDots,
  arrow: IconArrowRight,
  list: IconList,
  bubbles: IconMessages,
};
const chats = ['Q3 planning recap', 'Summarise standups', 'Draft follow-up email'];
const utilities: [string, Icon][] = [
  ['Tasks', IconChecklist],
  ['Templates', IconLayoutGrid],
  ['Trash', IconTrash],
];

function LabGroup({
  label,
  open,
  onToggle,
  onAdd,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  onAdd: (view: string) => void;
  children: ReactNode;
}) {
  const notes = label === 'Private' || label === 'Shared';
  const actionClass =
    'opacity-0 group-hover/tree-section:opacity-100 group-focus-within/tree-section:opacity-100 data-popup-open:opacity-100';
  return (
    <SidebarGroup className="group/tree-section py-1">
      <SidebarGroupLabel render={<button type="button" aria-expanded={open} onClick={onToggle} />}>
        {label}
        <IconChevronRight className={`ms-1 size-3.5 ${open ? 'rotate-90' : ''}`} />
      </SidebarGroupLabel>
      {notes ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarGroupAction
                className={actionClass}
                title={`Add to ${label}`}
                aria-label={`Add to ${label}`}
              />
            }
          >
            <IconPlus />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start">
            <DropdownMenuItem onClick={() => onAdd(`New ${label.toLowerCase()} note`)}>
              <IconFilePlus />
              New page
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAdd(`New ${label.toLowerCase()} folder`)}>
              <IconFolderPlus />
              New folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <SidebarGroupAction
          className={actionClass}
          title="New chat"
          aria-label="New chat"
          onClick={() => onAdd('New chat')}
        >
          <IconPlus />
        </SidebarGroupAction>
      )}
      {open && (
        <SidebarGroupContent>
          <SidebarMenu className="gap-0.5">{children}</SidebarMenu>
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  );
}

export function SidebarLab({ initialIcon }: { initialIcon: ViewAllIcon }) {
  const [viewAllIcon, setViewAllIcon] = useState(initialIcon);
  const ViewAllGlyph = viewAllIcons[viewAllIcon];
  const [active, setActive] = useState('Home');
  const [workspace, setWorkspace] = useState('Acme');
  const [folderOpen, setFolderOpen] = useState(true);
  const [groups, setGroups] = useState({
    Private: true,
    Shared: true,
    Chats: true,
  });
  const toggleGroup = (label: keyof typeof groups) =>
    setGroups((previous) => ({ ...previous, [label]: !previous[label] }));
  const select = (view: string) => setActive(view);
  const row = (label: string, Icon: Icon, nested = false) => (
    <SidebarMenuItem
      key={label}
      className={nested ? 'ps-5 group-data-[collapsible=icon]:hidden' : undefined}
    >
      <SidebarMenuButton tooltip={label} isActive={active === label} onClick={() => select(label)}>
        <Icon />
        <span>{label}</span>
        {label === 'Search' && (
          <SidebarMenuBadge>
            <Kbd>⌘K</Kbd>
          </SidebarMenuBadge>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
  const library = (items: [string, Icon][]) =>
    items.map(([label, Icon]) => (
      <DropdownMenuItem key={label} onClick={() => select(label)}>
        <Icon />
        {label}
      </DropdownMenuItem>
    ));

  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <Sidebar collapsible="icon">
        <SidebarHeader className="gap-3 px-2 pt-2">
          <div className="flex h-8 items-center gap-2">
            <SidebarTrigger />
            <button
              onClick={() => select('Home')}
              className="text-button-14 font-medium text-gray-1000 hover:underline group-data-[collapsible=icon]:hidden"
            >
              Oat
            </button>
          </div>
          <SidebarMenu className="gap-0.5">
            {row('New note', IconPlus)}
            {row('Search', IconSearch)}
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent className="gap-0 [&_[data-slot=sidebar-group-label]]:h-6">
          <LabGroup
            label="Private"
            open={groups.Private}
            onToggle={() => toggleGroup('Private')}
            onAdd={select}
          >
            {row('Weekly reflections', IconFileText)}
            {row('Product ideas', IconFileText)}
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Projects"
                aria-expanded={folderOpen}
                onClick={() => {
                  setFolderOpen(!folderOpen);
                  select('Projects');
                }}
                isActive={active === 'Projects'}
              >
                <IconFolder />
                <span>Projects</span>
                {folderOpen ? (
                  <IconChevronDown className="ms-auto" />
                ) : (
                  <IconChevronRight className="ms-auto" />
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
            {folderOpen && (
              <>
                {row('Website refresh', IconFileText, true)}
                {row('Launch checklist', IconFileText, true)}
              </>
            )}
          </LabGroup>
          <LabGroup
            label="Shared"
            open={groups.Shared}
            onToggle={() => toggleGroup('Shared')}
            onAdd={select}
          >
            {['Team standup', 'Q3 roadmap', 'Design review'].map((note) => row(note, IconFileText))}
          </LabGroup>
          <LabGroup
            label="Chats"
            open={groups.Chats}
            onToggle={() => toggleGroup('Chats')}
            onAdd={select}
          >
            {chats.map((chat) => row(chat, IconMessageCircle))}
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="View all"
                isActive={active === 'All chats'}
                onClick={() => select('All chats')}
                className="text-gray-900"
              >
                {ViewAllGlyph ? (
                  <ViewAllGlyph />
                ) : (
                  <span aria-hidden="true" className="size-4 shrink-0" />
                )}
                <span>View all</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </LabGroup>
        </SidebarContent>
        <SidebarFooter className="flex-row items-center group-data-[collapsible=icon]:flex-col">
          <SidebarMenu className="min-w-0 flex-1">
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuButton
                      tooltip={workspace}
                      aria-label="Switch workspace"
                      className="data-popup-open:bg-gray-alpha-100"
                    />
                  }
                >
                  <WorkspaceAvatar workspace={{ name: workspace }} className="size-4" />
                  <span className="flex-1 group-data-[collapsible=icon]:hidden">{workspace}</span>
                  <IconChevronDown className="ms-auto group-data-[collapsible=icon]:hidden" />
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className="w-64">
                  <div className="px-2 py-2">
                    <p className="text-copy-14 font-medium text-gray-1000">Nafis Riza</p>
                    <p className="text-label-12 text-gray-900">nafis@example.com</p>
                  </div>
                  <DropdownMenuGroup>
                    <DropdownMenuItem onClick={() => select('Settings')}>
                      <IconSettings />
                      Settings
                      <Kbd className="ms-auto">⌘,</Kbd>
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
                    {['Acme', 'Personal'].map((name) => (
                      <DropdownMenuItem key={name} onClick={() => setWorkspace(name)}>
                        <WorkspaceAvatar workspace={{ name }} className="size-5" />
                        {name}
                        {workspace === name && <IconCheck className="ms-auto" />}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuItem onClick={() => select('Create workspace')}>
                      <IconPlus />
                      Create workspace
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Library</DropdownMenuLabel>
                    {library(utilities)}
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => select('Signed out (prototype)')}>
                    <IconLogout />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <main className="relative min-w-0 flex-1 overflow-auto bg-background-100">
        <div
          className="absolute end-6 top-5 flex gap-1 rounded-lg border border-gray-alpha-400 bg-background-100 p-1"
          role="group"
          aria-label="View all icon"
        >
          <span className="self-center px-2 text-label-12 text-gray-900">View all icon</span>
          {(Object.keys(viewAllIcons) as ViewAllIcon[]).map((key) => (
            <Button
              key={key}
              size="sm"
              variant={viewAllIcon === key ? 'secondary' : 'ghost'}
              aria-pressed={viewAllIcon === key}
              onClick={() => {
                setViewAllIcon(key);
                const url = new URL(window.location.href);
                url.searchParams.delete('v');
                url.searchParams.set('icon', key);
                window.history.replaceState(null, '', url);
              }}
            >
              {key}
            </Button>
          ))}
        </div>
        <div className="mx-auto max-w-2xl px-8 pt-36">
          <p className="mb-3 text-label-12 text-gray-900">SIDEBAR LAB / Refined B1</p>
          <h1 className="mb-8 text-heading-32 text-gray-1000">{active}</h1>
          <div className="space-y-3" aria-hidden="true">
            {['w-full', 'w-5/6', 'w-2/3', 'w-4/5'].map((width) => (
              <div key={width} className={`h-3 rounded bg-gray-alpha-100 ${width}`} />
            ))}
          </div>
          <p className="mt-10 text-label-12 text-gray-900">
            Mock workspace · Nothing here is saved
          </p>
        </div>
      </main>
    </SidebarProvider>
  );
}
