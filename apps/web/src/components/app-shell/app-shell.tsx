'use client';

import { DropdownMenuSeparator } from '@oat/ui/components/dropdown-menu';
import { SidebarInset, SidebarMenuItem, SidebarMenuButton } from '@oat/ui/components/sidebar';
import { IconEdit } from '@tabler/icons-react';
import { useEffect, useMemo } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { createOatClient, fetchTransport } from '@oat/client';
import {
  WorkspaceHost,
  hrefOf,
  routeOf,
  type AppRoute,
  AppSidebar,
  ShellSidebarProvider,
} from '@oat/workspace-ui';
import { authClient } from '@/lib/auth-client';
import { browserRecording } from '@/lib/browser-recording';
import { BrowserRecordingBanner } from '@/components/meeting/recording-controls';

import type { ShellData } from '@/lib/tree';

import { CommandMenu, CommandMenuProvider, useCommandMenu } from './command-menu';
import { useNewNote } from './use-new-note';
import { AccountMenuItems } from './user-menu';
import { ShellDataProvider } from '@oat/workspace-ui/shell-data';
import { TopBarProvider } from './top-bar';
import { TreeActionsProvider, useTreeActions } from '@oat/workspace-ui/tree-actions';
import { useSyncEvents } from './use-sync-events';
import { WebFeatureProvider } from './feature-provider';

function HostLink({
  route,
  ...props
}: { route: AppRoute } & Omit<React.ComponentProps<'a'>, 'href'>) {
  return <Link href={hrefOf(route) as Route} {...props} />;
}

function WebSidebar() {
  const { setOpen } = useCommandMenu();
  const newNote = useNewNote();
  const { canCreate } = useTreeActions();
  return (
    <AppSidebar
      onSearch={() => setOpen(true)}
      primaryAction={
        canCreate && (
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="New note" onClick={newNote}>
              <IconEdit />
              <span>New note</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )
      }
      footerExtra={
        // Only while live sync is down; a working connection needs no line.
        <div className="in-data-[sync-live]:hidden">
          <DropdownMenuSeparator />
          <p role="status" className="px-2 py-1 text-label-12 text-gray-900">
            Reconnecting live sync…
          </p>
        </div>
      }
      accountItems={<AccountMenuItems />}
    />
  );
}

/**
 * The signed-in app frame: collapsible sidebar + top bar + content, and the ⌘K palette.
 * - `data` is loaded on the server (`getShellData()` in `(app)/layout.tsx`); the sidebar, palette and
 *   navigation read it from context instead of importing data themselves.
 * - `defaultOpen` comes from the `sidebar_state` cookie (read on the server) so a collapsed sidebar
 *   stays collapsed across reloads without a layout shift.
 */
export function AppShell({
  data,
  defaultOpen,
  children,
}: {
  data: ShellData;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const client = useMemo(() => createOatClient(fetchTransport()), []);
  const routeHref = hrefOf(routeOf(pathname, search.toString()));
  const route = useMemo(() => {
    const url = new URL(routeHref, 'https://oat.invalid');
    return routeOf(url.pathname, url.search);
  }, [routeHref]);
  const host = useMemo<WorkspaceHost>(
    () => ({
      platform: 'web',
      appOrigin: typeof window === 'undefined' ? '' : window.location.origin,
      client,
      route,
      navigate: (route, options) =>
        options?.replace
          ? router.replace(hrefOf(route) as Route)
          : router.push(hrefOf(route) as Route),
      hrefOf,
      Link: HostLink,
      refresh: () => router.refresh(),
      online: true,
    }),
    [client, router, route],
  );
  useSyncEvents(); // live tree/page updates when another tab or device edits (3.5)
  useEffect(
    () => () => {
      void browserRecording.endSession();
    },
    [],
  );
  useEffect(() => {
    void browserRecording.sessionChanged(data.user.id);
  }, [data.user.id]);
  useEffect(
    () =>
      authClient.useSession.subscribe((session) => {
        if (!session.isPending) void browserRecording.sessionChanged(session.data?.user.id ?? null);
      }),
    [],
  );
  return (
    <WorkspaceHost value={host}>
      <ShellDataProvider value={data}>
        <WebFeatureProvider>
          <ShellSidebarProvider defaultOpen={defaultOpen}>
            <TreeActionsProvider>
              <CommandMenuProvider>
                <WebSidebar />
                <SidebarInset>
                  <TopBarProvider>
                    <BrowserRecordingBanner />
                    <div className="flex min-h-0 flex-1 flex-col">{children}</div>
                  </TopBarProvider>
                </SidebarInset>
                <CommandMenu />
              </CommandMenuProvider>
            </TreeActionsProvider>
          </ShellSidebarProvider>
        </WebFeatureProvider>
      </ShellDataProvider>
    </WorkspaceHost>
  );
}
