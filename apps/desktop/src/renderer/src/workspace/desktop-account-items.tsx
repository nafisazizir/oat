import type { DesktopUser, InvokeResponse } from '@oat/core/bridge';
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@oat/ui/components/dropdown-menu';
import { IconAppWindow, IconLogout, IconRefresh, IconSettings } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { call } from '../bridge';
import { useRecordingAction } from '../recording/recording-controls';

export function useDesktopAccountItems(user: DesktopUser, onOpenSettings: () => void) {
  const action = useRecordingAction();
  const [me, setMe] = useState<InvokeResponse<'api:me'> | null>(null);
  useEffect(() => {
    if (action.error) toast.error(action.error);
  }, [action.error]);
  return {
    items: (
      <>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Account</DropdownMenuLabel>
          <DropdownMenuLabel>
            <span className="block">{user.name || user.email}</span>
            <span className="block text-label-12 text-gray-900">{user.email}</span>
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={onOpenSettings}>
            <IconSettings />
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={action.pending}
            onClick={() => void action.run(() => call('settings:open-web', { section: 'profile' }))}
          >
            Profile (web)
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
            onClick={() =>
              void action.run(async () => {
                const result = await call('api:me');
                setMe(result);
                toast.success(`Connected as ${result.user.email}`);
              })
            }
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
    ),
    feedback: (
      <>
        {me && !action.error && (
          <p role="status" className="text-copy-13 text-gray-900" data-testid="api-me">
            Connected as {me.user.email}
          </p>
        )}
        {action.error && (
          <p role="status" className="text-copy-13 text-red-900">
            {action.error}
          </p>
        )}
      </>
    ),
  };
}
