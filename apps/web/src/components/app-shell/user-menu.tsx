'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@oat/ui/components/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@oat/ui/components/dropdown-menu';
import { SidebarMenuButton } from '@oat/ui/components/sidebar';
import { IconLogout, IconSelector } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { authClient } from '@/lib/auth-client';
import { browserRecording } from '@/lib/browser-recording';

import { useShellData } from './shell-data';

/** Account menu at the bottom of the sidebar: who is signed in, and sign out. */
export function UserMenu() {
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
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <SidebarMenuButton
            size="lg"
            className="data-popup-open:bg-gray-alpha-100 group-data-[collapsible=icon]:ps-1!"
            data-testid="user-menu"
            tooltip={user.name}
          />
        }
      >
        <Avatar size="sm">
          {user.image && <AvatarImage src={user.image} alt="" />}
          <AvatarFallback>{user.name.charAt(0).toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-button-14 text-gray-1000">{user.name}</span>
          <span className="truncate text-label-12 text-gray-900">{user.email}</span>
        </div>
        <IconSelector className="ms-auto text-gray-900" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-(--anchor-width) min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="truncate">{user.email}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={pending} onClick={signOut}>
            <IconLogout />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
