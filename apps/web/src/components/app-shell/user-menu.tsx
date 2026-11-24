'use client';

import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@oat/ui/components/dropdown-menu';

import { IconLogout } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { authClient } from '@/lib/auth-client';
import { browserRecording } from '@/lib/browser-recording';

export function AccountMenuItems() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const signOut = () =>
    startTransition(async () => {
      await browserRecording.endSession();
      const { error } = await authClient.signOut();
      if (error) {
        toast.error('Couldn’t sign out. Try again.');
        return;
      }
      router.replace('/sign-in');
      router.refresh();
    });
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem disabled={pending} onClick={signOut}>
          <span className="flex size-4 shrink-0 items-center justify-center">
            <IconLogout />
          </span>
          Sign out
        </DropdownMenuItem>
      </DropdownMenuGroup>
    </>
  );
}
