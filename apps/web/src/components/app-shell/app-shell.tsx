'use client';

import { SidebarInset, SidebarProvider } from '@oat/ui/components/sidebar';

import type { ShellData } from '@/lib/tree';

import { AppSidebar } from './app-sidebar';
import { CommandMenu, CommandMenuProvider } from './command-menu';
import { ShellDataProvider } from './shell-data';
import { TopBar } from './top-bar';

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
  return (
    <ShellDataProvider value={data}>
      <SidebarProvider defaultOpen={defaultOpen}>
        <CommandMenuProvider>
          <AppSidebar />
          <SidebarInset>
            <TopBar />
            <div className="flex min-h-0 flex-1 flex-col">{children}</div>
          </SidebarInset>
          <CommandMenu />
        </CommandMenuProvider>
      </SidebarProvider>
    </ShellDataProvider>
  );
}
