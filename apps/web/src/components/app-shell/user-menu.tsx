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
import { ChevronsUpDownIcon, LogOutIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { authClient } from '@/lib/auth-client';

import { useShellData } from './shell-data';

/** Account menu at the bottom of the sidebar: who is signed in, and sign out. */
export function UserMenu() {
  const { user } = useShellData();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const signOut = () =>
    startTransition(async () => {
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
            className="data-[state=open]:bg-sidebar-accent group-data-[collapsible=icon]:pl-1!"
            data-testid="user-menu"
            tooltip={user.name}
          />
        }
      >
        <Avatar size="sm">
          {user.image && <AvatarImage src={user.image} alt="" />}
          <AvatarFallback className="text-xs font-semibold">
            {user.name.charAt(0).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col gap-0.5 leading-none">
          <span className="truncate font-medium">{user.name}</span>
          <span className="truncate text-xs text-muted-foreground">{user.email}</span>
        </div>
        <ChevronsUpDownIcon className="ml-auto text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-(--anchor-width) min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="truncate">{user.name}</span>
            <span className="truncate text-xs font-normal text-muted-foreground">{user.email}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={pending} onClick={signOut}>
            <LogOutIcon />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
