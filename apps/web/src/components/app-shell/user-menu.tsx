'use client';

import {
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@oat/ui/components/dropdown-menu';
import Link from 'next/link';

import { IconLogout, IconUser, IconSettings } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { authClient } from '@/lib/auth-client';
import { browserRecording } from '@/lib/browser-recording';
import { useShellData } from '@oat/workspace-ui/shell-data';

export function AccountMenuItems() {
  const { user } = useShellData();
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
        <DropdownMenuLabel>Account</DropdownMenuLabel>
        <DropdownMenuLabel>
          <span className="block truncate">{user.name}</span>
          <span className="block truncate text-label-12 text-gray-900">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuItem nativeButton={false} render={<Link href="/settings/profile" />}>
          <IconUser />
          Profile
        </DropdownMenuItem>
        <DropdownMenuItem nativeButton={false} render={<Link href="/settings" />}>
          <IconSettings />
          Preferences
        </DropdownMenuItem>
        <DropdownMenuItem disabled={pending} onClick={signOut}>
          <IconLogout />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuGroup>
    </>
  );
}
