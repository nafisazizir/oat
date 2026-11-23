'use client';

import { SidebarProvider, SidebarTrigger, useSidebar } from '@oat/ui/components/sidebar';
import { cn } from '@oat/ui/lib/utils';

export function ShellSidebarProvider({
  className,
  style,
  ...props
}: React.ComponentProps<typeof SidebarProvider>) {
  return (
    <SidebarProvider
      // The sidebar swaps in one frame, both ways, and the toggle never moves: closed, ShellHeader
      // shows its own on the same pixels. A slide would carry that toggle across the page.
      className={cn(
        '[&_[data-slot=sidebar-container]]:transition-none [&_[data-slot=sidebar-gap]]:transition-none',
        className,
      )}
      style={{ '--sidebar-width': '18.3125rem', ...style } as React.CSSProperties}
      {...props}
    />
  );
}

export function ShellHeader({ className, children, ...props }: React.ComponentProps<'header'>) {
  const { open, isMobile } = useSidebar();
  return (
    <header
      className={cn(
        'sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 bg-background-100 px-3',
        className,
      )}
      {...props}
    >
      {(!open || isMobile) && (
        // -ms-1: 8px in, where the sidebar's own toggle is.
        <SidebarTrigger className="-ms-1 app-no-drag" data-testid="sidebar-trigger" />
      )}
      <div className="ms-auto flex min-w-0 items-center gap-2">{children}</div>
    </header>
  );
}
