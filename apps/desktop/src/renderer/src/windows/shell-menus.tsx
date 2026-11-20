import type { DesktopUser, InvokeResponse, SearchHitSnapshot } from '@oat/core/bridge';
import { Avatar, AvatarFallback } from '@oat/ui/components/avatar';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@oat/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from '@oat/ui/components/dropdown-menu';
import {
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuBadge,
} from '@oat/ui/components/sidebar';
import { Kbd } from '@oat/ui/components/kbd';
import {
  IconSelector,
  IconSettings,
  IconAppWindow,
  IconRefresh,
  IconLogout,
  IconSearch,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { call } from '../bridge.ts';
import { LocalSearch } from '../sync/local-search.tsx';
import { useRecordingAction } from '../recording/recording-controls.tsx';

export function DesktopSearch({
  refreshKey,
  onOpen,
}: {
  refreshKey: number | null;
  onOpen: (hit: SearchHitSnapshot) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.key.toLowerCase() !== 'k' ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.repeat
      )
        return;
      event.preventDefault();
      setOpen((current) => !current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton tooltip="Search" onClick={() => setOpen(true)}>
          <IconSearch aria-hidden />
          <span>Search</span>
        </SidebarMenuButton>
        <SidebarMenuBadge>
          <Kbd>⌘K</Kbd>
        </SidebarMenuBadge>
      </SidebarMenuItem>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Search</DialogTitle>
            <DialogDescription>
              Notes and transcripts on this Mac, available offline.
            </DialogDescription>
          </DialogHeader>
          <LocalSearch
            refreshKey={refreshKey}
            onOpen={(hit) => {
              onOpen(hit);
              setOpen(false);
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

export function DesktopUserMenu({
  user,
  onOpenSettings,
}: {
  user: DesktopUser;
  onOpenSettings: () => void;
}) {
  const action = useRecordingAction();
  const [me, setMe] = useState<InvokeResponse<'api:me'> | null>(null);
  const label = user.name || user.email;
  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <SidebarMenuButton
                  size="lg"
                  className="data-popup-open:bg-gray-alpha-100 group-data-[collapsible=icon]:ps-1!"
                  data-testid="user-menu"
                  tooltip={label}
                />
              }
            >
              <Avatar size="sm">
                <AvatarFallback>{label.charAt(0).toUpperCase()}</AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-button-14 text-gray-1000">{label}</span>
                <span
                  className="truncate text-label-12 text-gray-900"
                  data-testid="signed-in-email"
                >
                  {user.email}
                </span>
              </div>
              <IconSelector aria-hidden className="ms-auto text-gray-900" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-(--anchor-width) min-w-56">
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={onOpenSettings}>
                  <IconSettings />
                  Settings
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={action.pending}
                  onClick={() => void action.run(() => call('window:open-widget'))}
                >
                  <IconAppWindow />
                  Show meeting widget
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={action.pending}
                  onClick={() => void action.run(async () => setMe(await call('api:me')))}
                >
                  <IconRefresh />
                  Check connection
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={action.pending}
                  onClick={() => void action.run(() => call('auth:sign-out'))}
                >
                  <IconLogout />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
      {me && !action.error && (
        <p role="status" data-testid="api-me" className="px-2 text-copy-13 text-gray-900">
          Connected as {me.user.email}
        </p>
      )}
      {action.error && (
        <p role="status" className="px-2 text-copy-13 text-red-900">
          {action.error}
        </p>
      )}
    </>
  );
}
