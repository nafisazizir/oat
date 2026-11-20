'use client';

import { SidebarInset, SidebarProvider } from '@oat/ui/components/sidebar';
import { useEffect } from 'react';
import { authClient } from '@/lib/auth-client';
import { browserRecording } from '@/lib/browser-recording';
import { BrowserRecordingBanner } from '@/components/meeting/recording-controls';

import type { ShellData } from '@/lib/tree';

import { AppSidebar } from './app-sidebar';
import { CommandMenu, CommandMenuProvider } from './command-menu';
import { ShellDataProvider } from './shell-data';
import { TopBar } from './top-bar';
import { TreeActionsProvider } from './tree-actions';
import { useSyncEvents } from './use-sync-events';

/**
 * The signed-in app frame: collapsible sidebar + top bar + content, and the ⌘K palette.
 * - `data` is loaded on the server (`getShellData()` in `(app)/layout.tsx`); the sidebar, palette and
 *   breadcrumbs read it from context instead of importing data themselves.
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
    <ShellDataProvider value={data}>
      <SidebarProvider defaultOpen={defaultOpen}>
        <TreeActionsProvider>
          <CommandMenuProvider>
            <AppSidebar />
            <SidebarInset>
              <TopBar />
              <BrowserRecordingBanner />
              <div className="flex min-h-0 flex-1 flex-col">{children}</div>
            </SidebarInset>
            <CommandMenu />
          </CommandMenuProvider>
        </TreeActionsProvider>
      </SidebarProvider>
    </ShellDataProvider>
  );
}
