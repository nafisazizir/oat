import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@oat/ui/components/dropdown-menu';
import { IconAppWindow, IconLogout } from '@tabler/icons-react';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { call } from '../bridge';
import { useRecordingAction } from '../recording/recording-controls';

export function useDesktopAccountItems() {
  const action = useRecordingAction();
  useEffect(() => {
    if (action.error) toast.error(action.error);
  }, [action.error]);
  return {
    items: (
      <>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            disabled={action.pending}
            onClick={() => void action.run(() => call('window:open-widget'))}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              <IconAppWindow />
            </span>
            Show meeting widget
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            disabled={action.pending}
            onClick={() => void action.run(() => call('auth:sign-out'))}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              <IconLogout />
            </span>
            Sign out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </>
    ),
    feedback: action.error && (
      <p role="status" className="text-copy-13 text-red-900">
        {action.error}
      </p>
    ),
  };
}
