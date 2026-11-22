import type { DesktopUser, InvokeResponse } from '@oat/core/bridge';
import type { SharedSettingsSection } from '@oat/settings-ui';
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@oat/ui/components/dropdown-menu';
import {
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuBadge,
} from '@oat/ui/components/sidebar';
import { Kbd } from '@oat/ui/components/kbd';
import {
  IconSettings,
  IconAppWindow,
  IconRefresh,
  IconLogout,
  IconSearch,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { WorkspaceSwitcher } from '../workspaces/workspace-switcher.tsx';
import type { WorkspacesView } from '../workspaces/workspaces-state.ts';
import { call } from '../bridge.ts';
import { FeatureSearch, type DesktopSearchActions } from './feature-search.tsx';
import { useRecordingAction } from '../recording/recording-controls.tsx';

export function DesktopSearch({
  onHome,
  onSettings,
  onNewMeeting,
  canStart,
}: DesktopSearchActions) {
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
        <SidebarMenuButton tooltip="Search · ⌘K" onClick={() => setOpen(true)}>
          <IconSearch aria-hidden />
          <span>Search</span>
        </SidebarMenuButton>
        <SidebarMenuBadge>
          <Kbd>⌘K</Kbd>
        </SidebarMenuBadge>
      </SidebarMenuItem>
      <FeatureSearch
        open={open}
        onOpenChange={setOpen}
        onHome={onHome}
        onSettings={onSettings}
        onNewMeeting={onNewMeeting}
        canStart={canStart}
      />
    </>
  );
}

export function DesktopUserMenu({
  user,
  onOpenSettings,
  workspaces,
}: {
  user: DesktopUser;
  workspaces: WorkspacesView;
  onOpenSettings: (section?: SharedSettingsSection) => void;
}) {
  const action = useRecordingAction();
  const [me, setMe] = useState<InvokeResponse<'api:me'> | null>(null);
  const label = user.name || user.email;
  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <WorkspaceSwitcher
            view={workspaces}
            label={label}
            email={user.email}
            onOpenSettings={onOpenSettings}
            account={
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Account</DropdownMenuLabel>
                  <DropdownMenuLabel>
                    <span className="block">{label}</span>
                    <span className="block text-label-12 text-gray-900">{user.email}</span>
                  </DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => onOpenSettings()}>
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
              </>
            }
          />
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
