'use client';

import { useState, type ComponentType } from 'react';
import { Avatar, AvatarFallback } from '@oat/ui/components/avatar';
import { Button } from '@oat/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
  SidebarTrigger,
} from '@oat/ui/components/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@oat/ui/components/tooltip';
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconChecklist,
  IconFileText,
  IconFolder,
  IconLayoutGrid,
  IconLogout,
  IconMessageCircle,
  IconPalette,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconTrash,
  IconUser,
  IconUserPlus,
} from '@tabler/icons-react';

import { useTheme } from '@/components/theme-provider';

type Variant = 'a' | 'b' | 'c' | 'd';
type Icon = ComponentType<{ className?: string }>;
const variants: Record<Variant, string> = {
  a: 'Minimal',
  b: 'Chat as section, tasks kept',
  c: 'Ultra',
  d: 'Ask-first',
};
const chats = ['Q3 planning recap', 'Summarise standups', 'Draft follow-up email'];
const utilities: [string, Icon][] = [
  ['Templates', IconLayoutGrid],
  ['Tasks', IconChecklist],
  ['Trash', IconTrash],
];

function IconAction({
  label,
  icon: Icon,
  onClick,
}: {
  label: string;
  icon: Icon;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} />}
      >
        <Icon className="size-4" />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function SidebarLab({ initialVariant }: { initialVariant: Variant }) {
  const [variant, setVariant] = useState(initialVariant);
  const [active, setActive] = useState('Home');
  const [workspace, setWorkspace] = useState('Acme');
  const [folderOpen, setFolderOpen] = useState(true);
  const { theme, setTheme } = useTheme();
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
            {variant === 'c' && (
              <div className="ms-auto flex group-data-[collapsible=icon]:hidden">
                <IconAction label="Search" icon={IconSearch} onClick={() => select('Search')} />
                <IconAction
                  label="New note"
                  icon={IconPlus}
                  onClick={() => select('Untitled note')}
                />
              </div>
            )}
          </div>
          {variant === 'c' && (
            <SidebarMenu className="hidden gap-0.5 group-data-[collapsible=icon]:flex">
              {row('Search', IconSearch)}
              {row('New note', IconPlus)}
            </SidebarMenu>
          )}
          {variant !== 'c' && (
            <SidebarMenu className="gap-0.5">
              {row('New note', IconPlus)}
              {row('Search', IconSearch)}
              {variant === 'b' && row('Tasks', IconChecklist)}
              {variant === 'd' && (
                <>
                  {row('Ask Oat', IconSparkles)}
                  {chats.map((chat) => row(chat, IconMessageCircle, true))}
                  {row('All chats', IconChevronRight, true)}
                </>
              )}
            </SidebarMenu>
          )}
        </SidebarHeader>
        <SidebarContent
          className={
            variant === 'b'
              ? 'gap-0 [&_[data-slot=sidebar-group]]:py-1 [&_[data-slot=sidebar-group-label]]:h-6'
              : 'gap-0'
          }
        >
          <SidebarGroup>
            <SidebarGroupLabel>Private</SidebarGroupLabel>
            <SidebarMenu className="gap-0.5">
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
            </SidebarMenu>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>Shared</SidebarGroupLabel>
            <SidebarMenu className="gap-0.5">
              {['Team standup', 'Q3 roadmap', 'Design review'].map((note) =>
                row(note, IconFileText),
              )}
            </SidebarMenu>
          </SidebarGroup>
          {variant !== 'd' && (
            <SidebarGroup className="group/chats">
              <SidebarGroupLabel>Chats</SidebarGroupLabel>
              <SidebarGroupAction
                aria-label="New chat"
                onClick={() => select('New chat')}
                className="opacity-0 group-hover/chats:opacity-100 focus-visible:opacity-100"
              >
                <IconPlus />
              </SidebarGroupAction>
              <SidebarMenu className="gap-0.5">
                {chats.map((chat) => row(chat, IconMessageCircle))}
                {row('View all', IconChevronRight)}
              </SidebarMenu>
            </SidebarGroup>
          )}
          {variant === 'b' && (
            <div className="mt-auto shrink-0 p-2 text-gray-900">
              <SidebarMenu className="gap-0.5">
                {row('Templates', IconLayoutGrid)}
                {row('Trash', IconTrash)}
              </SidebarMenu>
            </div>
          )}
        </SidebarContent>
        <SidebarFooter>
          {variant === 'c' && (
            <div className="flex gap-1 text-gray-900 group-data-[collapsible=icon]:flex-col">
              {utilities.map(([label, Icon]) => (
                <IconAction key={label} label={label} icon={Icon} onClick={() => select(label)} />
              ))}
            </div>
          )}
          <SidebarMenu>
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
                  <Avatar className="size-4 rounded-sm">
                    <AvatarFallback className="rounded-sm text-label-12">
                      {workspace[0]}
                    </AvatarFallback>
                  </Avatar>
                  <span className="flex-1 group-data-[collapsible=icon]:hidden">{workspace}</span>
                  <IconChevronDown className="ms-auto group-data-[collapsible=icon]:hidden" />
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className="w-64">
                  <div className="px-2 py-2">
                    <p className="text-copy-14 font-medium text-gray-1000">Nafis Riza</p>
                    <p className="text-label-12 text-gray-900">nafis@example.com</p>
                  </div>
                  <DropdownMenuGroup>
                    {library([
                      ['Profile', IconUser],
                      ['Settings', IconSettings],
                    ])}
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
                    {['Acme', 'Personal'].map((name) => (
                      <DropdownMenuItem key={name} onClick={() => setWorkspace(name)}>
                        <Avatar className="size-5 rounded-sm">
                          <AvatarFallback className="rounded-sm text-label-12">
                            {name[0]}
                          </AvatarFallback>
                        </Avatar>
                        {name}
                        {workspace === name && <IconCheck className="ms-auto" />}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    {library([
                      ['Workspace settings', IconSettings],
                      ['Invite members', IconUserPlus],
                      ['Create workspace', IconPlus],
                    ])}
                  </DropdownMenuGroup>
                  {(variant === 'a' || variant === 'd') && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>Library</DropdownMenuLabel>
                        {library(utilities.filter(([name]) => variant !== 'd' || name !== 'Tasks'))}
                      </DropdownMenuGroup>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <IconPalette />
                      Theme
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuRadioGroup
                        value={theme}
                        onValueChange={(value) => setTheme(value as 'light' | 'dark' | 'system')}
                      >
                        {['light', 'dark', 'system'].map((value) => (
                          <DropdownMenuRadioItem key={value} value={value}>
                            {value[0]!.toUpperCase() + value.slice(1)}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
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
          aria-label="Sidebar variant"
        >
          {(Object.keys(variants) as Variant[]).map((key) => (
            <Button
              key={key}
              size="sm"
              variant={variant === key ? 'secondary' : 'ghost'}
              aria-pressed={variant === key}
              title={variants[key]}
              onClick={() => {
                setVariant(key);
                const url = new URL(window.location.href);
                url.searchParams.set('v', key);
                window.history.replaceState(null, '', url);
              }}
            >
              {key.toUpperCase()}
            </Button>
          ))}
        </div>
        <div className="mx-auto max-w-2xl px-8 pt-36">
          <p className="mb-3 text-label-12 text-gray-900">
            SIDEBAR LAB / {variant.toUpperCase()} · {variants[variant]}
          </p>
          <h1 className="mb-8 text-heading-32 text-gray-1000">{active}</h1>
          <div className="space-y-3" aria-hidden="true">
            {['w-full', 'w-5/6', 'w-2/3', 'w-4/5'].map((width) => (
              <div key={width} className={`h-3 rounded bg-gray-alpha-100 ${width}`} />
            ))}
          </div>
          <p className="mt-10 text-label-12 text-gray-900">
            {variant === 'd' ? 'Tasks live on Home' : 'Mock workspace · Nothing here is saved'}
          </p>
        </div>
      </main>
    </SidebarProvider>
  );
}
